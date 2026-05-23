import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const SYSTEM_MAILBOXES = [
  ["Inbox", "inbox"],
  ["Sent", "sent"],
  ["Drafts", "drafts"],
  ["Archive", "archive"],
  ["Trash", "trash"]
];

const SYSTEM_LABELS = [
  ["Important", "orange"],
  ["Receipts", "green"],
  ["Action", "blue"],
  ["Later", "purple"]
];

export class MailStore {
  constructor({ databasePath = ":memory:", seedDemo = false } = {}) {
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.migrate();
    if (seedDemo) {
      this.seedDemoData();
    }
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('gmail', 'icloud')),
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        auth_type TEXT NOT NULL DEFAULT 'not_configured',
        status TEXT NOT NULL DEFAULT 'needs_auth',
        sync_history INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT,
        provider_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        primary_email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_user_links (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_email TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        UNIQUE(user_id, provider, provider_email)
      );

      CREATE TABLE IF NOT EXISTS mailboxes (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(account_id, role)
      );

      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'gray',
        is_system INTEGER NOT NULL DEFAULT 0,
        UNIQUE(account_id, name)
      );

      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        provider_uid TEXT,
        thread_id TEXT,
        sender_name TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        sender_avatar_url TEXT,
        recipients_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        bcc_json TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL,
        snippet TEXT NOT NULL,
        body_text TEXT NOT NULL,
        body_html TEXT,
        sent_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_starred INTEGER NOT NULL DEFAULT 0,
        importance TEXT NOT NULL DEFAULT 'normal',
        has_attachments INTEGER NOT NULL DEFAULT 0,
        tracking_id TEXT UNIQUE,
        opened_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_labels (
        email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY(email_id, label_id)
      );

      CREATE TABLE IF NOT EXISTS outbound_messages (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );

      CREATE TABLE IF NOT EXISTS open_events (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
        tracking_id TEXT NOT NULL,
        user_agent TEXT,
        remote_addr TEXT,
        opened_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS email_fts USING fts5(
        email_id UNINDEXED,
        account_id UNINDEXED,
        subject,
        sender_name,
        sender_email,
        recipients,
        snippet,
        body_text,
        tokenize='porter unicode61'
      );

      CREATE INDEX IF NOT EXISTS idx_emails_account_received ON emails(account_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_emails_mailbox_received ON emails(mailbox_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_emails_tracking ON emails(tracking_id);
      CREATE INDEX IF NOT EXISTS idx_email_labels_label ON email_labels(label_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_account_provider_uid
        ON emails(account_id, provider_uid)
        WHERE provider_uid IS NOT NULL;
    `);
    this.ensureColumn("accounts", "provider_metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureLocalUser();
    this.linkUnownedAccountsToLocalUser();
    this.hydrateLocalUserFromAccounts();
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(item => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row?.value ?? fallback;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), new Date().toISOString());
  }

  createAccount(input) {
    const provider = normalizeProvider(input.provider);
    const email = requiredString(input.email, "email").toLowerCase();
    const displayName = input.displayName?.trim() || email;
    const id = randomUUID();
    const now = new Date().toISOString();

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO accounts (id, provider, email, display_name, avatar_url, auth_type, status, sync_history, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        provider,
        email,
        displayName,
        input.avatarURL ?? null,
        input.authType ?? "not_configured",
        input.status ?? "connected",
        input.syncHistory === false ? 0 : 1,
        now
      );
      this.ensureDefaultsForAccount(id);
      this.linkAccountToLocalUser(id, provider, email);
    });

    return this.getAccount(id);
  }

  createOrUpdateAccount(input) {
    const provider = normalizeProvider(input.provider);
    const email = requiredString(input.email, "email").toLowerCase();
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id FROM accounts WHERE email = ?").get(email);

    if (existing) {
      this.db.prepare(`
        UPDATE accounts
        SET provider = ?, display_name = ?, avatar_url = ?, auth_type = ?,
            status = ?, sync_history = ?, last_sync_at = COALESCE(?, last_sync_at),
            provider_metadata_json = ?
        WHERE id = ?
      `).run(
        provider,
        input.displayName?.trim() || email,
        input.avatarURL ?? null,
        input.authType ?? "not_configured",
        input.status ?? "connected",
        input.syncHistory === false ? 0 : 1,
        input.lastSyncAt ?? null,
        JSON.stringify(input.providerMetadata ?? {}),
        existing.id
      );
      this.ensureDefaultsForAccount(existing.id);
      this.linkAccountToLocalUser(existing.id, provider, email);
      return this.getAccount(existing.id);
    }

    const account = this.createAccount(input);
    if (input.providerMetadata) {
      this.updateAccountMetadata(account.id, input.providerMetadata);
    }
    return this.getAccount(account.id);
  }

  listAccounts() {
    return this.db.prepare(`
      SELECT id, provider, email, display_name AS displayName, avatar_url AS avatarURL,
             auth_type AS authType, status, sync_history AS syncHistory,
             last_sync_at AS lastSyncAt, provider_metadata_json AS providerMetadataJSON,
             created_at AS createdAt
      FROM accounts
      ORDER BY created_at ASC
    `).all().map(row => ({
      ...row,
      syncHistory: Boolean(row.syncHistory),
      providerMetadata: parseJSON(row.providerMetadataJSON, {})
    }));
  }

  getProfile() {
    const user = this.ensureLocalUser();
    return {
      ...user,
      accounts: this.listAccounts()
    };
  }

  claimUserIdentity(input) {
    const provider = normalizeProvider(input.provider);
    const email = requiredString(input.email, "email").toLowerCase();
    const displayName = input.displayName?.trim() || email;
    const user = this.ensureLocalUser();
    const primaryEmail = user.primaryEmail || email;

    this.db.prepare(`
      UPDATE app_users
      SET display_name = ?, primary_email = ?, updated_at = ?
      WHERE id = ?
    `).run(displayName, primaryEmail, new Date().toISOString(), user.id);

    if (input.accountId) {
      this.linkAccountToLocalUser(input.accountId, provider, email);
    }

    return this.getProfile();
  }

  getAccount(id) {
    const row = this.db.prepare(`
      SELECT id, provider, email, display_name AS displayName, avatar_url AS avatarURL,
             auth_type AS authType, status, sync_history AS syncHistory,
             last_sync_at AS lastSyncAt, provider_metadata_json AS providerMetadataJSON,
             created_at AS createdAt
      FROM accounts
      WHERE id = ?
    `).get(id);
    if (!row) return null;
    return { ...row, syncHistory: Boolean(row.syncHistory), providerMetadata: parseJSON(row.providerMetadataJSON, {}) };
  }

  ensureLocalUser() {
    const existing = this.db.prepare(`
      SELECT id, display_name AS displayName, primary_email AS primaryEmail,
             created_at AS createdAt, updated_at AS updatedAt
      FROM app_users
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    if (existing) return existing;

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_users (id, display_name, primary_email, created_at, updated_at)
      VALUES (?, 'Local Profile', NULL, ?, ?)
    `).run(id, now, now);
    return this.ensureLocalUser();
  }

  linkUnownedAccountsToLocalUser() {
    const user = this.ensureLocalUser();
    const accounts = this.db.prepare(`
      SELECT a.id, a.provider, a.email
      FROM accounts a
      LEFT JOIN account_user_links l ON l.account_id = a.id
      WHERE l.account_id IS NULL
    `).all();
    for (const account of accounts) {
      this.linkAccountToUser(user.id, account.id, account.provider, account.email);
    }
  }

  hydrateLocalUserFromAccounts() {
    const user = this.ensureLocalUser();
    if (user.primaryEmail) return;

    const account = this.db.prepare(`
      SELECT email, display_name AS displayName
      FROM accounts
      ORDER BY CASE provider WHEN 'gmail' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1
    `).get();
    if (!account) return;

    this.db.prepare(`
      UPDATE app_users
      SET display_name = ?, primary_email = ?, updated_at = ?
      WHERE id = ?
    `).run(account.displayName || account.email, account.email, new Date().toISOString(), user.id);
  }

  linkAccountToLocalUser(accountId, provider, email) {
    const user = this.ensureLocalUser();
    this.linkAccountToUser(user.id, accountId, provider, email);
  }

  linkAccountToUser(userId, accountId, provider, email) {
    this.db.prepare(`
      INSERT INTO account_user_links (account_id, user_id, provider, provider_email, linked_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        user_id = excluded.user_id,
        provider = excluded.provider,
        provider_email = excluded.provider_email
    `).run(accountId, userId, provider, email, new Date().toISOString());
  }

  updateAccountStatus(id, status, metadata = null) {
    const account = this.getAccount(id);
    if (!account) return null;
    const nextMetadata = metadata ? { ...account.providerMetadata, ...metadata } : account.providerMetadata;
    this.db.prepare(`
      UPDATE accounts
      SET status = ?, provider_metadata_json = ?
      WHERE id = ?
    `).run(status, JSON.stringify(nextMetadata), id);
    return this.getAccount(id);
  }

  markAccountSynced(id, metadata = null) {
    const account = this.getAccount(id);
    if (!account) return null;
    const nextMetadata = metadata ? { ...account.providerMetadata, ...metadata } : account.providerMetadata;
    this.db.prepare(`
      UPDATE accounts
      SET status = 'connected', last_sync_at = ?, provider_metadata_json = ?
      WHERE id = ?
    `).run(new Date().toISOString(), JSON.stringify(nextMetadata), id);
    return this.getAccount(id);
  }

  updateAccountMetadata(id, metadata) {
    const account = this.getAccount(id);
    if (!account) return null;
    const nextMetadata = { ...account.providerMetadata, ...metadata };
    this.db.prepare("UPDATE accounts SET provider_metadata_json = ? WHERE id = ?").run(JSON.stringify(nextMetadata), id);
    return this.getAccount(id);
  }

  listMailboxes(accountId = null) {
    const args = [];
    let where = "";
    if (accountId) {
      where = "WHERE m.account_id = ?";
      args.push(accountId);
    }

    return this.db.prepare(`
      SELECT m.id, m.account_id AS accountId, a.email AS accountEmail,
             m.name, m.role, m.unread_count AS unreadCount
      FROM mailboxes m
      JOIN accounts a ON a.id = m.account_id
      ${where}
      ORDER BY a.created_at ASC,
        CASE m.role
          WHEN 'inbox' THEN 0
          WHEN 'sent' THEN 1
          WHEN 'drafts' THEN 2
          WHEN 'archive' THEN 3
          WHEN 'trash' THEN 4
          ELSE 9
        END
    `).all(...args);
  }

  listLabels(accountId = null) {
    const args = [];
    let where = "";
    if (accountId) {
      where = "WHERE l.account_id IS NULL OR l.account_id = ?";
      args.push(accountId);
    }

    return this.db.prepare(`
      SELECT l.id, l.account_id AS accountId, a.email AS accountEmail,
             l.name, l.color, l.is_system AS isSystem
      FROM labels l
      LEFT JOIN accounts a ON a.id = l.account_id
      ${where}
      ORDER BY l.is_system DESC, l.name ASC
    `).all(...args).map(row => ({ ...row, isSystem: Boolean(row.isSystem) }));
  }

  createLabel(input) {
    const name = requiredString(input.name, "name");
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO labels (id, account_id, name, color, is_system)
      VALUES (?, ?, ?, ?, 0)
    `).run(id, input.accountId ?? null, name, input.color ?? "gray");
    return this.listLabels(input.accountId ?? null).find(label => label.id === id);
  }

  findOrCreateLabel(input) {
    const name = requiredString(input.name, "name");
    const accountId = input.accountId ?? null;
    const existing = this.db.prepare(`
      SELECT id FROM labels
      WHERE name = ? AND ${accountId ? "account_id = ?" : "account_id IS NULL"}
    `).get(...(accountId ? [name, accountId] : [name]));
    if (existing) {
      return this.listLabels(accountId).find(label => label.id === existing.id);
    }
    return this.createLabel({
      accountId,
      name,
      color: input.color ?? "gray"
    });
  }

  listEmails(filters = {}) {
    const limit = clampInt(filters.limit, 1, 200, 80);
    const offset = clampInt(filters.offset, 0, 100000, 0);
    const joins = [
      "JOIN accounts a ON a.id = e.account_id",
      "JOIN mailboxes m ON m.id = e.mailbox_id"
    ];
    const where = [];
    const args = [];
    const query = normalizeSearch(filters.q);

    if (query) {
      joins.push("JOIN email_fts ON email_fts.email_id = e.id");
      where.push("email_fts MATCH ?");
      args.push(query);
    }

    if (filters.accountId) {
      where.push("e.account_id = ?");
      args.push(filters.accountId);
    }

    if (filters.mailboxId) {
      where.push("e.mailbox_id = ?");
      args.push(filters.mailboxId);
    }

    if (filters.labelId) {
      joins.push("JOIN email_labels filter_labels ON filter_labels.email_id = e.id");
      where.push("filter_labels.label_id = ?");
      args.push(filters.labelId);
    }

    if (filters.unread === "1" || filters.unread === true) {
      where.push("e.is_read = 0");
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderSQL = query ? "ORDER BY bm25(email_fts), e.received_at DESC" : "ORDER BY e.received_at DESC";

    const rows = this.db.prepare(`
      SELECT e.id, e.account_id AS accountId, a.email AS accountEmail, a.provider,
             e.mailbox_id AS mailboxId, m.name AS mailboxName, m.role AS mailboxRole,
             e.sender_name AS senderName, e.sender_email AS senderEmail,
             e.sender_avatar_url AS senderAvatarURL, e.subject, e.snippet,
             e.received_at AS receivedAt, e.sent_at AS sentAt,
             e.is_read AS isRead, e.is_starred AS isStarred,
             e.importance, e.has_attachments AS hasAttachments,
             e.tracking_id AS trackingId, e.opened_at AS openedAt
      FROM emails e
      ${joins.join("\n")}
      ${whereSQL}
      ${orderSQL}
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);

    return rows.map(row => ({
      ...row,
      isRead: Boolean(row.isRead),
      isStarred: Boolean(row.isStarred),
      hasAttachments: Boolean(row.hasAttachments),
      labels: this.labelsForEmail(row.id)
    }));
  }

  getEmail(id) {
    const row = this.db.prepare(`
      SELECT e.id, e.account_id AS accountId, a.email AS accountEmail, a.provider,
             e.mailbox_id AS mailboxId, m.name AS mailboxName, m.role AS mailboxRole,
             e.sender_name AS senderName, e.sender_email AS senderEmail,
             e.sender_avatar_url AS senderAvatarURL, e.recipients_json AS recipientsJSON,
             e.cc_json AS ccJSON, e.bcc_json AS bccJSON, e.subject, e.snippet,
             e.body_text AS bodyText, e.body_html AS bodyHTML,
             e.received_at AS receivedAt, e.sent_at AS sentAt,
             e.is_read AS isRead, e.is_starred AS isStarred,
             e.importance, e.has_attachments AS hasAttachments,
             e.tracking_id AS trackingId, e.opened_at AS openedAt,
             e.created_at AS createdAt
      FROM emails e
      JOIN accounts a ON a.id = e.account_id
      JOIN mailboxes m ON m.id = e.mailbox_id
      WHERE e.id = ?
    `).get(id);
    if (!row) return null;

    return {
      ...row,
      recipients: parseJSON(row.recipientsJSON, []),
      cc: parseJSON(row.ccJSON, []),
      bcc: parseJSON(row.bccJSON, []),
      isRead: Boolean(row.isRead),
      isStarred: Boolean(row.isStarred),
      hasAttachments: Boolean(row.hasAttachments),
      labels: this.labelsForEmail(row.id)
    };
  }

  updateEmail(id, patch) {
    const existing = this.getEmail(id);
    if (!existing) return null;

    if (typeof patch.isRead === "boolean") {
      this.db.prepare("UPDATE emails SET is_read = ? WHERE id = ?").run(patch.isRead ? 1 : 0, id);
      this.refreshMailboxUnread(existing.mailboxId);
    }

    if (typeof patch.isStarred === "boolean") {
      this.db.prepare("UPDATE emails SET is_starred = ? WHERE id = ?").run(patch.isStarred ? 1 : 0, id);
    }

    if (typeof patch.mailboxId === "string" && patch.mailboxId !== existing.mailboxId) {
      const mailbox = this.db.prepare("SELECT id, account_id AS accountId FROM mailboxes WHERE id = ?").get(patch.mailboxId);
      if (!mailbox) throw httpError(404, "Mailbox not found.");
      if (mailbox.accountId !== existing.accountId) {
        throw httpError(400, "Emails can only move to folders in the same account.");
      }
      this.db.prepare("UPDATE emails SET mailbox_id = ? WHERE id = ?").run(patch.mailboxId, id);
      this.refreshMailboxUnread(existing.mailboxId);
      this.refreshMailboxUnread(patch.mailboxId);
    }

    return this.getEmail(id);
  }

  setEmailLabel(emailId, labelId, action = "add") {
    const email = this.getEmail(emailId);
    if (!email) return null;

    const label = this.db.prepare("SELECT id FROM labels WHERE id = ?").get(labelId);
    if (!label) {
      throw httpError(404, "Label not found.");
    }

    if (action === "remove") {
      this.db.prepare("DELETE FROM email_labels WHERE email_id = ? AND label_id = ?").run(emailId, labelId);
    } else {
      this.db.prepare("INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)").run(emailId, labelId);
    }

    return this.getEmail(emailId);
  }

  sendMessage(input) {
    const accountId = requiredString(input.accountId, "accountId");
    const account = this.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");

    const sentMailbox = this.mailboxForRole(accountId, "sent");
    const now = new Date().toISOString();
    const trackingId = input.trackOpens === false ? null : randomUUID();
    const recipients = normalizeAddressList(input.to);
    const cc = normalizeAddressList(input.cc);
    const bcc = normalizeAddressList(input.bcc);
    const subject = input.subject?.trim() || "(No subject)";
    const bodyText = input.bodyText?.trim() || "";
    const snippet = bodyText.replace(/\s+/g, " ").slice(0, 180);
    const emailId = randomUUID();
    const outboundId = randomUUID();

    this.transaction(() => {
      this.insertEmail({
        id: emailId,
        accountId,
        mailboxId: sentMailbox.id,
        providerUID: null,
        threadId: input.threadId ?? randomUUID(),
        senderName: account.displayName,
        senderEmail: account.email,
        senderAvatarURL: account.avatarURL,
        recipients,
        cc,
        bcc,
        subject,
        snippet,
        bodyText,
        bodyHTML: input.bodyHTML ?? null,
        sentAt: now,
        receivedAt: now,
        isRead: true,
        isStarred: false,
        importance: "normal",
        hasAttachments: false,
        trackingId,
        openedAt: null,
        createdAt: now
      });

      this.db.prepare(`
        INSERT INTO outbound_messages (id, email_id, account_id, status, created_at)
        VALUES (?, ?, ?, 'queued', ?)
      `).run(outboundId, emailId, accountId, now);
    });

    return {
      ...this.getEmail(emailId),
      outboundId,
      outboundStatus: "queued"
    };
  }

  markOutboundSent(outboundId, providerUID = null) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'sent', sent_at = ?, error = NULL
      WHERE id = ?
    `).run(now, outboundId);
    if (providerUID) {
      this.db.prepare(`
        UPDATE emails
        SET provider_uid = ?
        WHERE id = (SELECT email_id FROM outbound_messages WHERE id = ?)
      `).run(providerUID, outboundId);
    }
  }

  markOutboundFailed(outboundId, error) {
    this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'failed', error = ?
      WHERE id = ?
    `).run(String(error?.message ?? error), outboundId);
  }

  recordOpen(trackingId, meta = {}) {
    const email = this.db.prepare("SELECT id, opened_at AS openedAt FROM emails WHERE tracking_id = ?").get(trackingId);
    if (!email) return null;

    const now = new Date().toISOString();
    this.transaction(() => {
      if (!email.openedAt) {
        this.db.prepare("UPDATE emails SET opened_at = ? WHERE id = ?").run(now, email.id);
      }
      this.db.prepare(`
        INSERT INTO open_events (id, email_id, tracking_id, user_agent, remote_addr, opened_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), email.id, trackingId, meta.userAgent ?? null, meta.remoteAddr ?? null, now);
    });

    return this.getEmail(email.id);
  }

  seedDemoData() {
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM accounts").get();
    if (existing.count > 0) return;

    const personal = this.createAccount({
      provider: "gmail",
      email: "alex@example.com",
      displayName: "Alex",
      status: "connected",
      authType: "demo"
    });
    const work = this.createAccount({
      provider: "icloud",
      email: "alex@icloud.com",
      displayName: "Alex iCloud",
      status: "connected",
      authType: "demo"
    });

    const action = this.listLabels().find(label => label.name === "Action");
    const receipts = this.listLabels().find(label => label.name === "Receipts");
    const later = this.listLabels().find(label => label.name === "Later");

    const demoMessages = [
      {
        accountId: personal.id,
        senderName: "OpenAI",
        senderEmail: "updates@openai.com",
        subject: "Your research workspace is ready",
        bodyText: "The workspace has been prepared. You can review the latest model notes, billing settings, and project updates from the dashboard.",
        labels: [action?.id],
        hoursAgo: 1,
        unread: true
      },
      {
        accountId: work.id,
        senderName: "Apple Developer",
        senderEmail: "news@developer.apple.com",
        subject: "App Store Connect build processed",
        bodyText: "Your macOS and iOS builds finished processing and are ready for TestFlight review.",
        labels: [action?.id],
        hoursAgo: 4,
        unread: true
      },
      {
        accountId: personal.id,
        senderName: "Stripe",
        senderEmail: "receipts@stripe.com",
        subject: "Receipt for your May payment",
        bodyText: "This is your receipt for the subscription renewal. The invoice and payment details are available in your Stripe dashboard.",
        labels: [receipts?.id],
        hoursAgo: 18,
        unread: false
      },
      {
        accountId: work.id,
        senderName: "ElevenLabs",
        senderEmail: "team@elevenlabs.io",
        subject: "Voice library export completed",
        bodyText: "Your voice library export completed successfully. The archive is available for download for the next seven days.",
        labels: [later?.id],
        hoursAgo: 27,
        unread: false
      }
    ];

    for (const message of demoMessages) {
      const mailbox = this.mailboxForRole(message.accountId, "inbox");
      const date = new Date(Date.now() - message.hoursAgo * 60 * 60 * 1000).toISOString();
      const emailId = randomUUID();
      this.insertEmail({
        id: emailId,
        accountId: message.accountId,
        mailboxId: mailbox.id,
        providerUID: randomUUID(),
        threadId: randomUUID(),
        senderName: message.senderName,
        senderEmail: message.senderEmail,
        senderAvatarURL: null,
        recipients: [this.getAccount(message.accountId).email],
        cc: [],
        bcc: [],
        subject: message.subject,
        snippet: message.bodyText.slice(0, 160),
        bodyText: message.bodyText,
        bodyHTML: null,
        sentAt: date,
        receivedAt: date,
        isRead: !message.unread,
        isStarred: false,
        importance: "normal",
        hasAttachments: false,
        trackingId: null,
        openedAt: null,
        createdAt: date
      });
      for (const labelId of message.labels.filter(Boolean)) {
        this.db.prepare("INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)").run(emailId, labelId);
      }
      this.refreshMailboxUnread(mailbox.id);
    }
  }

  ensureDefaultsForAccount(accountId) {
    for (const [name, role] of SYSTEM_MAILBOXES) {
      this.db.prepare(`
        INSERT OR IGNORE INTO mailboxes (id, account_id, name, role)
        VALUES (?, ?, ?, ?)
      `).run(randomUUID(), accountId, name, role);
    }

    for (const [name, color] of SYSTEM_LABELS) {
      this.db.prepare(`
        INSERT OR IGNORE INTO labels (id, account_id, name, color, is_system)
        VALUES (?, ?, ?, ?, 1)
      `).run(randomUUID(), accountId, name, color);
    }
  }

  mailboxForRole(accountId, role) {
    const mailbox = this.db.prepare("SELECT id, name, role FROM mailboxes WHERE account_id = ? AND role = ?").get(accountId, role);
    if (!mailbox) throw httpError(404, `Mailbox ${role} not found.`);
    return mailbox;
  }

  labelsForEmail(emailId) {
    return this.db.prepare(`
      SELECT l.id, l.account_id AS accountId, l.name, l.color, l.is_system AS isSystem
      FROM labels l
      JOIN email_labels el ON el.label_id = l.id
      WHERE el.email_id = ?
      ORDER BY l.name ASC
    `).all(emailId).map(row => ({ ...row, isSystem: Boolean(row.isSystem) }));
  }

  insertEmail(email) {
    this.db.prepare(`
      INSERT INTO emails (
        id, account_id, mailbox_id, provider_uid, thread_id, sender_name, sender_email,
        sender_avatar_url, recipients_json, cc_json, bcc_json, subject, snippet,
        body_text, body_html, sent_at, received_at, is_read, is_starred, importance,
        has_attachments, tracking_id, opened_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      email.id,
      email.accountId,
      email.mailboxId,
      email.providerUID,
      email.threadId,
      email.senderName,
      email.senderEmail,
      email.senderAvatarURL,
      JSON.stringify(email.recipients ?? []),
      JSON.stringify(email.cc ?? []),
      JSON.stringify(email.bcc ?? []),
      email.subject,
      email.snippet,
      email.bodyText,
      email.bodyHTML,
      email.sentAt,
      email.receivedAt,
      email.isRead ? 1 : 0,
      email.isStarred ? 1 : 0,
      email.importance ?? "normal",
      email.hasAttachments ? 1 : 0,
      email.trackingId,
      email.openedAt,
      email.createdAt
    );

    this.insertEmailFTS(email);
  }

  upsertProviderEmail(email) {
    const existing = email.providerUID
      ? this.db.prepare("SELECT id, mailbox_id AS mailboxId FROM emails WHERE account_id = ? AND provider_uid = ?").get(email.accountId, email.providerUID)
      : null;

    if (existing) {
      this.db.prepare(`
        UPDATE emails
        SET mailbox_id = ?, thread_id = ?, sender_name = ?, sender_email = ?,
            sender_avatar_url = ?, recipients_json = ?, cc_json = ?, bcc_json = ?,
            subject = ?, snippet = ?, body_text = ?, body_html = ?,
            sent_at = ?, received_at = ?, is_read = ?, is_starred = ?,
            importance = ?, has_attachments = ?
        WHERE id = ?
      `).run(
        email.mailboxId,
        email.threadId,
        email.senderName,
        email.senderEmail,
        email.senderAvatarURL,
        JSON.stringify(email.recipients ?? []),
        JSON.stringify(email.cc ?? []),
        JSON.stringify(email.bcc ?? []),
        email.subject,
        email.snippet,
        email.bodyText,
        email.bodyHTML,
        email.sentAt,
        email.receivedAt,
        email.isRead ? 1 : 0,
        email.isStarred ? 1 : 0,
        email.importance ?? "normal",
        email.hasAttachments ? 1 : 0,
        existing.id
      );
      this.db.prepare("DELETE FROM email_fts WHERE email_id = ?").run(existing.id);
      this.insertEmailFTS({ ...email, id: existing.id });
      this.refreshMailboxUnread(existing.mailboxId);
      this.refreshMailboxUnread(email.mailboxId);
      return this.getEmail(existing.id);
    }

    this.insertEmail(email);
    this.refreshMailboxUnread(email.mailboxId);
    return this.getEmail(email.id);
  }

  insertEmailFTS(email) {
    this.db.prepare(`
      INSERT INTO email_fts (email_id, account_id, subject, sender_name, sender_email, recipients, snippet, body_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      email.id,
      email.accountId,
      email.subject,
      email.senderName,
      email.senderEmail,
      normalizeAddressList(email.recipients).join(" "),
      email.snippet,
      email.bodyText
    );
  }

  refreshMailboxUnread(mailboxId) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM emails WHERE mailbox_id = ? AND is_read = 0").get(mailboxId);
    this.db.prepare("UPDATE mailboxes SET unread_count = ? WHERE id = ?").run(row.count, mailboxId);
  }

  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeProvider(provider) {
  if (provider !== "gmail" && provider !== "icloud") {
    throw httpError(400, "Provider must be gmail or icloud.");
  }
  return provider;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw httpError(400, `${name} is required.`);
  }
  return value.trim();
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseJSON(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeAddressList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  return String(value).split(",").map(item => item.trim()).filter(Boolean);
}

function normalizeSearch(value) {
  if (typeof value !== "string") return "";
  const terms = Array.from(value.toLowerCase().matchAll(/[\p{L}\p{N}@._-]+/gu), match => match[0])
    .filter(term => term.length > 0)
    .slice(0, 8);
  return terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}
