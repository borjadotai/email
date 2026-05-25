import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { base64url, formatAddress, makeTextMessage } from "./mime.js";
import { httpError } from "./store.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.send"
];
const HISTORY_BACKFILL_LIMIT = 500;

export class ProviderService {
  constructor({ store, secretStore, config, baseURL }) {
    this.store = store;
    this.secretStore = secretStore;
    this.config = config;
    this.baseURL = baseURL;
    this.pendingGmailStates = new Map();
  }

  getAuthSettings({ baseURL } = {}) {
    return {
      gmailConfigured: Boolean(this.getGoogleClientId()),
      gmailRedirectURI: this.gmailRedirectURI(baseURL),
      icloudConfigured: true,
      icloudAuthType: "app_specific_password",
      appleMailOAuthAvailable: false
    };
  }

  async startGmailAuth(input = {}, { baseURL } = {}) {
    const clientId = this.getGoogleClientId();
    if (!clientId) {
      throw httpError(400, "Gmail sign-in is not configured for this build.");
    }

    const redirectURI = this.gmailRedirectURI(baseURL);
    const client = this.gmailOAuthClient(redirectURI);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomUUID();
    this.pendingGmailStates.set(state, {
      displayName: input.displayName?.trim() ?? "",
      syncHistory: input.syncHistory !== false,
      codeVerifier,
      redirectURI,
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
      redirectURI
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

    const client = this.gmailOAuthClient(session.redirectURI);
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

  async syncAccount(accountId, { limit = this.initialSyncLimit() } = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");
    const syncLimit = clampSyncLimit(limit, this.initialSyncLimit());

    switch (account.provider) {
      case "gmail":
        return this.syncGmailAccount(account.id, { limit: syncLimit });
      case "icloud":
        return this.syncICloudAccount(account.id, { limit: Math.min(syncLimit, 200) });
      default:
        throw httpError(400, `Unsupported provider ${account.provider}.`);
    }
  }

  async backfillAccountHistory(accountId, { limit = HISTORY_BACKFILL_LIMIT } = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");
    const backfillLimit = clampSyncLimit(limit, this.config.historyBackfillLimit ?? HISTORY_BACKFILL_LIMIT);

    switch (account.provider) {
      case "gmail":
        return this.backfillGmailHistory(account, { limit: backfillLimit });
      case "icloud":
        return this.backfillICloudHistory(account, { limit: backfillLimit });
      default:
        throw httpError(400, `Unsupported provider ${account.provider}.`);
    }
  }

  async backfillGmailHistory(account, { limit = HISTORY_BACKFILL_LIMIT } = {}) {
    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });
    const metadata = account.providerMetadata ?? {};
    const before = gmailSearchDate(metadata.gmailBackfillBefore ?? this.store.oldestEmailReceivedAt(account.id));
    const query = before ? `before:${before} -in:spam -in:trash` : "-in:spam -in:trash";
    const pageSize = Math.min(500, Math.max(1, limit));
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: pageSize,
      includeSpamTrash: false
    });

    const messages = list.data.messages ?? [];
    let imported = 0;
    let oldestReceivedAt = null;
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
        mailboxId: this.gmailMailboxFor(account.id, message.data).id,
        store: this.store,
        attachments: await gmailAttachmentsForMessage(gmail, message.data, { includeData: false })
      }));
      oldestReceivedAt = olderISODate(oldestReceivedAt, saved.receivedAt);
      imported += 1;
    }

    const complete = messages.length === 0;
    this.store.markAccountSynced(account.id, {
      gmailBackfillBefore: oldestReceivedAt ? gmailSearchDate(oldestReceivedAt) : before ?? null,
      gmailBackfillComplete: complete
    });

    return {
      provider: "gmail",
      imported,
      complete,
      cursor: oldestReceivedAt ? gmailSearchDate(oldestReceivedAt) : before ?? null
    };
  }

  async backfillICloudHistory(account, { limit = HISTORY_BACKFILL_LIMIT } = {}) {
    const password = this.secretStore.get(secretKey(account.id, "icloud.app_password"));
    if (!password) throw httpError(400, "iCloud app-specific password is missing. Reconnect the account.");

    const user = account.providerMetadata.imapUsername ?? account.email;
    const client = createICloudIMAPClient(user, password);
    const metadata = account.providerMetadata ?? {};
    const backfillState = { ...(metadata.icloudBackfill ?? {}) };
    const mailboxes = [];
    let imported = 0;

    await client.connect();
    try {
      const availableMailboxes = (await client.list()).filter(shouldBackfillICloudMailbox);
      for (const mailbox of availableMailboxes) {
        const remaining = limit - imported;
        if (remaining <= 0) break;

        const path = mailbox.path;
        const stateKey = iCloudMailboxStateKey(path);
        const previous = backfillState[stateKey] ?? {};
        if (previous.complete) {
          mailboxes.push({ path, imported: 0, complete: true, skipped: true });
          continue;
        }

        const lock = await client.getMailboxLock(path);
        try {
          const uidValidity = String(client.mailbox?.uidValidity ?? mailbox.uidValidity ?? "unknown");
          const exists = Number(client.mailbox?.exists ?? mailbox.exists ?? 0);
          const high = previous.uidValidity === uidValidity && Number.isInteger(previous.nextSeqBefore)
            ? previous.nextSeqBefore - 1
            : exists;
          if (high <= 0) {
            backfillState[stateKey] = { path, uidValidity, nextSeqBefore: 1, complete: true };
            mailboxes.push({ path, imported: 0, complete: true });
            continue;
          }

          const low = Math.max(1, high - remaining + 1);
          let mailboxImported = 0;
          for await (const message of client.fetch(`${low}:${high}`, {
            uid: true,
            flags: true,
            internalDate: true,
            source: true
          })) {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);
            this.store.upsertProviderEmail(iCloudMessageToEmail({
              account,
              parsed,
              message,
              mailboxId: this.iCloudMailboxForPath(account.id, path).id,
              store: this.store,
              providerUID: iCloudProviderUID(path, uidValidity, message.uid),
              attachments: iCloudAttachmentsFromParsed(parsed, { includeData: false })
            }));
            mailboxImported += 1;
          }

          imported += mailboxImported;
          const nextSeqBefore = low;
          const complete = low <= 1;
          backfillState[stateKey] = { path, uidValidity, nextSeqBefore, complete };
          mailboxes.push({ path, imported: mailboxImported, sequenceRange: `${low}:${high}`, complete });
        } finally {
          lock.release();
        }
      }
    } finally {
      await safeLogout(client, user);
    }

    const complete = mailboxes.length > 0 && mailboxes.every(item => item.complete || item.skipped);
    this.store.markAccountSynced(account.id, {
      icloudBackfill: backfillState,
      icloudBackfillComplete: complete
    });

    return { provider: "icloud", imported, complete, mailboxes };
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

  async markEmailSpam(email) {
    const account = this.store.getAccount(email.accountId);
    if (!account) throw httpError(404, "Account not found.");

    switch (account.provider) {
      case "gmail":
        return this.markGmailEmailSpam(account, email);
      case "icloud":
        return { status: "local_only", provider: "icloud" };
      default:
        return { status: "local_only", provider: account.provider };
    }
  }

  async updateEmailReadStatus(email, isRead) {
    const account = this.store.getAccount(email.accountId);
    if (!account) throw httpError(404, "Account not found.");

    switch (account.provider) {
      case "gmail":
        return this.updateGmailEmailReadStatus(account, email, isRead);
      case "icloud":
        return this.updateICloudEmailReadStatus(account, email, isRead);
      default:
        return { status: "local_only", provider: account.provider };
    }
  }

  async archiveEmail(email) {
    const account = this.store.getAccount(email.accountId);
    if (!account) throw httpError(404, "Account not found.");

    switch (account.provider) {
      case "gmail":
        return this.archiveGmailEmail(account, email);
      case "icloud":
        return this.archiveICloudEmail(account, email);
      default:
        return { status: "local_only", provider: account.provider };
    }
  }

  async trashEmail(email) {
    const account = this.store.getAccount(email.accountId);
    if (!account) throw httpError(404, "Account not found.");

    switch (account.provider) {
      case "gmail":
        return this.trashGmailEmail(account, email);
      case "icloud":
        return this.trashICloudEmail(account, email);
      default:
        return { status: "local_only", provider: account.provider };
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
    const newEmails = [];
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
          mailboxId: this.gmailMailboxFor(account.id, message.data).id,
          store: this.store,
          attachments: await gmailAttachmentsForMessage(gmail, message.data)
        }));
        if (saved.wasNew) {
          newEmails.push(saved);
        }
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

    return { provider: "gmail", imported, newEmailIds: newEmails.map(email => email.id), newEmails };
  }

  async syncICloudAccount(accountId, { limit = 100 } = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");
    const password = this.secretStore.get(secretKey(account.id, "icloud.app_password"));
    if (!password) throw httpError(400, "iCloud app-specific password is missing. Reconnect the account.");

    const user = account.providerMetadata.imapUsername ?? account.email;
    const client = createICloudIMAPClient(user, password);

    let imported = 0;
    const newEmails = [];
    let syncMetadata = null;
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const exists = client.mailbox?.exists ?? 0;
        const syncWindow = iCloudSyncWindow(account, client.mailbox, exists, limit);
        syncMetadata = syncWindow.metadata;

        if (exists === 0) {
          this.store.markAccountSynced(account.id, syncMetadata);
          return { provider: "icloud", imported: 0 };
        }

        if (!syncWindow.range) {
          this.store.markAccountSynced(account.id, syncWindow.metadata);
          return { provider: "icloud", imported: 0 };
        }

        let maxUID = syncWindow.lastUID;
        for await (const message of client.fetch(syncWindow.range, {
          uid: true,
          flags: true,
          internalDate: true,
          source: true
        }, syncWindow.fetchOptions)) {
          const parsed = await simpleParser(message.source);
          const mailbox = this.iCloudMailboxFor(account.id, parsed);
          const uidValidity = client.mailbox?.uidValidity ?? null;
          const saved = this.store.upsertProviderEmail(iCloudMessageToEmail({
            account,
            parsed,
            message,
            mailboxId: mailbox.id,
            store: this.store,
            providerUID: iCloudProviderUID("INBOX", uidValidity, message.uid),
            attachments: iCloudAttachmentsFromParsed(parsed)
          }));
          if (saved.wasNew) {
            newEmails.push(saved);
          }
          if (Number.isInteger(message.uid) && message.uid > maxUID) {
            maxUID = message.uid;
          }
          imported += 1;
        }
        syncWindow.metadata.icloudInboxLastUid = maxUID;
        syncMetadata = syncWindow.metadata;
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client, user);
    }

    this.store.markAccountSynced(account.id, syncMetadata);
    return { provider: "icloud", imported, newEmailIds: newEmails.map(email => email.id), newEmails };
  }

  async sendGmailMessage(account, email, input) {
    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });
    const raw = makeTextMessage({
      from: formatAddress(account.displayName, account.email),
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject || "(No subject)",
      text: input.bodyText || "",
      html: outboundHTML(input.bodyHTML, input.bodyText || "", email.trackingId, this.config.publicBaseURL),
      messageId: email.rfcMessageID,
      inReplyTo: email.inReplyTo,
      references: email.references
    });
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: base64url(raw) }
    });
    return { status: "sent", providerUID: sent.data.id ?? null };
  }

  async markGmailEmailSpam(account, email) {
    if (!email.providerUID) {
      return { status: "local_only", provider: "gmail" };
    }

    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });
    await gmail.users.messages.modify({
      userId: "me",
      id: email.providerUID,
      requestBody: {
        addLabelIds: ["SPAM"],
        removeLabelIds: ["INBOX"]
      }
    });
    return { status: "updated", provider: "gmail" };
  }

  async archiveGmailEmail(account, email) {
    if (!email.providerUID) {
      return { status: "local_only", provider: "gmail" };
    }

    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });
    await gmail.users.messages.modify({
      userId: "me",
      id: email.providerUID,
      requestBody: {
        removeLabelIds: ["INBOX"]
      }
    });
    return { status: "updated", provider: "gmail" };
  }

  async updateGmailEmailReadStatus(account, email, isRead) {
    if (!email.providerUID) {
      return { status: "local_only", provider: "gmail" };
    }

    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });
    await gmail.users.messages.modify({
      userId: "me",
      id: email.providerUID,
      requestBody: isRead
        ? { removeLabelIds: ["UNREAD"] }
        : { addLabelIds: ["UNREAD"] }
    });
    return { status: "updated", provider: "gmail" };
  }

  async trashGmailEmail(account, email) {
    if (!email.providerUID) {
      return { status: "local_only", provider: "gmail" };
    }

    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });
    await gmail.users.messages.trash({
      userId: "me",
      id: email.providerUID
    });
    return { status: "updated", provider: "gmail" };
  }

  async archiveICloudEmail(account, email) {
    const providerRef = parseICloudProviderUID(email.providerUID);
    if (!providerRef || email.mailboxRole !== "inbox") {
      return { status: "local_only", provider: "icloud" };
    }

    const password = this.secretStore.get(secretKey(account.id, "icloud.app_password"));
    if (!password) throw httpError(400, "iCloud app-specific password is missing. Reconnect the account.");

    const user = account.providerMetadata.imapUsername ?? account.email;
    const client = createICloudIMAPClient(user, password);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(providerRef.path);
      try {
        await moveICloudMessageToArchive(client, providerRef.uid);
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client, user);
    }

    return { status: "updated", provider: "icloud" };
  }

  async updateICloudEmailReadStatus(account, email, isRead) {
    const providerRef = parseICloudProviderUID(email.providerUID);
    if (!providerRef) {
      return { status: "local_only", provider: "icloud" };
    }

    const password = this.secretStore.get(secretKey(account.id, "icloud.app_password"));
    if (!password) throw httpError(400, "iCloud app-specific password is missing. Reconnect the account.");

    const user = account.providerMetadata.imapUsername ?? account.email;
    const client = createICloudIMAPClient(user, password);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(providerRef.path);
      try {
        if (isRead) {
          await client.messageFlagsAdd(String(providerRef.uid), ["\\Seen"], { uid: true });
        } else {
          await client.messageFlagsRemove(String(providerRef.uid), ["\\Seen"], { uid: true });
        }
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client, user);
    }

    return { status: "updated", provider: "icloud" };
  }

  async trashICloudEmail(account, email) {
    const providerRef = parseICloudProviderUID(email.providerUID);
    if (!providerRef) {
      return { status: "local_only", provider: "icloud" };
    }

    const password = this.secretStore.get(secretKey(account.id, "icloud.app_password"));
    if (!password) throw httpError(400, "iCloud app-specific password is missing. Reconnect the account.");

    const user = account.providerMetadata.imapUsername ?? account.email;
    const client = createICloudIMAPClient(user, password);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(providerRef.path);
      try {
        await moveICloudMessageToTrash(client, providerRef.uid);
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client, user);
    }

    return { status: "updated", provider: "icloud" };
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
      from: formatAddress(account.displayName, account.email),
      to: input.to,
      cc: input.cc || undefined,
      bcc: input.bcc || undefined,
      subject: input.subject || "(No subject)",
      text: input.bodyText || "",
      html: outboundHTML(input.bodyHTML, input.bodyText || "", email.trackingId, this.config.publicBaseURL) || undefined,
      messageId: email.rfcMessageID || undefined,
      inReplyTo: email.inReplyTo || undefined,
      references: email.references?.length ? email.references.join(" ") : undefined
    });
    return { status: "sent", providerUID: sent.messageId ?? null };
  }

  async ensureEmailAttachments(email) {
    if (!email?.hasAttachments) return [];
    const existing = this.store.attachmentsForEmail(email.id);
    if (existing.length > 0) return existing;

    const account = this.store.getAccount(email.accountId);
    if (!account) throw httpError(404, "Account not found.");

    let attachments = [];
    if (account.provider === "gmail") {
      attachments = await this.gmailAttachmentsForEmail(account, email);
    } else if (account.provider === "icloud") {
      attachments = await this.iCloudAttachmentsForEmail(account, email);
    }

    this.store.replaceEmailAttachments(email.id, attachments);
    return this.store.attachmentsForEmail(email.id);
  }

  async gmailAttachmentsForEmail(account, email) {
    if (!email.providerUID) return [];
    const client = this.authorizedGmailClient(account);
    const gmail = google.gmail({ version: "v1", auth: client });
    const message = await gmail.users.messages.get({
      userId: "me",
      id: email.providerUID,
      format: "full"
    });
    return gmailAttachmentsForMessage(gmail, message.data);
  }

  async iCloudAttachmentsForEmail(account, email) {
    const providerRef = parseICloudProviderUID(email.providerUID);
    if (!providerRef) {
      return [];
    }

    const password = this.secretStore.get(secretKey(account.id, "icloud.app_password"));
    if (!password) throw httpError(400, "iCloud app-specific password is missing. Reconnect the account.");

    const user = account.providerMetadata.imapUsername ?? account.email;
    const client = createICloudIMAPClient(user, password);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(providerRef.path);
      try {
        const message = await client.fetchOne(String(providerRef.uid), { source: true }, { uid: true });
        if (!message?.source) return [];
        const parsed = await simpleParser(message.source);
        return iCloudAttachmentsFromParsed(parsed);
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client, user);
    }
  }

  authorizedGmailClient(account) {
    const refreshToken = this.secretStore.get(secretKey(account.id, "gmail.refresh_token"));
    if (!refreshToken) throw httpError(400, "Gmail refresh token is missing. Reconnect the account.");
    const client = this.gmailOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }

  gmailOAuthClient(redirectURI = this.gmailRedirectURI()) {
    return new google.auth.OAuth2(
      this.getGoogleClientId(),
      this.getGoogleClientSecret() || undefined,
      redirectURI
    );
  }

  gmailRedirectURI(baseURL = this.baseURL) {
    return `${String(baseURL).replace(/\/+$/u, "")}/api/auth/gmail/callback`;
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

  gmailMailboxFor(accountId, message) {
    const labelIds = message.labelIds ?? [];
    if (labelIds.includes("SPAM")) return this.store.mailboxForRole(accountId, "spam");
    if (labelIds.includes("TRASH")) return this.store.mailboxForRole(accountId, "trash");
    if (labelIds.includes("DRAFT")) return this.store.mailboxForRole(accountId, "drafts");
    if (labelIds.includes("SENT") || this.store.isAccountIdentityEmail(accountId, gmailSenderEmail(message))) {
      return this.store.mailboxForRole(accountId, "sent");
    }
    if (labelIds.includes("INBOX")) return this.store.mailboxForRole(accountId, "inbox");
    return this.store.mailboxForRole(accountId, "archive");
  }

  iCloudMailboxFor(accountId, parsed) {
    const fromEmail = parsed.from?.value?.[0]?.address ?? "";
    if (this.store.isAccountIdentityEmail(accountId, fromEmail)) {
      return this.store.mailboxForRole(accountId, "sent");
    }
    return this.store.mailboxForRole(accountId, "inbox");
  }

  iCloudMailboxForPath(accountId, path) {
    const normalized = String(path ?? "").toLowerCase();
    if (normalized.includes("archive") || normalized.includes("old emails")) return this.store.mailboxForRole(accountId, "archive");
    if (normalized.includes("junk") || normalized.includes("spam")) return this.store.mailboxForRole(accountId, "spam");
    if (normalized.includes("deleted") || normalized.includes("trash")) return this.store.mailboxForRole(accountId, "trash");
    if (normalized.includes("sent")) return this.store.mailboxForRole(accountId, "sent");
    if (normalized.includes("draft")) return this.store.mailboxForRole(accountId, "drafts");
    return this.store.mailboxForRole(accountId, "inbox");
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

function iCloudSyncWindow(account, mailbox, exists, limit) {
  const uidValidity = mailbox?.uidValidity ? String(mailbox.uidValidity) : null;
  const uidNext = Number(mailbox?.uidNext ?? 0);
  const previousUidValidity = account.providerMetadata.icloudInboxUidValidity
    ? String(account.providerMetadata.icloudInboxUidValidity)
    : null;
  const previousLastUID = Number.parseInt(account.providerMetadata.icloudInboxLastUid ?? 0, 10) || 0;
  const metadata = {
    icloudInboxUidValidity: uidValidity,
    icloudInboxLastUid: previousLastUID || null
  };

  if (exists === 0) {
    metadata.icloudInboxLastUid = uidNext > 0 ? uidNext - 1 : previousLastUID || null;
    return { range: null, fetchOptions: {}, lastUID: metadata.icloudInboxLastUid ?? 0, metadata };
  }

  if (uidValidity && previousUidValidity === uidValidity && previousLastUID > 0) {
    const lastAvailableUID = uidNext > 0 ? uidNext - 1 : null;
    if (lastAvailableUID && previousLastUID >= lastAvailableUID) {
      metadata.icloudInboxLastUid = previousLastUID;
      return { range: null, fetchOptions: { uid: true }, lastUID: previousLastUID, metadata };
    }

    return {
      range: `${previousLastUID + 1}:*`,
      fetchOptions: { uid: true },
      lastUID: previousLastUID,
      metadata
    };
  }

  return {
    range: `${Math.max(1, exists - limit + 1)}:*`,
    fetchOptions: {},
    lastUID: 0,
    metadata
  };
}

function iCloudProviderUID(path, uidValidity, uid) {
  return `icloud:${encodeURIComponent(String(path))}:${String(uidValidity ?? "unknown")}:${String(uid)}`;
}

function parseICloudProviderUID(value) {
  const text = String(value ?? "");
  if (/^\d+$/u.test(text)) {
    return { path: "INBOX", uid: Number(text), uidValidity: null };
  }

  const parts = text.split(":");
  if (parts.length < 4 || parts[0] !== "icloud") return null;
  const uid = Number(parts.at(-1));
  if (!Number.isInteger(uid) || uid <= 0) return null;
  return {
    path: decodeURIComponent(parts.slice(1, -2).join(":")) || "INBOX",
    uidValidity: parts.at(-2) ?? null,
    uid
  };
}

function iCloudMailboxStateKey(path) {
  return encodeURIComponent(String(path));
}

function shouldBackfillICloudMailbox(mailbox) {
  const path = String(mailbox?.path ?? "").toLowerCase();
  if (!path) return false;
  if (path === "notes" || path.includes("/notes")) return false;
  if (path.includes("draft")) return false;
  if (path.includes("junk") || path.includes("spam")) return false;
  if (path.includes("deleted") || path.includes("trash")) return false;
  return true;
}

function gmailSearchDate(value) {
  const existing = String(value ?? "").match(/^(\d{4})\/(\d{2})\/(\d{2})$/u);
  if (existing) return existing[0];
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function olderISODate(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return new Date(candidate) < new Date(current) ? candidate : current;
}

async function moveICloudMessageToArchive(client, uid) {
  try {
    return await client.messageMove(String(uid), "Archive", { uid: true });
  } catch (error) {
    if (!isMissingMailboxError(error)) throw error;
    await client.mailboxCreate("Archive");
    return client.messageMove(String(uid), "Archive", { uid: true });
  }
}

async function moveICloudMessageToTrash(client, uid) {
  for (const destination of ["Deleted Messages", "Trash"]) {
    try {
      return await client.messageMove(String(uid), destination, { uid: true });
    } catch (error) {
      if (!isMissingMailboxError(error)) throw error;
    }
  }

  await client.mailboxCreate("Deleted Messages");
  return client.messageMove(String(uid), "Deleted Messages", { uid: true });
}

function isMissingMailboxError(error) {
  const message = error?.message?.toLowerCase() ?? "";
  const code = String(error?.code ?? "").toUpperCase();
  return code === "NONEXISTENT" || message.includes("does not exist") || message.includes("not found");
}

async function safeLogout(client, user) {
  try {
    await client.logout();
  } catch (error) {
    console.warn(`${new Date().toISOString()} iCloud IMAP logout failed user=${redactIMAPUser(user)}: ${error.message}`);
  }
}

function gmailMessageToEmail({ account, message, mailboxId, store, attachments = [] }) {
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
  const snippet = plainSnippet(message.snippet || bodyText || bodyHTML || "");
  const rfcMessageID = normalizeMessageID(headers.get("message-id"));
  const inReplyTo = normalizeMessageID(headers.get("in-reply-to"));
  const references = parseReferences(headers.get("references"));

  return {
    id: randomUUID(),
    accountId: account.id,
    mailboxId,
    providerUID: message.id,
    threadId: message.threadId ?? message.id,
    senderName: localSenderName(store, from.email, from.name),
    senderEmail: from.email || "",
    senderAvatarURL: null,
    recipients,
    cc,
    bcc,
    subject,
    snippet,
    bodyText,
    bodyHTML,
    rfcMessageID,
    inReplyTo,
    references,
    sentAt,
    receivedAt: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
    isRead: !labelIds.includes("UNREAD"),
    isStarred: labelIds.includes("STARRED"),
    importance: labelIds.includes("IMPORTANT") ? "high" : "normal",
    hasAttachments: attachments.length > 0 || gmailHasAttachments(message.payload),
    attachments,
    trackingId: null,
    openedAt: null,
    createdAt: new Date().toISOString()
  };
}

function gmailSenderEmail(message) {
  const headers = new Map((message.payload?.headers ?? []).map(header => [header.name?.toLowerCase(), header.value ?? ""]));
  return parseAddress(headers.get("from") || "").email.toLowerCase();
}

function iCloudMessageToEmail({ account, parsed, message, mailboxId, store, attachments = [], providerUID = null }) {
  const from = parsed.from?.value?.[0] ?? {};
  const references = normalizeReferences(parsed.references);
  const rfcMessageID = normalizeMessageID(parsed.messageId);
  const inReplyTo = normalizeMessageID(parsed.inReplyTo);
  return {
    id: randomUUID(),
    accountId: account.id,
    mailboxId,
    providerUID: providerUID ?? String(message.uid),
    threadId: references[0] ?? inReplyTo ?? rfcMessageID ?? String(message.uid),
    senderName: localSenderName(store, from.address, from.name),
    senderEmail: from.address || "",
    senderAvatarURL: null,
    recipients: addressValues(parsed.to),
    cc: addressValues(parsed.cc),
    bcc: addressValues(parsed.bcc),
    subject: parsed.subject || "(No subject)",
    snippet: plainSnippet(parsed.text || parsed.html || ""),
    bodyText: parsed.text || "",
    bodyHTML: typeof parsed.html === "string" ? parsed.html : null,
    rfcMessageID,
    inReplyTo,
    references,
    sentAt: (parsed.date ?? message.internalDate ?? new Date()).toISOString(),
    receivedAt: (message.internalDate ?? parsed.date ?? new Date()).toISOString(),
    isRead: message.flags?.has("\\Seen") ?? false,
    isStarred: message.flags?.has("\\Flagged") ?? false,
    importance: "normal",
    hasAttachments: attachments.length > 0 || (parsed.attachments?.length ?? 0) > 0,
    attachments,
    trackingId: null,
    openedAt: null,
    createdAt: new Date().toISOString()
  };
}

async function gmailAttachmentsForMessage(gmail, message, { includeData = true } = {}) {
  const parts = collectGmailAttachmentParts(message.payload);
  const attachments = [];

  for (const part of parts) {
    let data = includeData && part.body?.data ? decodeBase64URL(part.body.data) : null;
    if (!data && part.body?.attachmentId && message.id) {
      if (includeData) {
        const attachment = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: message.id,
          id: part.body.attachmentId
        });
        data = attachment.data?.data ? decodeBase64URL(attachment.data.data) : null;
      }
    }

    attachments.push({
      providerAttachmentId: part.body?.attachmentId ?? null,
      contentId: gmailHeader(part, "content-id"),
      filename: part.filename || "Attachment",
      mimeType: part.mimeType || "application/octet-stream",
      size: Number(part.body?.size ?? data?.length ?? 0),
      disposition: gmailHeader(part, "content-disposition"),
      isInline: isInlineAttachment(part),
      data
    });
  }

  return attachments;
}

function collectGmailAttachmentParts(part, result = []) {
  if (!part) return result;
  if (part.filename || part.body?.attachmentId) {
    result.push(part);
  }
  for (const child of part.parts ?? []) {
    collectGmailAttachmentParts(child, result);
  }
  return result;
}

function gmailHeader(part, name) {
  const header = (part.headers ?? []).find(item => item.name?.toLowerCase() === name);
  return optionalString(header?.value);
}

function isInlineAttachment(part) {
  const disposition = gmailHeader(part, "content-disposition")?.toLowerCase() ?? "";
  return disposition.includes("inline");
}

function iCloudAttachmentsFromParsed(parsed, { includeData = true } = {}) {
  return (parsed.attachments ?? []).map(attachment => ({
    contentId: optionalString(attachment.contentId),
    filename: attachment.filename || "Attachment",
    mimeType: attachment.contentType || "application/octet-stream",
    size: Number(attachment.size ?? attachment.content?.length ?? 0),
    disposition: optionalString(attachment.contentDisposition),
    isInline: attachment.related === true || attachment.contentDisposition === "inline",
    data: includeData && attachment.content ? Buffer.from(attachment.content) : null
  }));
}

function localSenderName(store, email, fallbackName = "") {
  return store?.displayNameForLocalUserEmail(email)
    || fallbackName
    || email
    || "Unknown Sender";
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

function decodeBase64URL(value) {
  return Buffer.from(String(value).replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

export function plainSnippet(value) {
  const text = htmlToPlainText(value).replace(/\s+/gu, " ").trim();
  return text.slice(0, 180);
}

function htmlToPlainText(value) {
  if (typeof value !== "string") return "";
  const html = visibleHTMLContent(value);
  return decodeHTMLEntities(
    html
      .replace(/<([a-z][\w:-]*)\b[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)[^>]*\/?>/giu, " ")
      .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<title\b[^>]*>[\s\S]*?<\/title>/giu, " ")
      .replace(/<(meta|link|base)\b[^>]*\/?>/giu, " ")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(p|div|li|h[1-6])\s*>/giu, "\n")
      .replace(/<[^>]+>/gu, " ")
      .replace(/[ \t\f\r]+/gu, " ")
      .replace(/\n\s*\n\s*\n+/gu, "\n\n")
      .trim()
  );
}

function visibleHTMLContent(value) {
  const bodyMatch = String(value).match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu);
  if (bodyMatch) return bodyMatch[1];
  return String(value).replace(/<head\b[^>]*>[\s\S]*?<\/head>/giu, " ");
}

function decodeHTMLEntities(value) {
  return value
    .replace(/&#(\d+);/gu, (_, code) => safeCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => safeCodePoint(code, 16))
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'");
}

function safeCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint)) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
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

function normalizeMessageID(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(/<[^<>]+>/u);
  return match?.[0] ?? trimmed;
}

function parseReferences(value) {
  return String(value ?? "")
    .match(/<[^<>]+>/gu)
    ?.map(normalizeMessageID)
    .filter(Boolean) ?? [];
}

function normalizeReferences(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeMessageID).filter(Boolean);
  }
  return parseReferences(value);
}

function toISODate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function outboundHTML(html, text, trackingId, publicBaseURL) {
  const sanitizedHTML = sanitizeOutboundHTML(html);
  if (sanitizedHTML) {
    return appendTrackingPixel(sanitizedHTML, trackingId, publicBaseURL);
  }
  if (!trackingId || !publicBaseURL) return null;
  const escaped = escapeHTML(text).replace(/\n/gu, "<br>");
  return appendTrackingPixel(escaped, trackingId, publicBaseURL);
}

function appendTrackingPixel(html, trackingId, publicBaseURL) {
  if (!trackingId || !publicBaseURL) return html;
  const pixel = `<img src="${publicBaseURL}/api/track/open/${trackingId}.gif" width="1" height="1" alt="">`;
  if (/<\/body\s*>/iu.test(html)) {
    return html.replace(/<\/body\s*>/iu, `${pixel}</body>`);
  }
  return `${html}${pixel}`;
}

function sanitizeOutboundHTML(value) {
  return optionalString(value)
    ?.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/giu, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/giu, "")
    .replace(/<embed\b[^>]*>/giu, "")
    ?? null;
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

function clampSyncLimit(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 1), fallback);
}
