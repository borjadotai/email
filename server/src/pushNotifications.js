import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";

const APNS_DEVELOPMENT_ORIGIN = "https://api.sandbox.push.apple.com";
const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com";
const TOKEN_TTL_MS = 45 * 60 * 1000;

export class PushNotificationService {
  constructor({ store, config }) {
    this.store = store;
    this.apns = new APNsClient(config.apns ?? {});
  }

  forStore(store) {
    const service = Object.create(this);
    service.store = store;
    return service;
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

      const tokens = await this.store.listPushTokens();
      const badge = await this.store.inboxUnreadCount();
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
            await this.store.disablePushToken(token.id, error.reason ?? error.message);
          }
          console.warn(`${new Date().toISOString()} push send failed token=${token.id}: ${error.message}`);
        }
      }
    }

    return { sent, skipped };
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
  return {
    aps: {
      alert: {
        title: email.senderName || email.senderEmail || "New email",
        body: email.subject || "(No subject)"
      },
      badge,
      sound: "default",
      "thread-id": email.threadId || email.id
    },
    emailId: email.id,
    threadId: email.threadId,
    accountId: email.accountId
  };
}

function shouldNotifyForEmail(email) {
  return email?.id && email.mailboxRole === "inbox" && !email.isRead;
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
