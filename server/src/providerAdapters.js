import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { base64url, makeTextMessage } from "./mime.js";
import { httpError } from "./store.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.send"
];

export class ProviderService {
  constructor({ store, secretStore, config, baseURL }) {
    this.store = store;
    this.secretStore = secretStore;
    this.config = config;
    this.baseURL = baseURL;
    this.pendingGmailStates = new Map();
  }

  getAuthSettings() {
    return {
      gmailConfigured: Boolean(this.getGoogleClientId()),
      gmailRedirectURI: this.gmailRedirectURI(),
      icloudConfigured: true,
      icloudAuthType: "app_specific_password",
      appleMailOAuthAvailable: false
    };
  }

  async startGmailAuth(input = {}) {
    const clientId = this.getGoogleClientId();
    if (!clientId) {
      throw httpError(400, "Gmail sign-in is not configured for this build.");
    }

    const client = this.gmailOAuthClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomUUID();
    this.pendingGmailStates.set(state, {
      displayName: input.displayName?.trim() ?? "",
      syncHistory: input.syncHistory !== false,
      codeVerifier,
      createdAt: Date.now()
    });

    const authorizationURL = client.generateAuthUrl({
      access_type: "offline",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      include_granted_scopes: true,
      prompt: "consent",
      scope: GMAIL_SCOPES,
      state
    });

    return {
      provider: "gmail",
      authorizationURL,
      state,
      redirectURI: this.gmailRedirectURI()
    };
  }

  async completeGmailAuth(query) {
    const state = requiredString(query.state, "state");
    const code = requiredString(query.code, "code");
    const session = this.pendingGmailStates.get(state);
    if (!session) {
      throw httpError(400, "Gmail auth session expired. Start the connection again.");
    }
    this.pendingGmailStates.delete(state);

    const client = this.gmailOAuthClient();
    const { tokens } = await client.getToken({ code, codeVerifier: session.codeVerifier });
    client.setCredentials(tokens);

    const gmail = google.gmail({ version: "v1", auth: client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress;
    if (!email) throw httpError(502, "Google did not return a Gmail address.");

    const account = this.store.createOrUpdateAccount({
      provider: "gmail",
      email,
      displayName: session.displayName || email,
      authType: "gmail_oauth",
      status: "connected",
      syncHistory: session.syncHistory,
      providerMetadata: {
        gmailHistoryId: profile.data.historyId ?? null,
        gmailMessagesTotal: profile.data.messagesTotal ?? null,
        gmailThreadsTotal: profile.data.threadsTotal ?? null,
        gmailScopes: tokens.scope ?? GMAIL_SCOPES.join(" ")
      }
    });

    if (tokens.refresh_token) {
      this.secretStore.set(secretKey(account.id, "gmail.refresh_token"), tokens.refresh_token);
    }

    if (!this.secretStore.get(secretKey(account.id, "gmail.refresh_token"))) {
      throw httpError(400, "Google did not return an offline token. Remove this app from your Google Account access list and try signing in again.");
    }

    this.store.claimUserIdentity({
      provider: "gmail",
      email,
      displayName: session.displayName || email,
      accountId: account.id
    });

    return {
      account: this.store.getAccount(account.id),
      sync: {
        provider: "gmail",
        imported: 0,
        status: "queued"
      },
      syncLimit: session.syncHistory ? this.initialSyncLimit() : 50
    };
  }

  async connectICloud(input) {
    const email = requiredString(input.email, "email").toLowerCase();
    const password = requiredString(input.appPassword, "appPassword");
    const username = optionalString(input.username)?.toLowerCase();
    const syncHistory = input.syncHistory !== false;
    const displayName = input.displayName?.trim() || email;
    console.log(`${new Date().toISOString()} iCloud verifying IMAP email=${redactEmail(email)}`);
    const imapAuth = await verifyICloudIMAP(email, password, username);
    console.log(`${new Date().toISOString()} iCloud verifying SMTP email=${redactEmail(email)}`);
    await verifyICloudSMTP(imapAuth.user, password);

    const account = this.store.createOrUpdateAccount({
      provider: "icloud",
      email,
      displayName,
      authType: "icloud_app_password",
      status: "connected",
      syncHistory,
      providerMetadata: {
        imapHost: "imap.mail.me.com",
        imapPort: 993,
        imapUsername: imapAuth.user,
        smtpHost: "smtp.mail.me.com",
        smtpPort: 587,
        smtpUsername: imapAuth.user
      }
    });
    this.secretStore.set(secretKey(account.id, "icloud.app_password"), password);
    this.store.linkAccountToLocalUser(account.id, "icloud", email);

    console.log(`${new Date().toISOString()} iCloud syncing INBOX email=${redactEmail(email)}`);
    const sync = await this.syncICloudAccount(account.id, {
      limit: syncHistory ? Math.min(this.initialSyncLimit(), 200) : 50
    });
    return { account: this.store.getAccount(account.id), sync };
  }

  async syncAccount(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");

    switch (account.provider) {
      case "gmail":
        return this.syncGmailAccount(account.id, { limit: this.initialSyncLimit() });
      case "icloud":
        return this.syncICloudAccount(account.id, { limit: Math.min(this.initialSyncLimit(), 200) });
      default:
        throw httpError(400, `Unsupported provider ${account.provider}.`);
    }
  }

  async sendMessage(email, input) {
    const account = this.store.getAccount(email.accountId);
    if (!account) throw httpError(404, "Account not found.");

    switch (account.provider) {
      case "gmail":
        return this.sendGmailMessage(account, email, input);
      case "icloud":
        return this.sendICloudMessage(account, email, input);
      default:
        return { status: "queued" };
    }
  }

  async syncGmailAccount(accountId, { limit = 100 } = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");
    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });

    const labels = await gmail.users.labels.list({ userId: "me" });
    const userLabels = new Map();
    for (const label of labels.data.labels ?? []) {
      if (label.type === "user" && label.name && label.id) {
        const localLabel = this.store.findOrCreateLabel({
          accountId: account.id,
          name: label.name,
          color: "blue"
        });
        userLabels.set(label.id, localLabel.id);
      }
    }

    let imported = 0;
    let pageToken = undefined;
    do {
      const pageSize = Math.min(500, Math.max(1, limit - imported));
      const list = await gmail.users.messages.list({
        userId: "me",
        maxResults: pageSize,
        pageToken,
        includeSpamTrash: false
      });
      const messages = list.data.messages ?? [];
      for (const item of messages) {
        if (!item.id) continue;
        const message = await gmail.users.messages.get({
          userId: "me",
          id: item.id,
          format: "full"
        });
        const saved = this.store.upsertProviderEmail(gmailMessageToEmail({
          account,
          message: message.data,
          mailboxId: this.gmailMailboxFor(account.id, message.data.labelIds ?? []).id
        }));
        for (const labelId of message.data.labelIds ?? []) {
          const localLabelId = userLabels.get(labelId);
          if (localLabelId) {
            this.store.setEmailLabel(saved.id, localLabelId, "add");
          }
        }
        imported += 1;
        if (imported >= limit) break;
      }
      pageToken = list.data.nextPageToken;
    } while (pageToken && imported < limit);

    const profile = await gmail.users.getProfile({ userId: "me" });
    this.store.markAccountSynced(account.id, {
      gmailHistoryId: profile.data.historyId ?? account.providerMetadata.gmailHistoryId ?? null,
      gmailMessagesTotal: profile.data.messagesTotal ?? null,
      gmailThreadsTotal: profile.data.threadsTotal ?? null
    });

    return { provider: "gmail", imported };
  }

  async syncICloudAccount(accountId, { limit = 100 } = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");
    const password = this.secretStore.get(secretKey(account.id, "icloud.app_password"));
    if (!password) throw httpError(400, "iCloud app-specific password is missing. Reconnect the account.");

    const user = account.providerMetadata.imapUsername ?? account.email;
    const client = createICloudIMAPClient(user, password);

    let imported = 0;
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const exists = client.mailbox?.exists ?? 0;
        if (exists === 0) {
          this.store.markAccountSynced(account.id);
          return { provider: "icloud", imported: 0 };
        }
        const start = Math.max(1, exists - limit + 1);
        const range = `${start}:*`;
        const inbox = this.store.mailboxForRole(account.id, "inbox");

        for await (const message of client.fetch(range, {
          uid: true,
          flags: true,
          internalDate: true,
          source: true
        })) {
          const parsed = await simpleParser(message.source);
          this.store.upsertProviderEmail(iCloudMessageToEmail({
            account,
            parsed,
            message,
            mailboxId: inbox.id
          }));
          imported += 1;
        }
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client, user);
    }

    this.store.markAccountSynced(account.id);
    return { provider: "icloud", imported };
  }

  async sendGmailMessage(account, email, input) {
    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });
    const raw = makeTextMessage({
      from: account.email,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject || "(No subject)",
      text: input.bodyText || "",
      html: trackingHTML(input.bodyText || "", email.trackingId, this.config.publicBaseURL)
    });
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: base64url(raw) }
    });
    return { status: "sent", providerUID: sent.data.id ?? null };
  }

  async sendICloudMessage(account, email, input) {
    const password = this.secretStore.get(secretKey(account.id, "icloud.app_password"));
    if (!password) throw httpError(400, "iCloud app-specific password is missing. Reconnect the account.");

    const transporter = nodemailer.createTransport({
      host: "smtp.mail.me.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: account.providerMetadata.smtpUsername ?? account.email, pass: password }
    });
    const sent = await transporter.sendMail({
      from: account.email,
      to: input.to,
      cc: input.cc || undefined,
      bcc: input.bcc || undefined,
      subject: input.subject || "(No subject)",
      text: input.bodyText || "",
      html: trackingHTML(input.bodyText || "", email.trackingId, this.config.publicBaseURL) || undefined
    });
    return { status: "sent", providerUID: sent.messageId ?? null };
  }

  authorizedGmailClient(account) {
    const refreshToken = this.secretStore.get(secretKey(account.id, "gmail.refresh_token"));
    if (!refreshToken) throw httpError(400, "Gmail refresh token is missing. Reconnect the account.");
    const client = this.gmailOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }

  gmailOAuthClient() {
    return new google.auth.OAuth2(
      this.getGoogleClientId(),
      this.getGoogleClientSecret() || undefined,
      this.gmailRedirectURI()
    );
  }

  gmailRedirectURI() {
    return `${this.baseURL}/api/auth/gmail/callback`;
  }

  getGoogleClientId() {
    return this.config.googleOAuthClientId ?? "";
  }

  getGoogleClientSecret() {
    return this.config.googleOAuthClientSecret ?? "";
  }

  initialSyncLimit() {
    return Number.isFinite(this.config.initialSyncLimit) ? this.config.initialSyncLimit : 500;
  }

  gmailMailboxFor(accountId, labelIds) {
    if (labelIds.includes("SENT")) return this.store.mailboxForRole(accountId, "sent");
    if (labelIds.includes("DRAFT")) return this.store.mailboxForRole(accountId, "drafts");
    if (labelIds.includes("TRASH")) return this.store.mailboxForRole(accountId, "trash");
    if (labelIds.includes("INBOX")) return this.store.mailboxForRole(accountId, "inbox");
    return this.store.mailboxForRole(accountId, "archive");
  }
}

async function verifyICloudIMAP(email, password, username = null) {
  const candidates = [username, email].filter(Boolean);
  if (email.endsWith("@icloud.com") || email.endsWith("@me.com") || email.endsWith("@mac.com")) {
    candidates.push(email.split("@")[0]);
  }

  let lastError;
  for (const user of [...new Set(candidates)]) {
    const client = createICloudIMAPClient(user, password);
    try {
      await client.connect();
      await safeLogout(client, user);
      return { user };
    } catch (error) {
      lastError = error;
    }
  }
  throw httpError(401, `iCloud IMAP login failed. Check the app-specific password and, for custom domains, use your Apple ID or primary iCloud email as the username. ${lastError?.message ?? "Invalid credentials."}`);
}

async function verifyICloudSMTP(username, password) {
  const transporter = nodemailer.createTransport({
    host: "smtp.mail.me.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: username, pass: password }
  });
  try {
    await transporter.verify();
  } catch (error) {
    throw httpError(401, `iCloud SMTP login failed: ${error.message}`);
  }
}

function createICloudIMAPClient(user, password) {
  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user, pass: password },
    logger: false
  });
  client.on("error", error => {
    console.warn(`${new Date().toISOString()} iCloud IMAP socket error user=${redactIMAPUser(user)}: ${error.message}`);
  });
  return client;
}

async function safeLogout(client, user) {
  try {
    await client.logout();
  } catch (error) {
    console.warn(`${new Date().toISOString()} iCloud IMAP logout failed user=${redactIMAPUser(user)}: ${error.message}`);
  }
}

function gmailMessageToEmail({ account, message, mailboxId }) {
  const headers = new Map((message.payload?.headers ?? []).map(header => [header.name?.toLowerCase(), header.value ?? ""]));
  const from = parseAddress(headers.get("from") || "");
  const recipients = parseAddressList(headers.get("to") || "");
  const cc = parseAddressList(headers.get("cc") || "");
  const bcc = parseAddressList(headers.get("bcc") || "");
  const subject = headers.get("subject") || "(No subject)";
  const sentAt = toISODate(headers.get("date")) ?? new Date(Number(message.internalDate ?? Date.now())).toISOString();
  const labelIds = message.labelIds ?? [];
  const bodyText = decodeGmailPart(message.payload, "text/plain") || message.snippet || "";
  const bodyHTML = decodeGmailPart(message.payload, "text/html") || null;

  return {
    id: randomUUID(),
    accountId: account.id,
    mailboxId,
    providerUID: message.id,
    threadId: message.threadId ?? message.id,
    senderName: from.name || from.email || "Unknown Sender",
    senderEmail: from.email || "",
    senderAvatarURL: null,
    recipients,
    cc,
    bcc,
    subject,
    snippet: message.snippet || bodyText.replace(/\s+/g, " ").slice(0, 180),
    bodyText,
    bodyHTML,
    sentAt,
    receivedAt: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
    isRead: !labelIds.includes("UNREAD"),
    isStarred: labelIds.includes("STARRED"),
    importance: labelIds.includes("IMPORTANT") ? "high" : "normal",
    hasAttachments: gmailHasAttachments(message.payload),
    trackingId: null,
    openedAt: null,
    createdAt: new Date().toISOString()
  };
}

function iCloudMessageToEmail({ account, parsed, message, mailboxId }) {
  const from = parsed.from?.value?.[0] ?? {};
  return {
    id: randomUUID(),
    accountId: account.id,
    mailboxId,
    providerUID: String(message.uid),
    threadId: parsed.messageId ?? String(message.uid),
    senderName: from.name || from.address || "Unknown Sender",
    senderEmail: from.address || "",
    senderAvatarURL: null,
    recipients: addressValues(parsed.to),
    cc: addressValues(parsed.cc),
    bcc: addressValues(parsed.bcc),
    subject: parsed.subject || "(No subject)",
    snippet: (parsed.text || parsed.html || "").replace(/\s+/g, " ").slice(0, 180),
    bodyText: parsed.text || "",
    bodyHTML: typeof parsed.html === "string" ? parsed.html : null,
    sentAt: (parsed.date ?? message.internalDate ?? new Date()).toISOString(),
    receivedAt: (message.internalDate ?? parsed.date ?? new Date()).toISOString(),
    isRead: message.flags?.has("\\Seen") ?? false,
    isStarred: message.flags?.has("\\Flagged") ?? false,
    importance: "normal",
    hasAttachments: (parsed.attachments?.length ?? 0) > 0,
    trackingId: null,
    openedAt: null,
    createdAt: new Date().toISOString()
  };
}

function decodeGmailPart(part, mimeType) {
  if (!part) return "";
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const decoded = decodeGmailPart(child, mimeType);
    if (decoded) return decoded;
  }
  return "";
}

function gmailHasAttachments(part) {
  if (!part) return false;
  if (part.filename) return true;
  return (part.parts ?? []).some(gmailHasAttachments);
}

function parseAddress(value) {
  const match = String(value).match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/u);
  if (match) {
    return { name: match[1]?.trim() ?? "", email: match[2].trim() };
  }
  return { name: "", email: String(value).trim() };
}

function parseAddressList(value) {
  return String(value)
    .split(",")
    .map(item => parseAddress(item).email)
    .filter(Boolean);
}

function addressValues(addressObject) {
  return addressObject?.value?.map(item => item.address).filter(Boolean) ?? [];
}

function toISODate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function trackingHTML(text, trackingId, publicBaseURL) {
  if (!trackingId || !publicBaseURL) return null;
  const escaped = escapeHTML(text).replace(/\n/gu, "<br>");
  return `${escaped}<img src="${publicBaseURL}/api/track/open/${trackingId}.gif" width="1" height="1" alt="">`;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function secretKey(accountId, name) {
  return `account:${accountId}:${name}`;
}

function redactEmail(value) {
  if (typeof value !== "string" || !value.includes("@")) return "unknown";
  const [local, domain] = value.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

function redactIMAPUser(value) {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  if (value.includes("@")) return redactEmail(value);
  return `${value.trim().slice(0, 2)}***`;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(400, `${name} is required.`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
