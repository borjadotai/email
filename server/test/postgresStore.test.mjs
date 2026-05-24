import assert from "node:assert/strict";
import test from "node:test";
import { PostgresMailStore } from "../src/postgresStore.js";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "alice@example.com",
  displayName: "Alice"
};

test("Postgres store upserts accounts within the authenticated tenant", async () => {
  const pool = new FakePool();
  const store = new PostgresMailStore({ pool }).forUser(user);

  const account = await store.createOrUpdateAccount({
    provider: "gmail",
    email: "alice@gmail.com",
    displayName: "Alice Gmail",
    authType: "gmail_oauth",
    status: "connected"
  });

  assert.equal(account.id, "10000000-0000-4000-8000-000000000001");
  const upsert = pool.queries.find(query => /INSERT INTO public\.accounts/u.test(query.sql));
  assert.ok(upsert);
  assert.match(upsert.sql, /ON CONFLICT \(user_id, provider, provider_account_email\)/u);
  assert.deepEqual(upsert.params.slice(0, 4), [
    user.id,
    "gmail",
    "alice@gmail.com",
    "Alice Gmail"
  ]);
  assert.equal(pool.queries.filter(query => /INSERT INTO public\.mailboxes/u.test(query.sql)).length, 6);
  assert.equal(pool.queries.filter(query => /INSERT INTO public\.labels/u.test(query.sql)).length, 4);
});

test("Postgres store searches only the authenticated tenant", async () => {
  const pool = new FakePool();
  const store = new PostgresMailStore({ pool }).forUser(user);

  const emails = await store.listEmails({ q: "invoice", mailboxRole: "inbox", limit: 10 });

  assert.deepEqual(emails.map(email => email.id), ["20000000-0000-4000-8000-000000000001"]);
  const search = pool.queries.find(query => /FROM public\.emails e/u.test(query.sql));
  assert.ok(search);
  assert.match(search.sql, /e\.user_id = \$1/u);
  assert.match(search.sql, /e\.search_vector @@ websearch_to_tsquery\('simple'/u);
  assert.match(search.sql, /m\.role =/u);
  assert.equal(search.params[0], user.id);
  assert.equal(search.params[1], "invoice");
});

test("Postgres store lists connected accounts eligible for hosted background sync", async () => {
  const pool = new FakePool();
  const store = new PostgresMailStore({ pool });

  const accounts = await store.listSyncableAccounts({
    staleBefore: new Date("2026-05-24T09:00:00Z"),
    limit: 20
  });

  assert.deepEqual(accounts.map(account => account.id), ["10000000-0000-4000-8000-000000000001"]);
  assert.deepEqual(accounts[0].user, {
    id: user.id,
    email: user.email,
    displayName: user.displayName
  });
  const query = pool.queries.find(item => /FROM public\.accounts a\s+JOIN public\.app_users/u.test(item.sql));
  assert.ok(query);
  assert.match(query.sql, /a\.status = 'connected'/u);
  assert.match(query.sql, /a\.last_sync_at IS NULL OR a\.last_sync_at <= \$2/u);
  assert.deepEqual(query.params, [20, "2026-05-24T09:00:00.000Z"]);
});

test("Postgres store records opens without authenticated context", async () => {
  const pool = new FakePool();
  const store = new PostgresMailStore({ pool });

  const opened = await store.recordOpen("track-1", {
    userAgent: "node-test",
    remoteAddr: "127.0.0.1"
  });

  assert.equal(opened.id, "20000000-0000-4000-8000-000000000001");
  assert.equal(opened.userId, user.id);
  const openEvent = pool.queries.find(query => /INSERT INTO public\.open_events/u.test(query.sql));
  assert.ok(openEvent);
  assert.deepEqual(openEvent.params, [
    user.id,
    "20000000-0000-4000-8000-000000000001",
    "track-1",
    "node-test",
    "127.0.0.1"
  ]);
  const labels = pool.queries.find(query => /FROM public\.labels l\s+JOIN public\.email_labels/u.test(query.sql));
  assert.ok(labels);
  assert.deepEqual(labels.params, ["20000000-0000-4000-8000-000000000001", user.id]);
});

test("Postgres store stores attachment bytes in private object storage", async () => {
  const pool = new FakePool();
  const storage = new FakeStorage();
  const store = new PostgresMailStore({ pool, storageClient: storage }).forUser(user);
  const emailId = "20000000-0000-4000-8000-000000000001";
  const attachmentId = "40000000-0000-4000-8000-000000000001";

  await store.replaceEmailAttachments(emailId, [{
    id: attachmentId,
    filename: "Invoice Q1.pdf",
    mimeType: "application/pdf",
    data: Buffer.from("hello")
  }]);

  assert.equal(storage.uploads.length, 1);
  assert.equal(storage.uploads[0].path, `${user.id}/${emailId}/${attachmentId}/Invoice-Q1.pdf`);
  assert.equal(storage.uploads[0].contentType, "application/pdf");
  const insert = pool.queries.find(query => /INSERT INTO public\.email_attachments/u.test(query.sql));
  assert.ok(insert);
  assert.equal(insert.params[10], "stored");
  assert.equal(insert.params[11], "email-attachments");
  assert.equal(insert.params[12], storage.uploads[0].path);

  const attachment = await store.getAttachment(emailId, attachmentId);
  assert.equal(Buffer.from(attachment.data).toString("utf8"), "hello");
});

test("Postgres store persists provider auth sessions in the private schema", async () => {
  const pool = new FakePool();
  const store = new PostgresMailStore({ pool }).forUser(user);

  await store.saveProviderAuthSession({
    provider: "gmail",
    state: "state-1",
    codeVerifier: "verifier-1",
    displayName: "Alice Gmail",
    syncHistory: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const saved = pool.queries.find(query => /INSERT INTO email_private\.provider_auth_sessions/u.test(query.sql));
  assert.ok(saved);
  assert.deepEqual(saved.params.slice(0, 6), [
    "state-1",
    user.id,
    "gmail",
    "verifier-1",
    "Alice Gmail",
    false
  ]);

  const session = await store.consumeProviderAuthSession({ provider: "gmail", state: "state-1" });
  assert.equal(session.codeVerifier, "verifier-1");
  assert.equal(session.displayName, "Alice Gmail");
  assert.equal(session.syncHistory, false);
  assert.deepEqual(session.user, {
    id: user.id,
    email: user.email,
    displayName: user.displayName
  });
  assert.ok(pool.queries.some(query => /DELETE FROM email_private\.provider_auth_sessions/u.test(query.sql)));
});

class FakePool {
  queries = [];

  async connect() {
    return {
      query: async (sql, params = []) => await this.query(sql, params),
      release: () => {}
    };
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }

    if (/SELECT id, display_name AS "displayName"/u.test(sql)) {
      return {
        rows: [{
          id: user.id,
          displayName: user.displayName,
          primaryEmail: user.email,
          createdAt: new Date("2026-05-24T10:00:00Z"),
          updatedAt: new Date("2026-05-24T10:00:00Z")
        }]
      };
    }

    if (/INSERT INTO public\.accounts/u.test(sql)) {
      return { rows: [{ id: "10000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    }

    if (/WITH deleted AS \(/u.test(sql)) {
      return {
        rows: [{
          state: params[0],
          provider: params[1],
          codeVerifier: "verifier-1",
          displayName: "Alice Gmail",
          syncHistory: false,
          createdAt: new Date("2026-05-24T10:00:00Z"),
          expiresAt: new Date("2026-05-24T10:10:00Z"),
          userId: user.id,
          userEmail: user.email,
          userDisplayName: user.displayName
        }]
      };
    }

    if (/SELECT id, user_id AS "userId", opened_at AS "openedAt"/u.test(sql)) {
      return {
        rows: [{
          id: "20000000-0000-4000-8000-000000000001",
          userId: user.id,
          openedAt: null
        }]
      };
    }

    if (/SELECT id, provider, provider_account_email AS email/u.test(sql)) {
      return {
        rows: [{
          id: "10000000-0000-4000-8000-000000000001",
          provider: "gmail",
          email: "alice@gmail.com",
          displayName: "Alice Gmail",
          avatarURL: null,
          authType: "gmail_oauth",
          status: "connected",
          syncHistory: true,
          lastSyncAt: null,
          providerMetadata: {},
          createdAt: new Date("2026-05-24T10:00:00Z")
        }]
      };
    }

    if (/FROM public\.accounts a\s+JOIN public\.app_users/u.test(sql)) {
      return {
        rows: [{
          id: "10000000-0000-4000-8000-000000000001",
          provider: "gmail",
          email: "alice@gmail.com",
          displayName: "Alice Gmail",
          avatarURL: null,
          authType: "gmail_oauth",
          status: "connected",
          syncHistory: true,
          lastSyncAt: null,
          providerMetadata: {},
          createdAt: new Date("2026-05-24T10:00:00Z"),
          userId: user.id,
          userEmail: user.email,
          userDisplayName: user.displayName
        }]
      };
    }

    if (/SELECT e\.id, e\.user_id AS "userId"/u.test(sql)) {
      return {
        rows: [{
          id: "20000000-0000-4000-8000-000000000001",
          userId: user.id,
          accountId: "10000000-0000-4000-8000-000000000001",
          accountEmail: "alice@gmail.com",
          provider: "gmail",
          mailboxId: "30000000-0000-4000-8000-000000000001",
          mailboxName: "Inbox",
          mailboxRole: "inbox",
          providerUID: null,
          threadId: "thread-1",
          senderName: "Billing",
          senderEmail: "billing@example.com",
          senderAvatarURL: null,
          recipients: ["alice@gmail.com"],
          cc: [],
          bcc: [],
          subject: "Invoice",
          snippet: "Invoice ready",
          bodyText: "Invoice ready",
          bodyHTML: null,
          rfcMessageID: "<invoice@example.com>",
          inReplyTo: null,
          references: [],
          receivedAt: new Date("2026-05-24T10:00:00Z"),
          sentAt: new Date("2026-05-24T10:00:00Z"),
          isRead: false,
          isStarred: false,
          importance: "normal",
          hasAttachments: false,
          trackingId: "track-1",
          openedAt: new Date("2026-05-24T10:01:00Z"),
          createdAt: new Date("2026-05-24T10:00:00Z")
        }]
      };
    }

    if (/SELECT e\.id, e\.account_id AS "accountId"/u.test(sql)) {
      return {
        rows: [{
          id: "20000000-0000-4000-8000-000000000001",
          accountId: "10000000-0000-4000-8000-000000000001",
          accountEmail: "alice@gmail.com",
          provider: "gmail",
          mailboxId: "30000000-0000-4000-8000-000000000001",
          mailboxName: "Inbox",
          mailboxRole: "inbox",
          senderName: "Billing",
          senderEmail: "billing@example.com",
          senderAvatarURL: null,
          subject: "Invoice",
          snippet: "Invoice ready",
          receivedAt: new Date("2026-05-24T10:00:00Z"),
          sentAt: new Date("2026-05-24T10:00:00Z"),
          isRead: false,
          isStarred: false,
          importance: "normal",
          hasAttachments: false,
          trackingId: null,
          openedAt: null
        }]
      };
    }

    if (/storage_bucket AS "storageBucket"/u.test(sql)) {
      return {
        rows: [{
          id: params[1],
          emailId: params[0],
          filename: "Invoice Q1.pdf",
          mimeType: "application/pdf",
          size: 5,
          disposition: null,
          isInline: false,
          contentId: null,
          storageBucket: "email-attachments",
          storagePath: `${user.id}/${params[0]}/${params[1]}/Invoice-Q1.pdf`
        }]
      };
    }

    if (/FROM public\.labels l\s+JOIN public\.email_labels/u.test(sql)) {
      return { rows: [] };
    }

    return { rows: [], rowCount: 1 };
  }
}

class FakeStorage {
  uploads = [];
  objects = new Map();

  async upload(path, data, options = {}) {
    const buffer = Buffer.from(data);
    this.uploads.push({ path, contentType: options.contentType, upsert: options.upsert, size: buffer.length });
    this.objects.set(path, buffer);
    return { data: { path }, error: null };
  }

  async download(path) {
    const buffer = this.objects.get(path);
    if (!buffer) return { data: null, error: new Error("missing object") };
    return {
      data: {
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      },
      error: null
    };
  }
}
