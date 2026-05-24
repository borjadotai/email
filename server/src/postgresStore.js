import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { senderLogoURLForEmail } from "./logoResolver.js";
import { httpError } from "./store.js";

const { Pool } = pg;

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

export class PostgresMailStore {
  constructor({
    connectionString,
    pool,
    supabaseURL = "",
    supabaseServiceRoleKey = "",
    attachmentBucket = "email-attachments",
    storageClient = null
  } = {}) {
    if (!pool && !connectionString) {
      throw new Error("PostgresMailStore requires EMAIL_POSTGRES_URL or DATABASE_URL.");
    }
    this.pool = pool ?? new Pool({ connectionString });
    this.ownsPool = !pool;
    this.currentUser = null;
    this.storageName = "postgres";
    this.databasePath = "postgres";
    this.attachmentBucket = attachmentBucket;
    this.attachmentStorage = storageClient ?? storageClientFor({
      supabaseURL,
      supabaseServiceRoleKey,
      bucket: attachmentBucket
    });
  }

  forUser(user) {
    const scoped = Object.create(this);
    scoped.currentUser = normalizeAppUser(user);
    return scoped;
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async checkReadiness() {
    return {
      database: await this.checkDatabaseReadiness(),
      attachmentStorage: await this.checkAttachmentStorageReadiness()
    };
  }

  async checkDatabaseReadiness() {
    await this.pool.query("SELECT 1 AS ok");
    await this.assertRequiredRelations();
    return {
      engine: "postgres",
      path: this.databasePath
    };
  }

  async checkAttachmentStorageReadiness() {
    await this.assertAttachmentStorageReady();
    return {
      mode: "supabase-storage",
      bucket: this.attachmentBucket
    };
  }

  async getProfile() {
    const user = await this.ensureCurrentUser();
    return {
      ...user,
      accounts: await this.listAccounts()
    };
  }

  async createAccount(input) {
    const provider = normalizeProvider(input.provider);
    const email = requiredString(input.email, "email").toLowerCase();
    const displayName = input.displayName?.trim() || email;
    const userId = await this.currentUserId();
    const id = randomUUID();

    await this.transaction(async client => {
      await client.query(`
        INSERT INTO public.accounts (
          id, user_id, provider, provider_account_email, display_name, avatar_url,
          auth_type, status, sync_history, provider_metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      `, [
        id,
        userId,
        provider,
        email,
        displayName,
        optionalString(input.avatarURL),
        input.authType ?? "not_configured",
        input.status ?? "connected",
        input.syncHistory !== false,
        JSON.stringify(input.providerMetadata ?? {})
      ]);
      await this.ensureDefaultsForAccount(id, client);
    });

    return await this.getAccount(id);
  }

  async createOrUpdateAccount(input) {
    const provider = normalizeProvider(input.provider);
    const email = requiredString(input.email, "email").toLowerCase();
    const displayName = input.displayName?.trim() || email;
    const userId = await this.currentUserId();

    const result = await this.pool.query(`
      INSERT INTO public.accounts (
        user_id, provider, provider_account_email, display_name, avatar_url,
        auth_type, status, sync_history, last_sync_at, provider_metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (user_id, provider, provider_account_email) DO UPDATE SET
        display_name = excluded.display_name,
        avatar_url = COALESCE(excluded.avatar_url, public.accounts.avatar_url),
        auth_type = excluded.auth_type,
        status = excluded.status,
        sync_history = excluded.sync_history,
        last_sync_at = COALESCE(excluded.last_sync_at, public.accounts.last_sync_at),
        provider_metadata = excluded.provider_metadata
      RETURNING id
    `, [
      userId,
      provider,
      email,
      displayName,
      optionalString(input.avatarURL),
      input.authType ?? "not_configured",
      input.status ?? "connected",
      input.syncHistory !== false,
      input.lastSyncAt ?? null,
      JSON.stringify(input.providerMetadata ?? {})
    ]);
    const accountId = result.rows[0].id;
    await this.ensureDefaultsForAccount(accountId);
    return await this.getAccount(accountId);
  }

  async listAccounts() {
    const result = await this.pool.query(`
      SELECT id, provider, provider_account_email AS email, display_name AS "displayName",
             avatar_url AS "avatarURL", auth_type AS "authType", status,
             sync_history AS "syncHistory", last_sync_at AS "lastSyncAt",
             provider_metadata AS "providerMetadata", created_at AS "createdAt"
      FROM public.accounts
      WHERE user_id = $1
      ORDER BY created_at ASC
    `, [await this.currentUserId()]);
    return result.rows.map(mapAccountRow);
  }

  async listSyncableAccounts({ staleBefore = null, limit = 100 } = {}) {
    const args = [clampInt(limit, 1, 500, 100)];
    let staleSQL = "";
    if (staleBefore) {
      args.push(dateString(staleBefore));
      staleSQL = `AND (a.last_sync_at IS NULL OR a.last_sync_at <= $${args.length})`;
    }
    const result = await this.pool.query(`
      SELECT a.id, a.provider, a.provider_account_email AS email,
             a.display_name AS "displayName", a.avatar_url AS "avatarURL",
             a.auth_type AS "authType", a.status, a.sync_history AS "syncHistory",
             a.last_sync_at AS "lastSyncAt", a.provider_metadata AS "providerMetadata",
             a.created_at AS "createdAt",
             u.id AS "userId", u.primary_email AS "userEmail", u.display_name AS "userDisplayName"
      FROM public.accounts a
      JOIN public.app_users u ON u.id = a.user_id
      WHERE a.status = 'connected'
        ${staleSQL}
      ORDER BY COALESCE(a.last_sync_at, '1970-01-01'::timestamptz) ASC, a.created_at ASC
      LIMIT $1
    `, args);
    return result.rows.map(row => ({
      ...mapAccountRow(row),
      user: {
        id: row.userId,
        email: row.userEmail ? String(row.userEmail) : null,
        displayName: row.userDisplayName
      }
    }));
  }

  async getAccount(id) {
    const result = await this.pool.query(`
      SELECT id, provider, provider_account_email AS email, display_name AS "displayName",
             avatar_url AS "avatarURL", auth_type AS "authType", status,
             sync_history AS "syncHistory", last_sync_at AS "lastSyncAt",
             provider_metadata AS "providerMetadata", created_at AS "createdAt"
      FROM public.accounts
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `, [id, await this.currentUserId()]);
    return result.rows[0] ? mapAccountRow(result.rows[0]) : null;
  }

  async claimUserIdentity(input) {
    const email = requiredString(input.email, "email").toLowerCase();
    const displayName = input.displayName?.trim() || email;
    const user = await this.ensureCurrentUser();
    await this.pool.query(`
      UPDATE public.app_users
      SET display_name = $1, primary_email = COALESCE(primary_email, $2)
      WHERE id = $3
    `, [displayName, email, user.id]);
    return await this.getProfile();
  }

  async ensureCurrentUser() {
    if (!this.currentUser) {
      throw httpError(401, "Authentication is required.");
    }
    await this.pool.query(`
      INSERT INTO public.app_users (id, display_name, primary_email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_email = COALESCE(public.app_users.primary_email, excluded.primary_email)
    `, [this.currentUser.id, this.currentUser.displayName, this.currentUser.email]);

    const result = await this.pool.query(`
      SELECT id, display_name AS "displayName", primary_email AS "primaryEmail",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM public.app_users
      WHERE id = $1
    `, [this.currentUser.id]);
    return mapUserRow(result.rows[0]);
  }

  async currentUserId() {
    return (await this.ensureCurrentUser()).id;
  }

  async saveProviderAuthSession(input) {
    const provider = normalizeProvider(input.provider);
    if (provider !== "gmail") throw httpError(400, "Provider auth sessions only support gmail.");
    const state = requiredString(input.state, "state");
    const codeVerifier = requiredString(input.codeVerifier, "codeVerifier");
    const rawUser = input.user ?? this.currentUser;
    const user = normalizeAppUser(rawUser);
    if (rawUser?.isLocal === true) {
      throw httpError(400, "Postgres provider auth sessions require an authenticated Supabase user.");
    }
    const scoped = this.currentUser ? this : this.forUser(user);
    await scoped.ensureCurrentUser();
    await this.pool.query("DELETE FROM email_private.provider_auth_sessions WHERE expires_at <= timezone('utc', now())");
    await this.pool.query(`
      INSERT INTO email_private.provider_auth_sessions (
        state, user_id, provider, code_verifier, display_name, sync_history, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(state) DO UPDATE SET
        user_id = excluded.user_id,
        provider = excluded.provider,
        code_verifier = excluded.code_verifier,
        display_name = excluded.display_name,
        sync_history = excluded.sync_history,
        created_at = timezone('utc', now()),
        expires_at = excluded.expires_at
    `, [
      state,
      user.id,
      provider,
      codeVerifier,
      optionalString(input.displayName) ?? "",
      input.syncHistory !== false,
      normalizeFutureDate(input.expiresAt, 10 * 60 * 1000).toISOString()
    ]);
  }

  async consumeProviderAuthSession(input) {
    const state = requiredString(input.state, "state");
    const provider = normalizeProvider(input.provider);
    await this.pool.query("DELETE FROM email_private.provider_auth_sessions WHERE expires_at <= timezone('utc', now())");
    const result = await this.pool.query(`
      WITH deleted AS (
        DELETE FROM email_private.provider_auth_sessions
        WHERE state = $1 AND provider = $2
        RETURNING state, provider, code_verifier, display_name, sync_history, created_at, expires_at, user_id
      )
      SELECT deleted.state, deleted.provider, deleted.code_verifier AS "codeVerifier",
             deleted.display_name AS "displayName", deleted.sync_history AS "syncHistory",
             deleted.created_at AS "createdAt", deleted.expires_at AS "expiresAt",
             u.id AS "userId", u.primary_email AS "userEmail", u.display_name AS "userDisplayName"
      FROM deleted
      JOIN public.app_users u ON u.id = deleted.user_id
    `, [state, provider]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      state: row.state,
      provider: row.provider,
      codeVerifier: row.codeVerifier,
      displayName: row.displayName,
      syncHistory: Boolean(row.syncHistory),
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      user: {
        id: row.userId,
        email: row.userEmail ? String(row.userEmail) : null,
        displayName: row.userDisplayName
      }
    };
  }

  async isLocalUserEmail(email) {
    const normalized = normalizeEmailForComparison(email);
    if (!normalized) return false;
    const result = await this.pool.query(`
      SELECT 1
      FROM public.accounts
      WHERE user_id = $1 AND lower(provider_account_email::text) = $2
      LIMIT 1
    `, [await this.currentUserId(), normalized]);
    return result.rowCount > 0;
  }

  async isAccountIdentityEmail(accountId, email) {
    const normalized = normalizeEmailForComparison(email);
    if (!normalized) return false;
    const result = await this.pool.query(`
      SELECT 1
      FROM public.accounts
      WHERE id = $1 AND user_id = $2 AND lower(provider_account_email::text) = $3
      LIMIT 1
    `, [accountId, await this.currentUserId(), normalized]);
    return result.rowCount > 0;
  }

  async displayNameForLocalUserEmail(email) {
    const normalized = normalizeEmailForComparison(email);
    if (!normalized) return null;
    const result = await this.pool.query(`
      SELECT display_name AS "displayName"
      FROM public.accounts
      WHERE user_id = $1 AND lower(provider_account_email::text) = $2
      LIMIT 1
    `, [await this.currentUserId(), normalized]);
    return result.rows[0]?.displayName ?? null;
  }

  async updateAccountStatus(id, status, metadata = null) {
    const account = await this.getAccount(id);
    if (!account) return null;
    const nextMetadata = metadata ? { ...account.providerMetadata, ...metadata } : account.providerMetadata;
    await this.pool.query(`
      UPDATE public.accounts
      SET status = $1, provider_metadata = $2::jsonb
      WHERE id = $3 AND user_id = $4
    `, [status, JSON.stringify(nextMetadata), id, await this.currentUserId()]);
    return await this.getAccount(id);
  }

  async updateAccountSettings(id, input = {}) {
    const account = await this.getAccount(id);
    if (!account) return null;
    const displayName = optionalString(input.displayName) ?? account.displayName;
    const avatarURL = Object.hasOwn(input, "avatarURL") ? optionalString(input.avatarURL) : account.avatarURL;
    const syncHistory = typeof input.syncHistory === "boolean" ? input.syncHistory : account.syncHistory;
    await this.pool.query(`
      UPDATE public.accounts
      SET display_name = $1, avatar_url = $2, sync_history = $3
      WHERE id = $4 AND user_id = $5
    `, [displayName, avatarURL, syncHistory, id, await this.currentUserId()]);
    if (displayName !== account.displayName) {
      await this.pool.query(`
        UPDATE public.emails
        SET sender_name = $1
        WHERE user_id = $2 AND account_id = $3 AND lower(sender_email::text) = lower($4)
      `, [displayName, await this.currentUserId(), id, account.email]);
    }
    return await this.getAccount(id);
  }

  async markAccountSynced(id, metadata = null) {
    const account = await this.getAccount(id);
    if (!account) return null;
    const nextMetadata = metadata ? { ...account.providerMetadata, ...metadata } : account.providerMetadata;
    await this.pool.query(`
      UPDATE public.accounts
      SET status = 'connected', last_sync_at = timezone('utc', now()), provider_metadata = $1::jsonb
      WHERE id = $2 AND user_id = $3
    `, [JSON.stringify(nextMetadata), id, await this.currentUserId()]);
    return await this.getAccount(id);
  }

  async updateAccountMetadata(id, metadata) {
    const account = await this.getAccount(id);
    if (!account) return null;
    const nextMetadata = { ...account.providerMetadata, ...metadata };
    await this.pool.query(`
      UPDATE public.accounts
      SET provider_metadata = $1::jsonb
      WHERE id = $2 AND user_id = $3
    `, [JSON.stringify(nextMetadata), id, await this.currentUserId()]);
    return await this.getAccount(id);
  }

  async listMailboxes(accountId = null) {
    const args = [await this.currentUserId()];
    let accountFilter = "";
    if (accountId) {
      args.push(accountId);
      accountFilter = `AND m.account_id = $${args.length}`;
    }
    const result = await this.pool.query(`
      SELECT m.id, m.account_id AS "accountId", a.provider_account_email AS "accountEmail",
             m.name, m.role, m.unread_count AS "unreadCount"
      FROM public.mailboxes m
      JOIN public.accounts a ON a.id = m.account_id
      WHERE m.user_id = $1 ${accountFilter}
      ORDER BY a.created_at ASC,
        CASE m.role
          WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 WHEN 'drafts' THEN 2
          WHEN 'archive' THEN 3 WHEN 'spam' THEN 4 WHEN 'trash' THEN 5 ELSE 9
        END
    `, args);
    return result.rows.map(mapMailboxRow);
  }

  async listLabels(accountId = null) {
    const args = [await this.currentUserId()];
    let accountFilter = "";
    if (accountId) {
      args.push(accountId);
      accountFilter = `AND (l.account_id IS NULL OR l.account_id = $${args.length})`;
    }
    const result = await this.pool.query(`
      SELECT l.id, l.account_id AS "accountId", a.provider_account_email AS "accountEmail",
             l.name, l.color, l.is_system AS "isSystem"
      FROM public.labels l
      LEFT JOIN public.accounts a ON a.id = l.account_id
      WHERE l.user_id = $1 ${accountFilter}
      ORDER BY l.is_system DESC, l.name ASC
    `, args);
    return result.rows.map(mapLabelRow);
  }

  async createLabel(input) {
    const name = requiredString(input.name, "name");
    const accountId = input.accountId ?? null;
    const userId = await this.currentUserId();
    if (accountId && !await this.getAccount(accountId)) {
      throw httpError(404, "Account not found.");
    }
    const result = await this.pool.query(`
      INSERT INTO public.labels (user_id, account_id, name, color, is_system)
      VALUES ($1, $2, $3, $4, false)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [userId, accountId, name, input.color ?? "gray"]);
    if (result.rows[0]?.id) {
      return (await this.listLabels(accountId)).find(label => label.id === result.rows[0].id);
    }
    return await this.findOrCreateLabel(input);
  }

  async findOrCreateLabel(input) {
    const name = requiredString(input.name, "name");
    const accountId = input.accountId ?? null;
    const args = [await this.currentUserId(), name.toLowerCase()];
    let accountSQL = "account_id IS NULL";
    if (accountId) {
      if (!await this.getAccount(accountId)) {
        throw httpError(404, "Account not found.");
      }
      args.push(accountId);
      accountSQL = `account_id = $${args.length}`;
    }
    const existing = await this.pool.query(`
      SELECT id
      FROM public.labels
      WHERE user_id = $1 AND lower(name) = $2 AND ${accountSQL}
      LIMIT 1
    `, args);
    if (existing.rows[0]) {
      return (await this.listLabels(accountId)).find(label => label.id === existing.rows[0].id);
    }
    return await this.createLabel({ accountId, name, color: input.color ?? "gray" });
  }

  async listEmails(filters = {}) {
    const limit = clampInt(filters.limit, 1, 200, 80);
    const offset = clampInt(filters.offset, 0, 100000, 0);
    const joins = [
      "JOIN public.accounts a ON a.id = e.account_id",
      "JOIN public.mailboxes m ON m.id = e.mailbox_id"
    ];
    const where = ["e.user_id = $1"];
    const args = [await this.currentUserId()];
    const search = normalizePostgresSearch(filters.q);
    if (search) {
      args.push(search);
      where.push(`e.search_vector @@ websearch_to_tsquery('simple', $${args.length})`);
    }
    if (filters.accountId) {
      args.push(filters.accountId);
      where.push(`e.account_id = $${args.length}`);
    }
    if (filters.mailboxId) {
      args.push(filters.mailboxId);
      where.push(`e.mailbox_id = $${args.length}`);
    }
    if (filters.mailboxRole) {
      args.push(filters.mailboxRole);
      where.push(`m.role = $${args.length}`);
    }
    if (filters.labelId) {
      joins.push("JOIN public.email_labels filter_labels ON filter_labels.email_id = e.id");
      args.push(filters.labelId);
      where.push(`filter_labels.label_id = $${args.length}`);
    }
    if (filters.unread === "1" || filters.unread === true) {
      where.push("e.is_read = false");
    }
    args.push(limit, offset);
    const result = await this.pool.query(`
      SELECT e.id, e.account_id AS "accountId", a.provider_account_email AS "accountEmail", a.provider,
             e.mailbox_id AS "mailboxId", m.name AS "mailboxName", m.role AS "mailboxRole",
             e.sender_name AS "senderName", e.sender_email AS "senderEmail",
             e.sender_avatar_url AS "senderAvatarURL", e.subject, e.snippet,
             e.received_at AS "receivedAt", e.sent_at AS "sentAt",
             e.is_read AS "isRead", e.is_starred AS "isStarred",
             e.importance, e.has_attachments AS "hasAttachments",
             e.tracking_id AS "trackingId", e.opened_at AS "openedAt"
      FROM public.emails e
      ${joins.join("\n")}
      WHERE ${where.join(" AND ")}
      ORDER BY e.received_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}
    `, args);
    return await Promise.all(result.rows.map(async row => ({
      ...mapEmailSummaryRow(row),
      labels: await this.labelsForEmail(row.id)
    })));
  }

  async getEmail(id, options = {}) {
    const args = [id];
    let userFilter = "";
    if (options.unscoped !== true) {
      args.push(await this.currentUserId());
      userFilter = `AND e.user_id = $${args.length}`;
    }
    const result = await this.pool.query(`
      SELECT e.id, e.user_id AS "userId", e.account_id AS "accountId",
             a.provider_account_email AS "accountEmail", a.provider,
             e.mailbox_id AS "mailboxId", m.name AS "mailboxName", m.role AS "mailboxRole",
             e.provider_uid AS "providerUID", e.thread_id AS "threadId",
             e.sender_name AS "senderName", e.sender_email AS "senderEmail",
             e.sender_avatar_url AS "senderAvatarURL",
             e.recipients_json AS recipients, e.cc_json AS cc, e.bcc_json AS bcc,
             e.subject, e.snippet, e.body_text AS "bodyText", e.body_html AS "bodyHTML",
             e.rfc_message_id AS "rfcMessageID", e.in_reply_to AS "inReplyTo",
             e.references_json AS "references", e.received_at AS "receivedAt",
             e.sent_at AS "sentAt", e.is_read AS "isRead", e.is_starred AS "isStarred",
             e.importance, e.has_attachments AS "hasAttachments",
             e.tracking_id AS "trackingId", e.opened_at AS "openedAt", e.created_at AS "createdAt"
      FROM public.emails e
      JOIN public.accounts a ON a.id = e.account_id
      JOIN public.mailboxes m ON m.id = e.mailbox_id
      WHERE e.id = $1 ${userFilter}
      LIMIT 1
    `, args);
    const row = result.rows[0];
    if (!row) return null;
    const ownerUserId = options.unscoped === true ? row.userId : null;
    return {
      ...mapEmailDetailRow(row),
      labels: await this.labelsForEmail(row.id, ownerUserId),
      attachments: await this.attachmentsForEmail(row.id, ownerUserId)
    };
  }

  async listThreadEmails(emailId) {
    const anchor = await this.getEmail(emailId);
    if (!anchor) return null;
    const ids = new Set([anchor.id]);
    if (anchor.threadId) {
      const rows = await this.pool.query(`
        SELECT id
        FROM public.emails
        WHERE user_id = $1 AND account_id = $2 AND thread_id = $3
      `, [await this.currentUserId(), anchor.accountId, anchor.threadId]);
      for (const row of rows.rows) ids.add(row.id);
    }
    const keys = uniqueStrings([anchor.rfcMessageID, anchor.inReplyTo, ...anchor.references]);
    if (keys.length > 0) {
      const rows = await this.pool.query(`
        SELECT DISTINCT id
        FROM public.emails
        WHERE user_id = $1
          AND (
            rfc_message_id = ANY($2::text[])
            OR in_reply_to = ANY($2::text[])
            OR references_json ?| $2::text[]
          )
      `, [await this.currentUserId(), keys]);
      for (const row of rows.rows) ids.add(row.id);
    }
    const emails = (await Promise.all([...ids].map(id => this.getEmail(id)))).filter(Boolean);
    return emails.sort(compareEmailTimeAscending);
  }

  async updateEmail(id, patch) {
    const existing = await this.getEmail(id);
    if (!existing) return null;
    if (typeof patch.isRead === "boolean") {
      await this.pool.query("UPDATE public.emails SET is_read = $1 WHERE id = $2 AND user_id = $3", [patch.isRead, id, await this.currentUserId()]);
      await this.refreshMailboxUnread(existing.mailboxId);
    }
    if (typeof patch.isStarred === "boolean") {
      await this.pool.query("UPDATE public.emails SET is_starred = $1 WHERE id = $2 AND user_id = $3", [patch.isStarred, id, await this.currentUserId()]);
    }
    if (typeof patch.mailboxId === "string" && patch.mailboxId !== existing.mailboxId) {
      const mailbox = await this.mailboxById(patch.mailboxId);
      if (!mailbox) throw httpError(404, "Mailbox not found.");
      if (mailbox.accountId !== existing.accountId) {
        throw httpError(400, "Emails can only move to folders in the same account.");
      }
      await this.pool.query("UPDATE public.emails SET mailbox_id = $1 WHERE id = $2 AND user_id = $3", [patch.mailboxId, id, await this.currentUserId()]);
      await this.refreshMailboxUnread(existing.mailboxId);
      await this.refreshMailboxUnread(patch.mailboxId);
    }
    return await this.getEmail(id);
  }

  async markEmailSpam(id) {
    return await this.moveEmailToRole(id, "spam");
  }

  async archiveEmail(id) {
    return await this.moveEmailToRole(id, "archive");
  }

  async trashEmail(id) {
    return await this.moveEmailToRole(id, "trash");
  }

  async listBlockedSenders(accountId = null) {
    const args = [await this.currentUserId()];
    let accountFilter = "";
    if (accountId) {
      args.push(accountId);
      accountFilter = `AND b.account_id = $${args.length}`;
    }
    const result = await this.pool.query(`
      SELECT b.id, b.account_id AS "accountId", a.provider_account_email AS "accountEmail",
             b.scope, b.value, b.source_email_id AS "sourceEmailId", b.created_at AS "createdAt"
      FROM public.blocked_senders b
      JOIN public.accounts a ON a.id = b.account_id
      WHERE b.user_id = $1 ${accountFilter}
      ORDER BY b.created_at DESC
    `, args);
    return result.rows.map(row => ({ ...row, value: String(row.value), createdAt: iso(row.createdAt) }));
  }

  async registerPushToken(input = {}) {
    const token = normalizePushToken(input.token);
    const platform = normalizePushPlatform(input.platform);
    const bundleId = requiredString(input.bundleId ?? input.bundleID, "bundleId");
    const environment = normalizePushEnvironment(input.environment);
    const result = await this.pool.query(`
      INSERT INTO public.push_tokens (
        user_id, token, platform, bundle_id, environment, device_name, last_seen_at, disabled_at, failure_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, timezone('utc', now()), NULL, NULL)
      ON CONFLICT(token, bundle_id, environment) DO UPDATE SET
        user_id = excluded.user_id,
        platform = excluded.platform,
        device_name = excluded.device_name,
        last_seen_at = excluded.last_seen_at,
        disabled_at = NULL,
        failure_reason = NULL
      RETURNING id, token, platform, bundle_id AS "bundleId", environment,
                device_name AS "deviceName", created_at AS "createdAt",
                updated_at AS "updatedAt", last_seen_at AS "lastSeenAt",
                disabled_at AS "disabledAt", failure_reason AS "failureReason"
    `, [await this.currentUserId(), token, platform, bundleId, environment, optionalString(input.deviceName)]);
    return mapPushTokenRow(result.rows[0]);
  }

  async listPushTokens(filters = {}) {
    const args = [await this.currentUserId()];
    const where = ["user_id = $1", "disabled_at IS NULL"];
    if (filters.platform) {
      args.push(normalizePushPlatform(filters.platform));
      where.push(`platform = $${args.length}`);
    }
    if (filters.environment) {
      args.push(normalizePushEnvironment(filters.environment));
      where.push(`environment = $${args.length}`);
    }
    const result = await this.pool.query(`
      SELECT id, token, platform, bundle_id AS "bundleId", environment,
             device_name AS "deviceName", created_at AS "createdAt",
             updated_at AS "updatedAt", last_seen_at AS "lastSeenAt"
      FROM public.push_tokens
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
    `, args);
    return result.rows.map(mapPushTokenRow);
  }

  async disablePushToken(id, reason = "disabled") {
    await this.pool.query(`
      UPDATE public.push_tokens
      SET disabled_at = timezone('utc', now()), failure_reason = $1
      WHERE id = $2 AND user_id = $3
    `, [String(reason), id, await this.currentUserId()]);
  }

  async inboxUnreadCount() {
    const result = await this.pool.query(`
      SELECT COALESCE(SUM(unread_count), 0)::int AS count
      FROM public.mailboxes
      WHERE user_id = $1 AND role = 'inbox'
    `, [await this.currentUserId()]);
    return result.rows[0]?.count ?? 0;
  }

  async blockSenderForEmail(emailId, scope) {
    const email = await this.getEmail(emailId);
    if (!email) return null;
    const normalizedScope = normalizeBlockScope(scope);
    const value = normalizedScope === "email"
      ? normalizeEmailAddress(email.senderEmail, "senderEmail")
      : domainForEmail(email.senderEmail);
    const result = await this.pool.query(`
      INSERT INTO public.blocked_senders (user_id, account_id, scope, value, source_email_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(account_id, scope, value) DO UPDATE SET source_email_id = excluded.source_email_id
      RETURNING id, account_id AS "accountId", scope, value, source_email_id AS "sourceEmailId", created_at AS "createdAt"
    `, [await this.currentUserId(), email.accountId, normalizedScope, value, email.id]);
    const affectedCount = await this.moveBlockedMessagesToSpam(email.accountId, normalizedScope, value);
    return {
      rule: { ...result.rows[0], accountEmail: email.accountEmail, value: String(result.rows[0].value), createdAt: iso(result.rows[0].createdAt) },
      affectedCount,
      email: await this.getEmail(email.id)
    };
  }

  async setEmailLabel(emailId, labelId, action = "add") {
    const email = await this.getEmail(emailId);
    if (!email) return null;
    const result = await this.pool.query(`
      SELECT id, account_id AS "accountId"
      FROM public.labels
      WHERE id = $1 AND user_id = $2 AND (account_id IS NULL OR account_id = $3)
      LIMIT 1
    `, [labelId, await this.currentUserId(), email.accountId]);
    if (!result.rows[0]) throw httpError(404, "Label not found.");
    if (action === "remove") {
      await this.pool.query("DELETE FROM public.email_labels WHERE user_id = $1 AND email_id = $2 AND label_id = $3", [await this.currentUserId(), emailId, labelId]);
    } else {
      await this.pool.query(`
        INSERT INTO public.email_labels (user_id, email_id, label_id)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `, [await this.currentUserId(), emailId, labelId]);
    }
    return await this.getEmail(emailId);
  }

  async sendMessage(input) {
    const accountId = requiredString(input.accountId, "accountId");
    const account = await this.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");
    const replyToEmailID = optionalString(input.replyToEmailID ?? input.replyToEmailId);
    const replyToEmail = replyToEmailID ? await this.getEmail(replyToEmailID) : null;
    if (replyToEmailID && !replyToEmail) throw httpError(404, "Reply target not found.");
    if (replyToEmail && replyToEmail.accountId !== accountId) {
      throw httpError(400, "Replies must be sent from the account that owns the conversation.");
    }

    const sentMailbox = await this.mailboxForRole(accountId, "sent");
    const emailId = randomUUID();
    const outboundId = randomUUID();
    const trackingId = input.trackOpens === false ? null : randomUUID();
    const now = new Date().toISOString();
    const bodyText = input.bodyText?.trim() || "";
    const email = {
      id: emailId,
      accountId,
      mailboxId: sentMailbox.id,
      providerUID: null,
      threadId: replyToEmail?.threadId ?? input.threadId ?? randomUUID(),
      senderName: account.displayName,
      senderEmail: account.email,
      senderAvatarURL: account.avatarURL || senderLogoURLForEmail(account.email),
      recipients: normalizeAddressList(input.to),
      cc: normalizeAddressList(input.cc),
      bcc: normalizeAddressList(input.bcc),
      subject: input.subject?.trim() || "(No subject)",
      snippet: bodyText.replace(/\s+/g, " ").slice(0, 180),
      bodyText,
      bodyHTML: input.bodyHTML ?? null,
      rfcMessageID: makeRFCMessageID(account.email),
      inReplyTo: replyToEmail?.rfcMessageID ?? null,
      references: replyReferences(replyToEmail),
      sentAt: now,
      receivedAt: now,
      isRead: true,
      isStarred: false,
      importance: "normal",
      hasAttachments: false,
      trackingId,
      openedAt: null,
      createdAt: now
    };
    await this.transaction(async client => {
      await this.insertEmail(email, client);
      await client.query(`
        INSERT INTO public.outbound_messages (id, user_id, email_id, account_id, status)
        VALUES ($1, $2, $3, $4, 'queued')
      `, [outboundId, await this.currentUserId(), emailId, accountId]);
    });
    return { ...await this.getEmail(emailId), outboundId, outboundStatus: "queued" };
  }

  async markOutboundSent(outboundId, providerUID = null) {
    await this.pool.query(`
      UPDATE public.outbound_messages
      SET status = 'sent', sent_at = timezone('utc', now()), error = NULL
      WHERE id = $1 AND user_id = $2
    `, [outboundId, await this.currentUserId()]);
    if (providerUID) {
      await this.pool.query(`
        UPDATE public.emails e
        SET provider_uid = $1
        FROM public.outbound_messages o
        WHERE o.email_id = e.id AND o.id = $2 AND o.user_id = $3
      `, [providerUID, outboundId, await this.currentUserId()]);
    }
  }

  async markOutboundFailed(outboundId, error) {
    await this.pool.query(`
      UPDATE public.outbound_messages
      SET status = 'failed', error = $1
      WHERE id = $2 AND user_id = $3
    `, [String(error?.message ?? error), outboundId, await this.currentUserId()]);
  }

  async recordOpen(trackingId, meta = {}) {
    const result = await this.pool.query(`
      SELECT id, user_id AS "userId", opened_at AS "openedAt"
      FROM public.emails
      WHERE tracking_id = $1
      LIMIT 1
    `, [trackingId]);
    const email = result.rows[0];
    if (!email) return null;
    await this.transaction(async client => {
      if (!email.openedAt) {
        await client.query("UPDATE public.emails SET opened_at = timezone('utc', now()) WHERE id = $1", [email.id]);
      }
      await client.query(`
        INSERT INTO public.open_events (user_id, email_id, tracking_id, user_agent, remote_addr)
        VALUES ($1, $2, $3, $4, NULLIF($5, '')::inet)
      `, [email.userId, email.id, trackingId, meta.userAgent ?? null, meta.remoteAddr ?? null]);
    });
    return { ...await this.getEmail(email.id, { unscoped: true }), userId: email.userId };
  }

  async mailboxForRole(accountId, role) {
    const result = await this.pool.query(`
      SELECT id, name, role, account_id AS "accountId"
      FROM public.mailboxes
      WHERE account_id = $1 AND user_id = $2 AND role = $3
      LIMIT 1
    `, [accountId, await this.currentUserId(), role]);
    if (!result.rows[0]) throw httpError(404, `Mailbox ${role} not found.`);
    return mapMailboxRow(result.rows[0]);
  }

  async mailboxById(id) {
    const result = await this.pool.query(`
      SELECT id, account_id AS "accountId", name, role
      FROM public.mailboxes
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `, [id, await this.currentUserId()]);
    return result.rows[0] ? mapMailboxRow(result.rows[0]) : null;
  }

  async mailboxRole(mailboxId) {
    return (await this.mailboxById(mailboxId))?.role ?? null;
  }

  async labelsForEmail(emailId, userId = null) {
    const ownerUserId = userId ?? await this.currentUserId();
    const result = await this.pool.query(`
      SELECT l.id, l.account_id AS "accountId", l.name, l.color, l.is_system AS "isSystem"
      FROM public.labels l
      JOIN public.email_labels el ON el.label_id = l.id
      WHERE el.email_id = $1 AND el.user_id = $2
      ORDER BY l.name ASC
    `, [emailId, ownerUserId]);
    return result.rows.map(mapLabelRow);
  }

  async attachmentsForEmail(emailId, userId = null) {
    const ownerUserId = userId ?? await this.currentUserId();
    const result = await this.pool.query(`
      SELECT id, email_id AS "emailId", filename, mime_type AS "mimeType", size,
             disposition, is_inline AS "isInline", content_id AS "contentId",
             storage_status = 'stored' AS "isDownloaded"
      FROM public.email_attachments
      WHERE email_id = $1 AND user_id = $2
      ORDER BY is_inline ASC, filename ASC
    `, [emailId, ownerUserId]);
    return result.rows.map(mapAttachmentRow);
  }

  async getAttachment(emailId, attachmentId) {
    const result = await this.pool.query(`
      SELECT id, email_id AS "emailId", filename, mime_type AS "mimeType", size,
             disposition, is_inline AS "isInline", content_id AS "contentId",
             storage_bucket AS "storageBucket", storage_path AS "storagePath"
      FROM public.email_attachments
      WHERE email_id = $1 AND id = $2 AND user_id = $3
      LIMIT 1
    `, [emailId, attachmentId, await this.currentUserId()]);
    const row = result.rows[0];
    if (!row) return null;
    const data = row.storagePath ? await this.downloadAttachmentObject(row.storagePath) : null;
    return { ...mapAttachmentRow(row), data };
  }

  async replaceEmailAttachments(emailId, attachments = [], client = null) {
    const writeAttachments = async db => {
      const userId = await this.currentUserId();
      await db.query("DELETE FROM public.email_attachments WHERE email_id = $1 AND user_id = $2", [emailId, userId]);
      for (const attachment of attachments) {
        const id = attachment.id ?? randomUUID();
        const filename = optionalString(attachment.filename) ?? "Attachment";
        const mimeType = optionalString(attachment.mimeType) ?? "application/octet-stream";
        const data = attachment.data ? Buffer.from(attachment.data) : null;
        const storagePath = data ? attachmentObjectPath(userId, emailId, id, filename) : null;
        if (data && storagePath) {
          await this.uploadAttachmentObject(storagePath, data, mimeType);
        }
        await db.query(`
          INSERT INTO public.email_attachments (
            id, user_id, email_id, provider_attachment_id, content_id, filename, mime_type,
            size, disposition, is_inline, storage_status, storage_bucket, storage_path
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
          id,
          userId,
          emailId,
          optionalString(attachment.providerAttachmentId),
          optionalString(attachment.contentId),
          filename,
          mimeType,
          Number.isFinite(attachment.size) ? attachment.size : data?.length ?? 0,
          optionalString(attachment.disposition),
          attachment.isInline === true,
          data ? "stored" : "remote_only",
          data ? this.attachmentBucket : null,
          storagePath
        ]);
      }
      await db.query("UPDATE public.emails SET has_attachments = $1 WHERE id = $2 AND user_id = $3", [attachments.length > 0, emailId, userId]);
    };
    if (client) {
      await writeAttachments(client);
      return;
    }
    await this.transaction(writeAttachments);
  }

  async uploadAttachmentObject(path, data, mimeType) {
    if (!this.attachmentStorage) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to store hosted attachment bytes.");
    }
    const { error } = await this.attachmentStorage.upload(path, data, {
      contentType: mimeType,
      upsert: true
    });
    if (error) {
      throw new Error(`Failed to upload attachment object: ${error.message ?? error}`);
    }
  }

  async downloadAttachmentObject(path) {
    if (!this.attachmentStorage) return null;
    const { data, error } = await this.attachmentStorage.download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  async insertEmail(email, client = null) {
    const db = client ?? this.pool;
    await db.query(`
      INSERT INTO public.emails (
        id, user_id, account_id, mailbox_id, provider_uid, thread_id, sender_name, sender_email,
        sender_avatar_url, recipients_json, cc_json, bcc_json, subject, snippet,
        body_text, body_html, rfc_message_id, in_reply_to, references_json,
        sent_at, received_at, is_read, is_starred, importance,
        has_attachments, tracking_id, opened_at, created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14,
        $15, $16, $17, $18, $19::jsonb,
        $20, $21, $22, $23, $24, $25, $26, $27, $28
      )
    `, emailInsertParams(email, await this.currentUserId()));
    if (Array.isArray(email.attachments)) {
      await this.replaceEmailAttachments(email.id, email.attachments, client);
    }
  }

  async upsertProviderEmail(email) {
    const localDisplayName = await this.displayNameForLocalUserEmail(email.senderEmail);
    let resolvedEmail = {
      ...email,
      senderName: localDisplayName || email.senderName,
      senderAvatarURL: optionalString(email.senderAvatarURL) || senderLogoURLForEmail(email.senderEmail)
    };
    const blockedRule = await this.blockedSenderForEmail(resolvedEmail.accountId, resolvedEmail.senderEmail);
    if (blockedRule && await this.canRouteBlockedEmailToSpam(resolvedEmail.mailboxId)) {
      resolvedEmail = { ...resolvedEmail, mailboxId: (await this.mailboxForRole(resolvedEmail.accountId, "spam")).id };
    }
    const existing = resolvedEmail.providerUID ? await this.pool.query(`
      SELECT id, mailbox_id AS "mailboxId"
      FROM public.emails
      WHERE user_id = $1 AND account_id = $2 AND provider_uid = $3
      LIMIT 1
    `, [await this.currentUserId(), resolvedEmail.accountId, resolvedEmail.providerUID]) : { rows: [] };
    if (existing.rows[0]) {
      await this.pool.query(`
        UPDATE public.emails
        SET mailbox_id = $1, thread_id = $2, sender_name = $3, sender_email = $4,
            sender_avatar_url = $5, recipients_json = $6::jsonb, cc_json = $7::jsonb,
            bcc_json = $8::jsonb, subject = $9, snippet = $10, body_text = $11,
            body_html = $12, rfc_message_id = $13, in_reply_to = $14,
            references_json = $15::jsonb, sent_at = $16, received_at = $17,
            is_read = $18, is_starred = $19, importance = $20, has_attachments = $21
        WHERE id = $22 AND user_id = $23
      `, [
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
        resolvedEmail.isRead === true,
        resolvedEmail.isStarred === true,
        resolvedEmail.importance ?? "normal",
        resolvedEmail.hasAttachments === true,
        existing.rows[0].id,
        await this.currentUserId()
      ]);
      if (Array.isArray(resolvedEmail.attachments)) {
        await this.replaceEmailAttachments(existing.rows[0].id, resolvedEmail.attachments);
      }
      await this.refreshMailboxUnread(existing.rows[0].mailboxId);
      await this.refreshMailboxUnread(resolvedEmail.mailboxId);
      return { ...await this.getEmail(existing.rows[0].id), wasNew: false };
    }
    await this.insertEmail(resolvedEmail);
    await this.refreshMailboxUnread(resolvedEmail.mailboxId);
    return { ...await this.getEmail(resolvedEmail.id), wasNew: true };
  }

  async blockedSenderForEmail(accountId, senderEmail) {
    const normalizedEmail = optionalString(senderEmail)?.toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) return null;
    const senderDomain = domainForEmail(normalizedEmail);
    const rules = await this.listBlockedSenders(accountId);
    return rules.find(rule => {
      if (rule.scope === "email") return rule.value === normalizedEmail;
      return senderDomain === rule.value || senderDomain.endsWith(`.${rule.value}`);
    }) ?? null;
  }

  async canRouteBlockedEmailToSpam(mailboxId) {
    const role = await this.mailboxRole(mailboxId);
    return role !== "sent" && role !== "drafts" && role !== "trash" && role !== "spam";
  }

  async moveBlockedMessagesToSpam(accountId, scope, value) {
    const spamMailbox = await this.mailboxForRole(accountId, "spam");
    const selectMatchSQL = scope === "email"
      ? "lower(e.sender_email::text) = $3"
      : "(lower(e.sender_email::text) LIKE $3 OR lower(e.sender_email::text) LIKE $4)";
    const updateMatchSQL = scope === "email"
      ? "lower(e.sender_email::text) = $4"
      : "(lower(e.sender_email::text) LIKE $4 OR lower(e.sender_email::text) LIKE $5)";
    const matchArgs = scope === "email" ? [value] : [`%@${value}`, `%.${value}`];
    const touched = await this.pool.query(`
      SELECT DISTINCT e.mailbox_id AS "mailboxId"
      FROM public.emails e
      JOIN public.mailboxes m ON m.id = e.mailbox_id
      WHERE e.user_id = $1 AND e.account_id = $2 AND m.role NOT IN ('sent', 'drafts', 'trash')
        AND ${selectMatchSQL}
    `, [await this.currentUserId(), accountId, ...matchArgs]);
    const result = await this.pool.query(`
      UPDATE public.emails e
      SET mailbox_id = $3
      FROM public.mailboxes m
      WHERE m.id = e.mailbox_id
        AND e.user_id = $1
        AND e.account_id = $2
        AND m.role NOT IN ('sent', 'drafts', 'trash')
        AND ${updateMatchSQL}
    `, [await this.currentUserId(), accountId, spamMailbox.id, ...matchArgs]);
    for (const row of touched.rows) {
      await this.refreshMailboxUnread(row.mailboxId);
    }
    await this.refreshMailboxUnread(spamMailbox.id);
    return result.rowCount ?? 0;
  }

  async refreshMailboxUnread(mailboxId) {
    await this.pool.query(`
      UPDATE public.mailboxes m
      SET unread_count = (
        SELECT COUNT(*)::int FROM public.emails e WHERE e.mailbox_id = m.id AND e.is_read = false
      )
      WHERE m.id = $1 AND m.user_id = $2
    `, [mailboxId, await this.currentUserId()]);
  }

  async ensureDefaultsForAccount(accountId, client = this.pool) {
    const userId = await this.currentUserId();
    for (const [name, role] of SYSTEM_MAILBOXES) {
      await client.query(`
        INSERT INTO public.mailboxes (user_id, account_id, name, role)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(account_id, role) DO NOTHING
      `, [userId, accountId, name, role]);
    }
    for (const [name, color] of SYSTEM_LABELS) {
      await client.query(`
        INSERT INTO public.labels (user_id, account_id, name, color, is_system)
        VALUES ($1, $2, $3, $4, true)
        ON CONFLICT DO NOTHING
      `, [userId, accountId, name, color]);
    }
  }

  async moveEmailToRole(id, role) {
    const existing = await this.getEmail(id);
    if (!existing) return null;
    const mailbox = await this.mailboxForRole(existing.accountId, role);
    if (existing.mailboxId !== mailbox.id) {
      await this.pool.query("UPDATE public.emails SET mailbox_id = $1 WHERE id = $2 AND user_id = $3", [mailbox.id, id, await this.currentUserId()]);
      await this.refreshMailboxUnread(existing.mailboxId);
      await this.refreshMailboxUnread(mailbox.id);
    }
    return await this.getEmail(id);
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async assertRequiredRelations() {
    const requiredRelations = [
      "public.app_users",
      "public.accounts",
      "public.emails",
      "public.email_attachments",
      "email_private.provider_secrets",
      "email_private.provider_auth_sessions",
      "storage.buckets"
    ];
    const result = await this.pool.query(`
      SELECT relation_name AS relation, to_regclass(relation_name) IS NOT NULL AS exists
      FROM unnest($1::text[]) AS required_relation(relation_name)
    `, [requiredRelations]);
    const missing = result.rows
      .filter(row => row.exists !== true)
      .map(row => row.relation);
    if (missing.length > 0) {
      throw new Error(`Missing hosted database relations: ${missing.join(", ")}`);
    }
  }

  async assertAttachmentStorageReady() {
    if (!this.attachmentStorage) {
      throw new Error("Supabase attachment storage client is not configured.");
    }
    const bucket = await this.pool.query(
      "SELECT public FROM storage.buckets WHERE id = $1 LIMIT 1",
      [this.attachmentBucket]
    );
    if (bucket.rowCount !== 1) {
      throw new Error(`Supabase Storage bucket '${this.attachmentBucket}' does not exist.`);
    }
    if (bucket.rows[0].public === true) {
      throw new Error(`Supabase Storage bucket '${this.attachmentBucket}' must be private.`);
    }
    const { error } = await this.attachmentStorage.list("", { limit: 1 });
    if (error) {
      throw new Error(`Supabase Storage bucket '${this.attachmentBucket}' is not readable by the API: ${error.message ?? error}`);
    }
  }
}

function mapUserRow(row = {}) {
  return {
    id: row.id,
    displayName: row.displayName,
    primaryEmail: row.primaryEmail,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapAccountRow(row) {
  return {
    ...row,
    email: String(row.email),
    syncHistory: Boolean(row.syncHistory),
    lastSyncAt: isoOrNull(row.lastSyncAt),
    createdAt: iso(row.createdAt),
    providerMetadata: row.providerMetadata ?? {}
  };
}

function mapMailboxRow(row) {
  return {
    ...row,
    accountEmail: row.accountEmail ? String(row.accountEmail) : row.accountEmail,
    unreadCount: Number(row.unreadCount ?? 0)
  };
}

function mapLabelRow(row) {
  return {
    ...row,
    accountEmail: row.accountEmail ? String(row.accountEmail) : row.accountEmail,
    isSystem: Boolean(row.isSystem)
  };
}

function mapEmailSummaryRow(row) {
  return {
    ...row,
    accountEmail: String(row.accountEmail),
    senderEmail: String(row.senderEmail),
    senderAvatarURL: row.senderAvatarURL || senderLogoURLForEmail(row.senderEmail),
    receivedAt: iso(row.receivedAt),
    sentAt: iso(row.sentAt),
    openedAt: isoOrNull(row.openedAt),
    isRead: Boolean(row.isRead),
    isStarred: Boolean(row.isStarred),
    hasAttachments: Boolean(row.hasAttachments)
  };
}

function mapEmailDetailRow(row) {
  return {
    ...mapEmailSummaryRow(row),
    recipients: asArray(row.recipients),
    cc: asArray(row.cc),
    bcc: asArray(row.bcc),
    references: asArray(row.references),
    createdAt: iso(row.createdAt)
  };
}

function mapAttachmentRow(row) {
  return {
    ...row,
    size: Number(row.size ?? 0),
    isInline: Boolean(row.isInline),
    isDownloaded: Boolean(row.isDownloaded)
  };
}

function mapPushTokenRow(row) {
  return {
    ...row,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    lastSeenAt: iso(row.lastSeenAt),
    disabledAt: isoOrNull(row.disabledAt)
  };
}

function storageClientFor({ supabaseURL, supabaseServiceRoleKey, bucket }) {
  if (!supabaseURL || !supabaseServiceRoleKey) return null;
  return createClient(supabaseURL, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }).storage.from(bucket);
}

function attachmentObjectPath(userId, emailId, attachmentId, filename) {
  const safeName = String(filename)
    .normalize("NFKD")
    .replace(/[^\w. -]+/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120) || "attachment";
  return `${userId}/${emailId}/${attachmentId}/${safeName}`;
}

function emailInsertParams(email, userId) {
  return [
    email.id,
    userId,
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
    email.isRead === true,
    email.isStarred === true,
    email.importance ?? "normal",
    email.hasAttachments === true,
    email.trackingId,
    email.openedAt,
    email.createdAt
  ];
}

function normalizeProvider(provider) {
  if (provider !== "gmail" && provider !== "icloud") {
    throw httpError(400, "Provider must be gmail or icloud.");
  }
  return provider;
}

function normalizeAppUser(user) {
  if (!user || typeof user !== "object") throw httpError(401, "Authentication is required.");
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
  if (!email.includes("@")) throw httpError(400, `${name} must be an email address.`);
  return email;
}

function normalizeEmailForComparison(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/<([^<>@\s]+@[^<>\s]+)>/u);
  const trimmed = (match?.[1] ?? value).trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  return trimmed.replace(/^mailto:/iu, "");
}

function domainForEmail(value) {
  const email = normalizeEmailAddress(value, "senderEmail");
  const domain = email.split("@").at(-1)?.trim().toLowerCase() ?? "";
  if (!domain || !domain.includes(".")) throw httpError(400, "Sender email must include a domain.");
  return domain;
}

function normalizePushToken(value) {
  const token = requiredString(value, "token").toLowerCase();
  if (!/^[a-f0-9]{32,}$/u.test(token)) throw httpError(400, "token must be a hex APNs device token.");
  return token;
}

function normalizePushPlatform(value) {
  if (value !== "ios" && value !== "macos") throw httpError(400, "platform must be ios or macos.");
  return value;
}

function normalizePushEnvironment(value) {
  if (value !== "development" && value !== "production") throw httpError(400, "environment must be development or production.");
  return value;
}

function normalizeAddressList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value).split(",").map(item => item.trim()).filter(Boolean);
}

function normalizePostgresSearch(value) {
  if (typeof value !== "string") return "";
  return Array.from(value.matchAll(/[\p{L}\p{N}@._-]+/gu), match => match[0])
    .slice(0, 8)
    .join(" ");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

function makeRFCMessageID(email) {
  const domain = String(email).split("@").at(-1)?.trim().toLowerCase() || "dearly.local";
  const safeDomain = /^[a-z0-9.-]+$/u.test(domain) ? domain : "dearly.local";
  return `<${randomUUID()}@${safeDomain}>`;
}

function replyReferences(email) {
  if (!email) return [];
  const values = [...(email.references ?? [])];
  if (email.rfcMessageID) values.push(email.rfcMessageID);
  return uniqueStrings(values);
}

function compareEmailTimeAscending(a, b) {
  const aTime = Date.parse(a.sentAt ?? a.receivedAt ?? a.createdAt ?? "");
  const bTime = Date.parse(b.sentAt ?? b.receivedAt ?? b.createdAt ?? "");
  if (aTime !== bTime) return aTime - bTime;
  return a.id.localeCompare(b.id);
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value) {
  return value ? iso(value) : null;
}
