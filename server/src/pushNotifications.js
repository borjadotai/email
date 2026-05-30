import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";

const APNS_DEVELOPMENT_ORIGIN = "https://api.sandbox.push.apple.com";
const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com";
const TOKEN_TTL_MS = 45 * 60 * 1000;
const NOTIFICATION_APP_NAME = "Email";
const NOTIFICATION_THREAD_ID = "email.inbox";

export class PushNotificationService {
  constructor({ store, config }) {
    this.store = store;
    this.apns = new APNsClient(config.apns ?? {});
  }

  get isConfigured() {
    return this.apns.isConfigured;
  }

  async sendNewEmailNotifications(emails = []) {
    if (!this.isConfigured || emails.length === 0) return { sent: 0, skipped: emails.length };

    let sent = 0;
    let skipped = 0;
    for (const email of emails) {
      if (!shouldNotifyForEmail(email)) {
        skipped += 1;
        continue;
      }

      const tokens = this.store.listPushTokens();
      const badge = this.store.inboxUnreadCount();
      for (const token of tokens) {
        const topic = topicForToken(token, this.apns.config);
        if (!topic) {
          skipped += 1;
          continue;
        }

        try {
          await this.apns.send({
            token: token.token,
            topic,
            environment: token.environment,
            payload: notificationPayload(email, badge)
          });
          sent += 1;
        } catch (error) {
          if (isPermanentAPNSError(error)) {
            this.store.disablePushToken(token.id, error.reason ?? error.message);
          }
          console.warn(`${new Date().toISOString()} push send failed token=${token.id}: ${error.message}`);
        }
      }
    }

    return { sent, skipped };
  }

  async sendTestNotification() {
    if (!this.isConfigured) return { sent: 0, skipped: 0, configured: false };

    let sent = 0;
    let skipped = 0;
    const tokens = this.store.listPushTokens();
    for (const token of tokens) {
      const topic = topicForToken(token, this.apns.config);
      if (!topic) {
        skipped += 1;
        continue;
      }

      try {
        await this.apns.send({
          token: token.token,
          topic,
          environment: token.environment,
          payload: testNotificationPayload()
        });
        sent += 1;
      } catch (error) {
        if (isPermanentAPNSError(error)) {
          this.store.disablePushToken(token.id, error.reason ?? error.message);
        }
        console.warn(`${new Date().toISOString()} test push failed token=${token.id}: ${error.message}`);
      }
    }

    return { sent, skipped, configured: true };
  }
}

class APNsClient {
  constructor(config = {}) {
    this.config = config;
    this.cachedJWT = null;
    this.cachedJWTAt = 0;
    this.privateKey = null;
  }

  get isConfigured() {
    return Boolean(this.config.keyId && this.config.teamId && (this.config.privateKey || this.config.privateKeyPath));
  }

  async send({ token, topic, environment, payload }) {
    if (!this.isConfigured) {
      throw new Error("APNs is not configured.");
    }

    const origin = environment === "production" ? APNS_PRODUCTION_ORIGIN : APNS_DEVELOPMENT_ORIGIN;
    const client = connect(origin);

    try {
      await onceConnect(client);
      const body = JSON.stringify(payload);
      const response = await request(client, {
        ":method": "POST",
        ":path": `/3/device/${token}`,
        "authorization": `bearer ${this.jwt()}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }, body);

      if (response.status < 200 || response.status >= 300) {
        const reason = response.body ? JSON.parse(response.body).reason : `HTTP ${response.status}`;
        const error = new Error(`APNs rejected notification: ${reason}`);
        error.status = response.status;
        error.reason = reason;
        throw error;
      }

      return response;
    } finally {
      client.close();
    }
  }

  jwt() {
    const now = Date.now();
    if (this.cachedJWT && now - this.cachedJWTAt < TOKEN_TTL_MS) {
      return this.cachedJWT;
    }

    const issuedAt = Math.floor(now / 1000);
    const header = base64urlJSON({ alg: "ES256", kid: this.config.keyId });
    const claims = base64urlJSON({ iss: this.config.teamId, iat: issuedAt });
    const signingInput = `${header}.${claims}`;
    const signer = createSign("SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign({ key: this.privateSigningKey(), dsaEncoding: "ieee-p1363" });

    this.cachedJWT = `${signingInput}.${base64url(signature)}`;
    this.cachedJWTAt = now;
    return this.cachedJWT;
  }

  privateSigningKey() {
    if (this.privateKey) return this.privateKey;

    const key = this.config.privateKey
      ? this.config.privateKey.replaceAll("\\n", "\n")
      : readFileSync(this.config.privateKeyPath, "utf8");
    this.privateKey = createPrivateKey(key);
    return this.privateKey;
  }
}

function notificationPayload(email, badge) {
  const sender = notificationSender(email);
  const subject = notificationSubject(email);
  const preview = notificationPreview(email);

  return {
    aps: {
      alert: {
        title: NOTIFICATION_APP_NAME,
        subtitle: sender,
        body: subject
      },
      badge,
      sound: "default",
      "mutable-content": 1,
      "thread-id": NOTIFICATION_THREAD_ID
    },
    emailId: email.id,
    threadId: email.threadId,
    accountId: email.accountId,
    senderName: sender,
    senderEmail: email.senderEmail,
    senderAvatarURL: email.senderAvatarURL,
    appName: NOTIFICATION_APP_NAME,
    subject,
    snippet: preview
  };
}

function testNotificationPayload() {
  return {
    aps: {
      alert: {
        title: NOTIFICATION_APP_NAME,
        subtitle: "Apple Developer",
        body: "Notification formatting"
      },
      "mutable-content": 1,
      "thread-id": NOTIFICATION_THREAD_ID,
      sound: "default"
    },
    kind: "pushTest",
    senderName: "Apple Developer",
    senderEmail: "news@developer.apple.com",
    senderAvatarURL: "https://www.google.com/s2/favicons?domain=apple.com&sz=128",
    appName: NOTIFICATION_APP_NAME,
    subject: "Notification formatting",
    snippet: "APNs is configured correctly and sender icons are enabled."
  };
}

function shouldNotifyForEmail(email) {
  return email?.id && email.mailboxRole === "inbox" && !email.isRead;
}

function notificationSender(email) {
  return nonEmptyString(email.senderName) || nonEmptyString(email.senderEmail) || "New email";
}

function notificationSubject(email) {
  return nonEmptyString(email.subject) || "(No subject)";
}

function notificationPreview(email) {
  return firstLine(email.snippet) || firstLine(email.bodyText) || "Open Email to read this message.";
}

function firstLine(value) {
  const normalized = nonEmptyString(value);
  if (!normalized) return "";

  const line = normalized
    .split(/\r?\n/u)
    .map(part => part.replace(/\s+/gu, " ").trim())
    .find(Boolean);
  return line ? line.slice(0, 180) : "";
}

function nonEmptyString(value) {
  const string = typeof value === "string" ? value.trim() : "";
  return string || null;
}

function topicForToken(token, config) {
  if (token.bundleId) return token.bundleId;
  if (token.platform === "ios") return config.iosTopic;
  if (token.platform === "macos") return config.macosTopic;
  return null;
}

function isPermanentAPNSError(error) {
  return error.reason === "BadDeviceToken" ||
    error.reason === "DeviceTokenNotForTopic" ||
    error.reason === "Unregistered";
}

function request(client, headers, body) {
  return new Promise((resolve, reject) => {
    const req = client.request(headers);
    const chunks = [];
    let status = 0;

    req.setEncoding("utf8");
    req.on("response", headers => {
      status = Number(headers[":status"] ?? 0);
    });
    req.on("data", chunk => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve({ status, body: chunks.join("") });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function onceConnect(client) {
  return new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
}

function base64urlJSON(value) {
  return base64url(Buffer.from(JSON.stringify(value)));
}

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
