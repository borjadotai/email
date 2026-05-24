import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { senderLogoURLForEmail } from "./logoResolver.js";

const SYSTEM_MAILBOXES = [
  ["Inbox", "inbox"],
  ["Sent", "sent"],
  ["Drafts", "drafts"],
  ["Archive", "archive"],
  ["Spam", "spam"],
  ["Trash", "trash"]
];

const SYSTEM_LABELS = [
  ["Important", "orange"],
  ["Receipts", "green"],
  ["Action", "blue"],
  ["Later", "purple"]
];

const SEARCH_INDEX_VERSION = "2";

export class MailStore {
  constructor({ databasePath = ":memory:", seedDemo = false } = {}) {
    this.databasePath = databasePath;
    this.currentUser = null;
    this.db = new DatabaseSync(databasePath);
    this.migrate();
    if (seedDemo) {
      this.seedDemoData();
    }
  }

  forUser(user) {
    const scoped = Object.create(this);
    scoped.currentUser = normalizeAppUser(user);
    scoped.ensureCurrentUser();
    return scoped;
  }

  close() {
    this.db.close();
  }

  async checkReadiness() {
    return {
      database: await this.checkDatabaseReadiness(),
      attachmentStorage: await this.checkAttachmentStorageReadiness()
    };
  }

  async checkDatabaseReadiness() {
    this.db.prepare("SELECT 1 AS ok").get();
    return {
      engine: "sqlite",
      path: this.databasePath
    };
  }

  async checkAttachmentStorageReadiness() {
    return {
      mode: "inline",
      bucket: null
    };
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
        rfc_message_id TEXT,
        in_reply_to TEXT,
        references_json TEXT NOT NULL DEFAULT '[]',
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

      CREATE TABLE IF NOT EXISTS email_attachments (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
        provider_attachment_id TEXT,
        content_id TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        disposition TEXT,
        is_inline INTEGER NOT NULL DEFAULT 0,
        data BLOB,
        created_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS blocked_senders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('email', 'domain')),
        value TEXT NOT NULL,
        source_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE(account_id, scope, value)
      );

      CREATE TABLE IF NOT EXISTS push_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
        bundle_id TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
        device_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        disabled_at TEXT,
        failure_reason TEXT,
        UNIQUE(token, bundle_id, environment)
      );

      CREATE TABLE IF NOT EXISTS provider_auth_sessions (
        state TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('gmail')),
        code_verifier TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        sync_history INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_email_attachments_email ON email_attachments(email_id);
      CREATE INDEX IF NOT EXISTS idx_blocked_senders_account ON blocked_senders(account_id, scope, value);
      CREATE INDEX IF NOT EXISTS idx_push_tokens_active ON push_tokens(platform, bundle_id, environment)
        WHERE disabled_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_push_tokens_user_active ON push_tokens(user_id, platform, bundle_id, environment)
        WHERE disabled_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_provider_auth_sessions_user
        ON provider_auth_sessions(user_id, provider, created_at);
      CREATE INDEX IF NOT EXISTS idx_provider_auth_sessions_expires
        ON provider_auth_sessions(expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_account_provider_uid
        ON emails(account_id, provider_uid)
        WHERE provider_uid IS NOT NULL;
    `);
    this.ensureColumn("accounts", "provider_metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("emails", "rfc_message_id", "TEXT");
    this.ensureColumn("emails", "in_reply_to", "TEXT");
    this.ensureColumn("emails", "references_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("push_tokens", "user_id", "TEXT REFERENCES app_users(id) ON DELETE CASCADE");
    this.ensureDefaultsForExistingAccounts();
    this.ensureLocalUser();
    this.linkUnownedAccountsToLocalUser();
    this.linkUnownedPushTokensToLocalUser();
    this.hydrateLocalUserFromAccounts();
    this.reclassifyLocalUserInboxMessages();
    this.repairCrossAccountSentMisclassifications();
    this.repairLocalUserSenderNames();
    this.ensureSearchIndexVersion();
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

  saveProviderAuthSession(input) {
    const provider = normalizeProvider(input.provider);
    if (provider !== "gmail") throw httpError(400, "Provider auth sessions only support gmail.");
    const state = requiredString(input.state, "state");
    const codeVerifier = requiredString(input.codeVerifier, "codeVerifier");
    const rawUser = input.user ?? this.currentUser;
    let user = normalizeAppUser(rawUser);
    if (rawUser?.isLocal === true) {
      const localUser = this.ensureCurrentUser();
      user = {
        id: localUser.id,
        email: localUser.primaryEmail ?? null,
        displayName: localUser.displayName,
        isLocal: true
      };
    } else {
      const scoped = this.currentUser ? this : this.forUser(user);
      scoped.ensureCurrentUser();
    }
    const now = new Date().toISOString();
    const expiresAt = normalizeFutureDate(input.expiresAt, 10 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM provider_auth_sessions WHERE expires_at <= ?").run(now);
    this.db.prepare(`
      INSERT INTO provider_auth_sessions (
        state, user_id, provider, code_verifier, display_name, sync_history, created_at, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state) DO UPDATE SET
        user_id = excluded.user_id,
        provider = excluded.provider,
        code_verifier = excluded.code_verifier,
        display_name = excluded.display_name,
        sync_history = excluded.sync_history,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(
      state,
      user.id,
      provider,
      codeVerifier,
      optionalString(input.displayName) ?? "",
      input.syncHistory === false ? 0 : 1,
      now,
      expiresAt
    );
  }

  consumeProviderAuthSession(input) {
    const state = requiredString(input.state, "state");
    const provider = normalizeProvider(input.provider);
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM provider_auth_sessions WHERE expires_at <= ?").run(now);
    const row = this.db.prepare(`
      SELECT s.state, s.provider, s.code_verifier AS codeVerifier,
             s.display_name AS displayName, s.sync_history AS syncHistory,
             s.created_at AS createdAt, s.expires_at AS expiresAt,
             u.id AS userId, u.primary_email AS userEmail, u.display_name AS userDisplayName
      FROM provider_auth_sessions s
      JOIN app_users u ON u.id = s.user_id
      WHERE s.state = ? AND s.provider = ?
      LIMIT 1
    `).get(state, provider);
    this.db.prepare("DELETE FROM provider_auth_sessions WHERE state = ?").run(state);
    if (!row) return null;
    return {
      state: row.state,
      provider: row.provider,
      codeVerifier: row.codeVerifier,
      displayName: row.displayName,
      syncHistory: Boolean(row.syncHistory),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      user: {
        id: row.userId,
        email: row.userEmail,
        displayName: row.userDisplayName,
        isLocal: row.userId === "local"
      }
    };
  }

  createAccount(input) {
    const provider = normalizeProvider(input.provider);
    const email = requiredString(input.email, "email").toLowerCase();
    const displayName = input.displayName?.trim() || email;
    const avatarURL = optionalString(input.avatarURL);
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
        avatarURL,
        input.authType ?? "not_configured",
        input.status ?? "connected",
        input.syncHistory === false ? 0 : 1,
        now
      );
      this.ensureDefaultsForAccount(id);
      this.linkAccountToCurrentUser(id, provider, email);
    });

    this.reclassifyLocalUserInboxMessages();
    this.repairCrossAccountSentMisclassifications();
    this.repairLocalUserSenderNames();
    return this.getAccount(id);
  }

  createOrUpdateAccount(input) {
    const provider = normalizeProvider(input.provider);
    const email = requiredString(input.email, "email").toLowerCase();
    const avatarURL = optionalString(input.avatarURL);
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id FROM accounts WHERE email = ?").get(email);

    if (existing) {
      this.db.prepare(`
        UPDATE accounts
        SET provider = ?, display_name = ?, avatar_url = COALESCE(?, avatar_url), auth_type = ?,
            status = ?, sync_history = ?, last_sync_at = COALESCE(?, last_sync_at),
            provider_metadata_json = ?
        WHERE id = ?
      `).run(
        provider,
        input.displayName?.trim() || email,
        avatarURL,
        input.authType ?? "not_configured",
        input.status ?? "connected",
        input.syncHistory === false ? 0 : 1,
        input.lastSyncAt ?? null,
        JSON.stringify(input.providerMetadata ?? {}),
        existing.id
      );
      this.ensureDefaultsForAccount(existing.id);
      this.linkAccountToCurrentUser(existing.id, provider, email);
      this.reclassifyLocalUserInboxMessages();
      this.repairCrossAccountSentMisclassifications();
      this.repairLocalUserSenderNames();
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
      SELECT a.id, a.provider, a.email, a.display_name AS displayName,
             ${accountAvatarSelect("a")},
             a.auth_type AS authType, a.status, a.sync_history AS syncHistory,
             a.last_sync_at AS lastSyncAt, a.provider_metadata_json AS providerMetadataJSON,
             a.created_at AS createdAt
      FROM accounts a
      JOIN account_user_links l ON l.account_id = a.id
      WHERE l.user_id = ?
      ORDER BY a.created_at ASC
    `).all(this.currentUserId()).map(row => ({
      ...row,
      syncHistory: Boolean(row.syncHistory),
      providerMetadata: parseJSON(row.providerMetadataJSON, {})
    }));
  }

  listSyncableAccounts({ staleBefore = null, limit = 100 } = {}) {
    const args = [];
    let staleSQL = "";
    if (staleBefore) {
      staleSQL = "AND (a.last_sync_at IS NULL OR a.last_sync_at <= ?)";
      args.push(dateString(staleBefore));
    }
    args.push(clampInt(limit, 1, 500, 100));
    return this.db.prepare(`
      SELECT a.id, a.provider, a.email, a.display_name AS displayName,
             ${accountAvatarSelect("a")},
             a.auth_type AS authType, a.status, a.sync_history AS syncHistory,
             a.last_sync_at AS lastSyncAt, a.provider_metadata_json AS providerMetadataJSON,
             a.created_at AS createdAt,
             u.id AS userId, u.primary_email AS userEmail, u.display_name AS userDisplayName
      FROM accounts a
      JOIN account_user_links l ON l.account_id = a.id
      JOIN app_users u ON u.id = l.user_id
      WHERE a.status = 'connected'
        ${staleSQL}
      ORDER BY COALESCE(a.last_sync_at, '1970-01-01T00:00:00.000Z') ASC, a.created_at ASC
      LIMIT ?
    `).all(...args).map(row => ({
      ...row,
      syncHistory: Boolean(row.syncHistory),
      providerMetadata: parseJSON(row.providerMetadataJSON, {}),
      user: {
        id: row.userId,
        email: row.userEmail,
        displayName: row.userDisplayName,
        isLocal: row.userId === "local"
      }
    }));
  }

  getProfile() {
    const user = this.ensureCurrentUser();
    return {
      ...user,
      accounts: this.listAccounts()
    };
  }

  claimUserIdentity(input) {
    const provider = normalizeProvider(input.provider);
    const email = requiredString(input.email, "email").toLowerCase();
    const displayName = input.displayName?.trim() || email;
    const user = this.ensureCurrentUser();
    const primaryEmail = user.primaryEmail || email;

    this.db.prepare(`
      UPDATE app_users
      SET display_name = ?, primary_email = ?, updated_at = ?
      WHERE id = ?
    `).run(displayName, primaryEmail, new Date().toISOString(), user.id);

    if (input.accountId) {
      this.linkAccountToCurrentUser(input.accountId, provider, email);
    }

    return this.getProfile();
  }

  getAccount(id) {
    const row = this.db.prepare(`
      SELECT a.id, a.provider, a.email, a.display_name AS displayName,
             ${accountAvatarSelect("a")},
             a.auth_type AS authType, a.status, a.sync_history AS syncHistory,
             a.last_sync_at AS lastSyncAt, a.provider_metadata_json AS providerMetadataJSON,
             a.created_at AS createdAt
      FROM accounts a
      JOIN account_user_links l ON l.account_id = a.id
      WHERE a.id = ?
        AND l.user_id = ?
    `).get(id, this.currentUserId());
    if (!row) return null;
    return { ...row, syncHistory: Boolean(row.syncHistory), providerMetadata: parseJSON(row.providerMetadataJSON, {}) };
  }

  ensureCurrentUser() {
    if (!this.currentUser) return this.ensureLocalUser();

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_users (id, display_name, primary_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_email = COALESCE(app_users.primary_email, excluded.primary_email),
        updated_at = excluded.updated_at
    `).run(
      this.currentUser.id,
      this.currentUser.displayName,
      this.currentUser.email,
      now,
      now
    );

    return this.db.prepare(`
      SELECT id, display_name AS displayName, primary_email AS primaryEmail,
             created_at AS createdAt, updated_at AS updatedAt
      FROM app_users
      WHERE id = ?
    `).get(this.currentUser.id);
  }

  currentUserId() {
    return this.ensureCurrentUser().id;
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

  linkUnownedPushTokensToLocalUser() {
    const user = this.ensureLocalUser();
    this.db.prepare(`
      UPDATE push_tokens
      SET user_id = ?
      WHERE user_id IS NULL
    `).run(user.id);
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

  linkAccountToCurrentUser(accountId, provider, email) {
    const user = this.ensureCurrentUser();
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

  isLocalUserEmail(email) {
    const normalized = normalizeEmailForComparison(email);
    if (!normalized) return false;

    return Boolean(this.db.prepare(`
      SELECT 1
      FROM (
        SELECT a.email FROM accounts a
        JOIN account_user_links l ON l.account_id = a.id
        WHERE l.user_id = ?
        UNION
        SELECT provider_email AS email FROM account_user_links
        WHERE user_id = ?
      ) identities
      WHERE lower(email) = ?
      LIMIT 1
    `).get(this.currentUserId(), this.currentUserId(), normalized));
  }

  isAccountIdentityEmail(accountId, email) {
    const normalized = normalizeEmailForComparison(email);
    if (!normalized) return false;

    return Boolean(this.db.prepare(`
      SELECT 1
      FROM (
        SELECT email FROM accounts WHERE id = ?
        UNION
        SELECT provider_email AS email FROM account_user_links WHERE account_id = ?
      ) identities
      WHERE lower(email) = ?
      LIMIT 1
    `).get(accountId, accountId, normalized));
  }

  displayNameForLocalUserEmail(email) {
    const normalized = normalizeEmailForComparison(email);
    if (!normalized) return null;

    const account = this.db.prepare(`
      SELECT display_name AS displayName
      FROM accounts a
      JOIN account_user_links l ON l.account_id = a.id
      WHERE lower(a.email) = ?
        AND l.user_id = ?
      LIMIT 1
    `).get(normalized, this.currentUserId());
    if (account?.displayName) {
      return account.displayName;
    }

    return this.db.prepare(`
      SELECT u.display_name AS displayName
      FROM account_user_links l
      JOIN app_users u ON u.id = l.user_id
      WHERE lower(l.provider_email) = ?
        AND l.user_id = ?
      LIMIT 1
    `).get(normalized, this.currentUserId())?.displayName ?? null;
  }

  reclassifyLocalUserInboxMessages(accountId = null) {
    const args = [];
    const accountFilter = accountId ? "AND e.account_id = ?" : "";
    if (accountId) {
      args.push(accountId);
    }

    const affectedMailboxes = this.db.prepare(`
      SELECT DISTINCT e.mailbox_id AS mailboxId, sent.id AS sentMailboxId
      FROM emails e
      JOIN mailboxes current ON current.id = e.mailbox_id
      JOIN accounts a ON a.id = e.account_id
      JOIN mailboxes sent ON sent.account_id = e.account_id AND sent.role = 'sent'
      WHERE current.role = 'inbox'
        ${accountFilter}
        AND ${accountIdentityMatchSQL("e", "a")}
    `).all(...args);

    const result = this.db.prepare(`
      UPDATE emails AS e
      SET mailbox_id = (
        SELECT sent.id
        FROM mailboxes sent
        WHERE sent.account_id = e.account_id AND sent.role = 'sent'
      )
      WHERE e.id IN (
        SELECT e2.id
        FROM emails e2
        JOIN mailboxes current ON current.id = e2.mailbox_id
        JOIN accounts a2 ON a2.id = e2.account_id
        WHERE current.role = 'inbox'
          ${accountFilter.replaceAll("e.", "e2.")}
          AND ${accountIdentityMatchSQL("e2", "a2")}
      )
    `).run(...args);

    for (const mailbox of affectedMailboxes) {
      this.refreshMailboxUnread(mailbox.mailboxId);
      this.refreshMailboxUnread(mailbox.sentMailboxId);
    }

    return result.changes ?? 0;
  }

  repairCrossAccountSentMisclassifications(accountId = null) {
    const args = [];
    const accountFilter = accountId ? "AND e.account_id = ?" : "";
    if (accountId) {
      args.push(accountId);
    }

    const candidates = this.db.prepare(`
      SELECT e.id, e.mailbox_id AS mailboxId, inbox.id AS inboxMailboxId
      FROM emails e
      JOIN accounts a ON a.id = e.account_id
      JOIN mailboxes current ON current.id = e.mailbox_id
      JOIN mailboxes inbox ON inbox.account_id = e.account_id AND inbox.role = 'inbox'
      WHERE current.role = 'sent'
        ${accountFilter}
        AND lower(e.sender_email) IN (
          SELECT lower(a.email)
          FROM accounts a
          JOIN account_user_links l ON l.account_id = a.id
          WHERE l.user_id = ?
          UNION
          SELECT lower(provider_email)
          FROM account_user_links
          WHERE user_id = ?
        )
        AND NOT ${accountIdentityMatchSQL("e", "a")}
    `).all(...args, this.currentUserId(), this.currentUserId());

    const update = this.db.prepare("UPDATE emails SET mailbox_id = ? WHERE id = ?");
    const touchedMailboxIDs = new Set();
    for (const candidate of candidates) {
      update.run(candidate.inboxMailboxId, candidate.id);
      touchedMailboxIDs.add(candidate.mailboxId);
      touchedMailboxIDs.add(candidate.inboxMailboxId);
    }

    for (const mailboxId of touchedMailboxIDs) {
      this.refreshMailboxUnread(mailboxId);
    }

    return candidates.length;
  }

  repairLocalUserSenderNames(accountId = null) {
    const args = [];
    const accountFilter = accountId ? "AND e.account_id = ?" : "";
    if (accountId) {
      args.push(accountId);
    }

    const result = this.db.prepare(`
      UPDATE emails AS e
      SET sender_name = (
        SELECT a.display_name
        FROM accounts a
        JOIN account_user_links l ON l.account_id = a.id
        WHERE lower(a.email) = lower(e.sender_email)
          AND l.user_id = ?
        LIMIT 1
      )
      WHERE lower(e.sender_email) IN (
        SELECT lower(a.email)
        FROM accounts a
        JOIN account_user_links l ON l.account_id = a.id
        WHERE l.user_id = ?
      )
        ${accountFilter}
        AND lower(e.sender_name) = lower(e.sender_email)
    `).run(this.currentUserId(), this.currentUserId(), ...args);

    if ((result.changes ?? 0) > 0) {
      this.rebuildEmailFTS();
    }

    return result.changes ?? 0;
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

  updateAccountSettings(id, input = {}) {
    const account = this.getAccount(id);
    if (!account) return null;

    const displayName = optionalString(input.displayName) ?? account.displayName;
    const hasAvatarURL = Object.hasOwn(input, "avatarURL");
    const avatarURL = hasAvatarURL ? optionalString(input.avatarURL) : null;
    const syncHistory = typeof input.syncHistory === "boolean" ? input.syncHistory : account.syncHistory;

    if (hasAvatarURL) {
      this.db.prepare(`
        UPDATE accounts
        SET display_name = ?, avatar_url = ?, sync_history = ?
        WHERE id = ?
      `).run(displayName, avatarURL, syncHistory ? 1 : 0, id);
    } else {
      this.db.prepare(`
        UPDATE accounts
        SET display_name = ?, sync_history = ?
        WHERE id = ?
      `).run(displayName, syncHistory ? 1 : 0, id);
    }

    if (displayName !== account.displayName) {
      this.db.prepare(`
        UPDATE emails
        SET sender_name = ?
        WHERE account_id = ?
          AND lower(sender_email) = lower(?)
      `).run(displayName, account.id, account.email);
    }

    if (hasAvatarURL) {
      this.db.prepare(`
        UPDATE emails
        SET sender_avatar_url = ?
        WHERE account_id = ?
          AND lower(sender_email) = lower(?)
      `).run(avatarURL || senderLogoURLForEmail(account.email), account.id, account.email);
    }

    if (displayName !== account.displayName) {
      this.rebuildEmailFTS();
    }

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
    const args = [this.currentUserId()];
    let where = "WHERE l.user_id = ?";
    if (accountId) {
      where += " AND m.account_id = ?";
      args.push(accountId);
    }

    return this.db.prepare(`
      SELECT m.id, m.account_id AS accountId, a.email AS accountEmail,
             m.name, m.role, m.unread_count AS unreadCount
      FROM mailboxes m
      JOIN accounts a ON a.id = m.account_id
      JOIN account_user_links l ON l.account_id = a.id
      ${where}
      ORDER BY a.created_at ASC,
        CASE m.role
          WHEN 'inbox' THEN 0
          WHEN 'sent' THEN 1
          WHEN 'drafts' THEN 2
          WHEN 'archive' THEN 3
          WHEN 'spam' THEN 4
          WHEN 'trash' THEN 5
          ELSE 9
        END
    `).all(...args);
  }

  listLabels(accountId = null) {
    const args = [this.currentUserId()];
    let where = "WHERE (l.account_id IS NULL OR ul.user_id = ?)";
    if (accountId) {
      where += " AND (l.account_id IS NULL OR l.account_id = ?)";
      args.push(accountId);
    }

    return this.db.prepare(`
      SELECT l.id, l.account_id AS accountId, a.email AS accountEmail,
             l.name, l.color, l.is_system AS isSystem
      FROM labels l
      LEFT JOIN accounts a ON a.id = l.account_id
      LEFT JOIN account_user_links ul ON ul.account_id = a.id
      ${where}
      ORDER BY l.is_system DESC, l.name ASC
    `).all(...args).map(row => ({ ...row, isSystem: Boolean(row.isSystem) }));
  }

  createLabel(input) {
    const name = requiredString(input.name, "name");
    if (input.accountId && !this.getAccount(input.accountId)) {
      throw httpError(404, "Account not found.");
    }
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
    if (accountId && !this.getAccount(accountId)) {
      throw httpError(404, "Account not found.");
    }
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
      "JOIN mailboxes m ON m.id = e.mailbox_id",
      "JOIN account_user_links owner_link ON owner_link.account_id = e.account_id"
    ];
    const where = ["owner_link.user_id = ?"];
    const args = [this.currentUserId()];
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

    if (filters.mailboxRole) {
      where.push("m.role = ?");
      args.push(filters.mailboxRole);
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
    const orderSQL = "ORDER BY e.received_at DESC";

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
      senderAvatarURL: row.senderAvatarURL || senderLogoURLForEmail(row.senderEmail),
      isRead: Boolean(row.isRead),
      isStarred: Boolean(row.isStarred),
      hasAttachments: Boolean(row.hasAttachments),
      labels: this.labelsForEmail(row.id)
    }));
  }

  getEmail(id, options = {}) {
    const scoped = options.unscoped !== true;
    const ownerJoin = scoped ? "JOIN account_user_links l ON l.account_id = e.account_id" : "";
    const ownerWhere = scoped ? "AND l.user_id = ?" : "";
    const args = scoped ? [id, this.currentUserId()] : [id];
    const row = this.db.prepare(`
      SELECT e.id, e.account_id AS accountId, a.email AS accountEmail, a.provider,
             e.mailbox_id AS mailboxId, m.name AS mailboxName, m.role AS mailboxRole,
             e.provider_uid AS providerUID, e.thread_id AS threadId,
             e.sender_name AS senderName, e.sender_email AS senderEmail,
             e.sender_avatar_url AS senderAvatarURL, e.recipients_json AS recipientsJSON,
             e.cc_json AS ccJSON, e.bcc_json AS bccJSON, e.subject, e.snippet,
             e.body_text AS bodyText, e.body_html AS bodyHTML,
             e.rfc_message_id AS rfcMessageID, e.in_reply_to AS inReplyTo,
             e.references_json AS referencesJSON,
             e.received_at AS receivedAt, e.sent_at AS sentAt,
             e.is_read AS isRead, e.is_starred AS isStarred,
             e.importance, e.has_attachments AS hasAttachments,
             e.tracking_id AS trackingId, e.opened_at AS openedAt,
             e.created_at AS createdAt
      FROM emails e
      JOIN accounts a ON a.id = e.account_id
      JOIN mailboxes m ON m.id = e.mailbox_id
      ${ownerJoin}
      WHERE e.id = ?
        ${ownerWhere}
    `).get(...args);
    if (!row) return null;

    return {
      ...row,
      senderAvatarURL: row.senderAvatarURL || senderLogoURLForEmail(row.senderEmail),
      recipients: parseJSON(row.recipientsJSON, []),
      cc: parseJSON(row.ccJSON, []),
      bcc: parseJSON(row.bccJSON, []),
      references: parseJSON(row.referencesJSON, []),
      isRead: Boolean(row.isRead),
      isStarred: Boolean(row.isStarred),
      hasAttachments: Boolean(row.hasAttachments),
      labels: this.labelsForEmail(row.id),
      attachments: this.attachmentsForEmail(row.id)
    };
  }

  listThreadEmails(emailId) {
    const anchor = this.getEmail(emailId);
    if (!anchor) return null;

    const threadRows = anchor.threadId ? this.db.prepare(`
      SELECT id
      FROM emails
      WHERE account_id = ?
        AND thread_id = ?
    `).all(anchor.accountId, anchor.threadId) : [];

    const messageKeys = uniqueStrings([
      anchor.rfcMessageID,
      anchor.inReplyTo,
      ...anchor.references
    ]);
    const rfcRows = messageKeys.length ? this.db.prepare(`
      WITH keys(value) AS (
        SELECT value FROM json_each(?)
      )
      SELECT DISTINCT e.id
      FROM emails e
      WHERE e.rfc_message_id IN (SELECT value FROM keys)
         OR e.in_reply_to IN (SELECT value FROM keys)
         OR EXISTS (
           SELECT 1
           FROM json_each(e.references_json) refs
           JOIN keys ON keys.value = refs.value
         )
    `).all(JSON.stringify(messageKeys)) : [];

    const ids = uniqueStrings([...threadRows, ...rfcRows].map(row => row.id));
    if (ids.length === 0) {
      return [anchor];
    }

    const emails = ids
      .map(id => this.getEmail(id))
      .filter(Boolean);

    if (!emails.some(email => email.id === anchor.id)) {
      emails.push(anchor);
    }

    return emails
      .sort((a, b) => {
        const aTime = Date.parse(a.sentAt ?? a.receivedAt ?? a.createdAt ?? "");
        const bTime = Date.parse(b.sentAt ?? b.receivedAt ?? b.createdAt ?? "");
        if (aTime !== bTime) return aTime - bTime;
        return a.id.localeCompare(b.id);
      });
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

  markEmailSpam(id) {
    const existing = this.getEmail(id);
    if (!existing) return null;

    const spamMailbox = this.mailboxForRole(existing.accountId, "spam");
    if (existing.mailboxId !== spamMailbox.id) {
      this.db.prepare("UPDATE emails SET mailbox_id = ? WHERE id = ?").run(spamMailbox.id, id);
      this.refreshMailboxUnread(existing.mailboxId);
      this.refreshMailboxUnread(spamMailbox.id);
    }

    return this.getEmail(id);
  }

  archiveEmail(id) {
    const existing = this.getEmail(id);
    if (!existing) return null;

    const archiveMailbox = this.mailboxForRole(existing.accountId, "archive");
    if (existing.mailboxId !== archiveMailbox.id) {
      this.db.prepare("UPDATE emails SET mailbox_id = ? WHERE id = ?").run(archiveMailbox.id, id);
      this.refreshMailboxUnread(existing.mailboxId);
      this.refreshMailboxUnread(archiveMailbox.id);
    }

    return this.getEmail(id);
  }

  trashEmail(id) {
    const existing = this.getEmail(id);
    if (!existing) return null;

    const trashMailbox = this.mailboxForRole(existing.accountId, "trash");
    if (existing.mailboxId !== trashMailbox.id) {
      this.db.prepare("UPDATE emails SET mailbox_id = ? WHERE id = ?").run(trashMailbox.id, id);
      this.refreshMailboxUnread(existing.mailboxId);
      this.refreshMailboxUnread(trashMailbox.id);
    }

    return this.getEmail(id);
  }

  listBlockedSenders(accountId = null) {
    const args = [this.currentUserId()];
    let where = "WHERE l.user_id = ?";
    if (accountId) {
      where += " AND b.account_id = ?";
      args.push(accountId);
    }

    return this.db.prepare(`
      SELECT b.id, b.account_id AS accountId, a.email AS accountEmail,
             b.scope, b.value, b.source_email_id AS sourceEmailId,
             b.created_at AS createdAt
      FROM blocked_senders b
      JOIN accounts a ON a.id = b.account_id
      JOIN account_user_links l ON l.account_id = a.id
      ${where}
      ORDER BY b.created_at DESC
    `).all(...args);
  }

  registerPushToken(input = {}) {
    const token = normalizePushToken(input.token);
    const platform = normalizePushPlatform(input.platform);
    const bundleId = requiredString(input.bundleId ?? input.bundleID, "bundleId");
    const environment = normalizePushEnvironment(input.environment);
    const deviceName = optionalString(input.deviceName);
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO push_tokens (
        id, user_id, token, platform, bundle_id, environment, device_name,
        created_at, updated_at, last_seen_at, disabled_at, failure_reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(token, bundle_id, environment) DO UPDATE SET
        user_id = excluded.user_id,
        platform = excluded.platform,
        device_name = excluded.device_name,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at,
        disabled_at = NULL,
        failure_reason = NULL
    `).run(id, this.currentUserId(), token, platform, bundleId, environment, deviceName, now, now, now);

    return this.db.prepare(`
      SELECT id, token, platform, bundle_id AS bundleId, environment,
             device_name AS deviceName, created_at AS createdAt,
             updated_at AS updatedAt, last_seen_at AS lastSeenAt,
             disabled_at AS disabledAt, failure_reason AS failureReason
      FROM push_tokens
      WHERE user_id = ? AND token = ? AND bundle_id = ? AND environment = ?
    `).get(this.currentUserId(), token, bundleId, environment);
  }

  listPushTokens(filters = {}) {
    const where = ["disabled_at IS NULL", "user_id = ?"];
    const args = [this.currentUserId()];

    if (filters.platform) {
      where.push("platform = ?");
      args.push(normalizePushPlatform(filters.platform));
    }
    if (filters.environment) {
      where.push("environment = ?");
      args.push(normalizePushEnvironment(filters.environment));
    }

    return this.db.prepare(`
      SELECT id, token, platform, bundle_id AS bundleId, environment,
             device_name AS deviceName, created_at AS createdAt,
             updated_at AS updatedAt, last_seen_at AS lastSeenAt
      FROM push_tokens
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
    `).all(...args);
  }

  disablePushToken(id, reason = "disabled") {
    this.db.prepare(`
      UPDATE push_tokens
      SET disabled_at = ?, failure_reason = ?
      WHERE id = ?
    `).run(new Date().toISOString(), String(reason), id);
  }

  inboxUnreadCount() {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(unread_count), 0) AS count
      FROM mailboxes m
      JOIN account_user_links l ON l.account_id = m.account_id
      WHERE m.role = 'inbox'
        AND l.user_id = ?
    `).get(this.currentUserId());
    return row.count ?? 0;
  }

  blockSenderForEmail(emailId, scope) {
    const email = this.getEmail(emailId);
    if (!email) return null;

    const normalizedScope = normalizeBlockScope(scope);
    const value = normalizedScope === "email"
      ? normalizeEmailAddress(email.senderEmail, "senderEmail")
      : domainForEmail(email.senderEmail);
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT OR IGNORE INTO blocked_senders (id, account_id, scope, value, source_email_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, email.accountId, normalizedScope, value, email.id, now);

    const rule = this.db.prepare(`
      SELECT id, account_id AS accountId, scope, value,
             source_email_id AS sourceEmailId, created_at AS createdAt
      FROM blocked_senders
      WHERE account_id = ? AND scope = ? AND value = ?
    `).get(email.accountId, normalizedScope, value);
    const affectedCount = this.moveBlockedMessagesToSpam(email.accountId, normalizedScope, value);

    return {
      rule,
      affectedCount,
      email: this.getEmail(email.id)
    };
  }

  setEmailLabel(emailId, labelId, action = "add") {
    const email = this.getEmail(emailId);
    if (!email) return null;

    const label = this.db.prepare(`
      SELECT id, account_id AS accountId
      FROM labels
      WHERE id = ?
        AND (account_id IS NULL OR account_id = ?)
    `).get(labelId, email.accountId);
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

    const replyToEmailID = optionalString(input.replyToEmailID ?? input.replyToEmailId);
    const replyToEmail = replyToEmailID ? this.getEmail(replyToEmailID) : null;
    if (replyToEmailID && !replyToEmail) {
      throw httpError(404, "Reply target not found.");
    }
    if (replyToEmail && replyToEmail.accountId !== accountId) {
      throw httpError(400, "Replies must be sent from the account that owns the conversation.");
    }

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
    const rfcMessageID = makeRFCMessageID(account.email);
    const references = replyReferences(replyToEmail);

    this.transaction(() => {
      this.insertEmail({
        id: emailId,
        accountId,
        mailboxId: sentMailbox.id,
        providerUID: null,
        threadId: replyToEmail?.threadId ?? input.threadId ?? randomUUID(),
        senderName: account.displayName,
        senderEmail: account.email,
        senderAvatarURL: account.avatarURL || senderLogoURLForEmail(account.email),
        recipients,
        cc,
        bcc,
        subject,
        snippet,
        bodyText,
        bodyHTML: input.bodyHTML ?? null,
        rfcMessageID,
        inReplyTo: replyToEmail?.rfcMessageID ?? null,
        references,
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
    const email = this.db.prepare(`
      SELECT e.id, e.opened_at AS openedAt, l.user_id AS userId
      FROM emails e
      LEFT JOIN account_user_links l ON l.account_id = e.account_id
      WHERE e.tracking_id = ?
    `).get(trackingId);
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

    return { ...this.getEmail(email.id, { unscoped: true }), userId: email.userId ?? null };
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

  ensureDefaultsForExistingAccounts() {
    const accounts = this.db.prepare("SELECT id FROM accounts").all();
    for (const account of accounts) {
      this.ensureDefaultsForAccount(account.id);
    }
  }

  mailboxForRole(accountId, role) {
    const mailbox = this.db.prepare("SELECT id, name, role FROM mailboxes WHERE account_id = ? AND role = ?").get(accountId, role);
    if (!mailbox) throw httpError(404, `Mailbox ${role} not found.`);
    return mailbox;
  }

  mailboxRole(mailboxId) {
    return this.db.prepare("SELECT role FROM mailboxes WHERE id = ?").get(mailboxId)?.role ?? null;
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

  attachmentsForEmail(emailId) {
    return this.db.prepare(`
      SELECT id, email_id AS emailId, filename, mime_type AS mimeType, size,
             disposition, is_inline AS isInline, content_id AS contentId,
             data IS NOT NULL AS isDownloaded
      FROM email_attachments
      WHERE email_id = ?
      ORDER BY is_inline ASC, filename ASC
    `).all(emailId).map(row => ({
      ...row,
      isInline: Boolean(row.isInline),
      isDownloaded: Boolean(row.isDownloaded)
    }));
  }

  getAttachment(emailId, attachmentId) {
    const row = this.db.prepare(`
      SELECT id, email_id AS emailId, filename, mime_type AS mimeType, size,
             disposition, is_inline AS isInline, content_id AS contentId, data
      FROM email_attachments
      WHERE email_id = ? AND id = ?
    `).get(emailId, attachmentId);
    if (!row) return null;
    return {
      ...row,
      isInline: Boolean(row.isInline)
    };
  }

  replaceEmailAttachments(emailId, attachments = []) {
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM email_attachments WHERE email_id = ?").run(emailId);

    const insert = this.db.prepare(`
      INSERT INTO email_attachments (
        id, email_id, provider_attachment_id, content_id, filename, mime_type,
        size, disposition, is_inline, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const attachment of attachments) {
      const data = Buffer.isBuffer(attachment.data)
        ? attachment.data
        : attachment.data
          ? Buffer.from(attachment.data)
          : null;
      insert.run(
        attachment.id ?? randomUUID(),
        emailId,
        optionalString(attachment.providerAttachmentId),
        optionalString(attachment.contentId),
        optionalString(attachment.filename) ?? "Attachment",
        optionalString(attachment.mimeType) ?? "application/octet-stream",
        Number.isFinite(attachment.size) ? attachment.size : data?.length ?? 0,
        optionalString(attachment.disposition),
        attachment.isInline ? 1 : 0,
        data,
        now
      );
    }

    this.db.prepare("UPDATE emails SET has_attachments = ? WHERE id = ?").run(attachments.length > 0 ? 1 : 0, emailId);
  }

  insertEmail(email) {
    this.db.prepare(`
      INSERT INTO emails (
        id, account_id, mailbox_id, provider_uid, thread_id, sender_name, sender_email,
        sender_avatar_url, recipients_json, cc_json, bcc_json, subject, snippet,
        body_text, body_html, rfc_message_id, in_reply_to, references_json,
        sent_at, received_at, is_read, is_starred, importance,
        has_attachments, tracking_id, opened_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      email.rfcMessageID ?? null,
      email.inReplyTo ?? null,
      JSON.stringify(email.references ?? []),
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

    if (Array.isArray(email.attachments)) {
      this.replaceEmailAttachments(email.id, email.attachments);
    }

    this.insertEmailFTS(email);
  }

  upsertProviderEmail(email) {
    const localDisplayName = this.displayNameForLocalUserEmail(email.senderEmail);
    let resolvedEmail = {
      ...email,
      senderName: localDisplayName || email.senderName,
      senderAvatarURL: optionalString(email.senderAvatarURL) || senderLogoURLForEmail(email.senderEmail)
    };
    const blockedRule = this.blockedSenderForEmail(resolvedEmail.accountId, resolvedEmail.senderEmail);
    if (blockedRule && this.canRouteBlockedEmailToSpam(resolvedEmail.mailboxId)) {
      resolvedEmail = {
        ...resolvedEmail,
        mailboxId: this.mailboxForRole(resolvedEmail.accountId, "spam").id
      };
    }
    const existing = resolvedEmail.providerUID
      ? this.db.prepare("SELECT id, mailbox_id AS mailboxId FROM emails WHERE account_id = ? AND provider_uid = ?").get(resolvedEmail.accountId, resolvedEmail.providerUID)
      : null;

      if (existing) {
        this.db.prepare(`
        UPDATE emails
        SET mailbox_id = ?, thread_id = ?, sender_name = ?, sender_email = ?,
            sender_avatar_url = ?, recipients_json = ?, cc_json = ?, bcc_json = ?,
            subject = ?, snippet = ?, body_text = ?, body_html = ?,
            rfc_message_id = ?, in_reply_to = ?, references_json = ?,
            sent_at = ?, received_at = ?, is_read = ?, is_starred = ?,
            importance = ?, has_attachments = ?
        WHERE id = ?
      `).run(
        resolvedEmail.mailboxId,
        resolvedEmail.threadId,
        resolvedEmail.senderName,
        resolvedEmail.senderEmail,
        resolvedEmail.senderAvatarURL,
        JSON.stringify(resolvedEmail.recipients ?? []),
        JSON.stringify(resolvedEmail.cc ?? []),
        JSON.stringify(resolvedEmail.bcc ?? []),
        resolvedEmail.subject,
        resolvedEmail.snippet,
        resolvedEmail.bodyText,
        resolvedEmail.bodyHTML,
        resolvedEmail.rfcMessageID ?? null,
        resolvedEmail.inReplyTo ?? null,
        JSON.stringify(resolvedEmail.references ?? []),
        resolvedEmail.sentAt,
        resolvedEmail.receivedAt,
        resolvedEmail.isRead ? 1 : 0,
        resolvedEmail.isStarred ? 1 : 0,
        resolvedEmail.importance ?? "normal",
        resolvedEmail.hasAttachments ? 1 : 0,
        existing.id
      );
      this.db.prepare("DELETE FROM email_fts WHERE email_id = ?").run(existing.id);
      this.insertEmailFTS({ ...resolvedEmail, id: existing.id });
      if (Array.isArray(resolvedEmail.attachments)) {
        this.replaceEmailAttachments(existing.id, resolvedEmail.attachments);
      }
      this.refreshMailboxUnread(existing.mailboxId);
      this.refreshMailboxUnread(resolvedEmail.mailboxId);
      return { ...this.getEmail(existing.id), wasNew: false };
    }

    this.insertEmail(resolvedEmail);
    this.refreshMailboxUnread(resolvedEmail.mailboxId);
    return { ...this.getEmail(resolvedEmail.id), wasNew: true };
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
      searchableBodyText(email)
    );
  }

  ensureSearchIndexVersion() {
    const version = this.getSetting("search.indexVersion", "0");
    if (version === SEARCH_INDEX_VERSION) return;
    this.rebuildEmailFTS();
    this.setSetting("search.indexVersion", SEARCH_INDEX_VERSION);
  }

  rebuildEmailFTS() {
    const rows = this.db.prepare(`
      SELECT id, account_id AS accountId, subject, sender_name AS senderName,
             sender_email AS senderEmail, recipients_json AS recipientsJSON,
             snippet, body_text AS bodyText, body_html AS bodyHTML
      FROM emails
    `).all();

    this.db.prepare("DELETE FROM email_fts").run();
    for (const row of rows) {
      this.insertEmailFTS({
        ...row,
        recipients: parseJSON(row.recipientsJSON, [])
      });
    }
  }

  refreshMailboxUnread(mailboxId) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM emails WHERE mailbox_id = ? AND is_read = 0").get(mailboxId);
    this.db.prepare("UPDATE mailboxes SET unread_count = ? WHERE id = ?").run(row.count, mailboxId);
  }

  blockedSenderForEmail(accountId, senderEmail) {
    const normalizedEmail = optionalString(senderEmail)?.toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) return null;
    const senderDomain = domainForEmail(normalizedEmail);
    return this.listBlockedSenders(accountId).find(rule => {
      if (rule.scope === "email") {
        return rule.value === normalizedEmail;
      }
      return senderDomain === rule.value || senderDomain.endsWith(`.${rule.value}`);
    }) ?? null;
  }

  canRouteBlockedEmailToSpam(mailboxId) {
    const role = this.mailboxRole(mailboxId);
    return role !== "sent" && role !== "drafts" && role !== "trash" && role !== "spam";
  }

  moveBlockedMessagesToSpam(accountId, scope, value) {
    const spamMailbox = this.mailboxForRole(accountId, "spam");
    const matchSQL = blockedSenderMatchSQL(scope);
    const matchArgs = blockedSenderMatchArgs(scope, value);
    const touchedMailboxes = this.db.prepare(`
      SELECT DISTINCT e.mailbox_id AS mailboxId
      FROM emails e
      JOIN mailboxes m ON m.id = e.mailbox_id
      WHERE e.account_id = ?
        AND m.role NOT IN ('sent', 'drafts', 'trash')
        AND ${matchSQL}
    `).all(accountId, ...matchArgs);
    const result = this.db.prepare(`
      UPDATE emails
      SET mailbox_id = ?
      WHERE id IN (
        SELECT e.id
        FROM emails e
        JOIN mailboxes m ON m.id = e.mailbox_id
        WHERE e.account_id = ?
          AND m.role NOT IN ('sent', 'drafts', 'trash')
          AND ${matchSQL}
      )
    `).run(spamMailbox.id, accountId, ...matchArgs);

    for (const mailbox of touchedMailboxes) {
      this.refreshMailboxUnread(mailbox.mailboxId);
    }
    this.refreshMailboxUnread(spamMailbox.id);
    return result.changes ?? 0;
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

function normalizeAppUser(user) {
  if (!user || typeof user !== "object") {
    throw httpError(401, "Authentication is required.");
  }
  const id = requiredString(user.id, "user.id");
  const email = optionalString(user.email)?.toLowerCase() ?? null;
  const displayName = optionalString(user.displayName) || email || "User";
  return { id, email, displayName };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw httpError(400, `${name} is required.`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBlockScope(value) {
  if (value !== "email" && value !== "domain") {
    throw httpError(400, "Block scope must be email or domain.");
  }
  return value;
}

function normalizeEmailAddress(value, name) {
  const email = requiredString(value, name).toLowerCase();
  if (!email.includes("@")) {
    throw httpError(400, `${name} must be an email address.`);
  }
  return email;
}

function normalizePushToken(value) {
  const token = requiredString(value, "token").toLowerCase();
  if (!/^[a-f0-9]{32,}$/u.test(token)) {
    throw httpError(400, "token must be a hex APNs device token.");
  }
  return token;
}

function normalizePushPlatform(value) {
  if (value !== "ios" && value !== "macos") {
    throw httpError(400, "platform must be ios or macos.");
  }
  return value;
}

function normalizePushEnvironment(value) {
  if (value !== "development" && value !== "production") {
    throw httpError(400, "environment must be development or production.");
  }
  return value;
}

function normalizeEmailForComparison(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/<([^<>@\s]+@[^<>\s]+)>/);
  const trimmed = (match?.[1] ?? value).trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  return trimmed.replace(/^mailto:/i, "");
}

function domainForEmail(value) {
  const email = normalizeEmailAddress(value, "senderEmail");
  const domain = email.split("@").at(-1)?.trim().toLowerCase() ?? "";
  if (!domain || !domain.includes(".")) {
    throw httpError(400, "Sender email must include a domain.");
  }
  return domain;
}

function blockedSenderMatchSQL(scope) {
  if (scope === "email") {
    return "lower(e.sender_email) = ?";
  }
  return "(lower(e.sender_email) LIKE ? OR lower(e.sender_email) LIKE ?)";
}

function blockedSenderMatchArgs(scope, value) {
  if (scope === "email") {
    return [value];
  }
  return [`%@${value}`, `%.${value}`];
}

function accountAvatarSelect(alias) {
  return `
    COALESCE(
      NULLIF(${alias}.avatar_url, ''),
      (
        SELECT e.sender_avatar_url
        FROM emails e
        WHERE e.account_id = ${alias}.id
          AND lower(e.sender_email) = lower(${alias}.email)
          AND e.sender_avatar_url IS NOT NULL
          AND e.sender_avatar_url <> ''
        ORDER BY e.received_at DESC
        LIMIT 1
      )
    ) AS avatarURL
  `;
}

function accountIdentityMatchSQL(emailAlias, accountAlias) {
  return `(
    lower(${emailAlias}.sender_email) = lower(${accountAlias}.email)
    OR lower(${emailAlias}.sender_email) IN (
      SELECT lower(l.provider_email)
      FROM account_user_links l
      WHERE l.account_id = ${emailAlias}.account_id
    )
  )`;
}

function makeRFCMessageID(email) {
  const domain = String(email).split("@").at(-1)?.trim().toLowerCase() || "dearly.local";
  const safeDomain = /^[a-z0-9.-]+$/u.test(domain) ? domain : "dearly.local";
  return `<${randomUUID()}@${safeDomain}>`;
}

function replyReferences(email) {
  if (!email) return [];
  const values = [...(email.references ?? [])];
  if (email.rfcMessageID) {
    values.push(email.rfcMessageID);
  }
  return [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
}

function uniqueStrings(values) {
  return [...new Set(values.map(item => String(item ?? "").trim()).filter(Boolean))];
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeFutureDate(value, fallbackMs) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now() + fallbackMs);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    return new Date(Date.now() + fallbackMs);
  }
  return date;
}

function dateString(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
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

function searchableBodyText(email) {
  return [
    optionalString(email.bodyText),
    htmlToSearchText(email.bodyHTML)
  ].filter(Boolean).join("\n");
}

function htmlToSearchText(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return decodeHTMLEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
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
    .replace(/&#39;/gu, "'");
}

function safeCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return " ";
  return String.fromCodePoint(codePoint);
}

function normalizeSearch(value) {
  if (typeof value !== "string") return "";
  const terms = Array.from(value.toLowerCase().matchAll(/[\p{L}\p{N}@._-]+/gu), match => match[0])
    .filter(term => term.length > 0)
    .slice(0, 8);
  return terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}
