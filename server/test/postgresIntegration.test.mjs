import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresMailStore } from "../src/postgresStore.js";

const integrationConfig = {
  postgresURL: process.env.EMAIL_TEST_POSTGRES_URL,
  supabaseURL: process.env.EMAIL_TEST_SUPABASE_URL,
  serviceRoleKey: process.env.EMAIL_TEST_SUPABASE_SERVICE_ROLE_KEY
};

const hasIntegrationConfig = Boolean(
  integrationConfig.postgresURL &&
  integrationConfig.supabaseURL &&
  integrationConfig.serviceRoleKey
);

test("real Supabase Postgres store isolates tenants across search, records, push tokens, and attachments", {
  skip: hasIntegrationConfig ? false : "Set EMAIL_TEST_POSTGRES_URL, EMAIL_TEST_SUPABASE_URL, and EMAIL_TEST_SUPABASE_SERVICE_ROLE_KEY."
}, async () => {
  const suffix = randomUUID();
  const alice = testUser("alice", suffix);
  const bob = testUser("bob", suffix);
  const pool = new pg.Pool({ connectionString: integrationConfig.postgresURL });
  const store = new PostgresMailStore({
    connectionString: integrationConfig.postgresURL,
    supabaseURL: integrationConfig.supabaseURL,
    supabaseServiceRoleKey: integrationConfig.serviceRoleKey
  });

  const uploadedPaths = [];
  try {
    await seedAuthUser(pool, alice);
    await seedAuthUser(pool, bob);

    const aliceStore = store.forUser(alice);
    const bobStore = store.forUser(bob);
    const aliceAccount = await aliceStore.createOrUpdateAccount(sharedAccountInput());
    const bobAccount = await bobStore.createOrUpdateAccount(sharedAccountInput());
    assert.notEqual(aliceAccount.id, bobAccount.id);

    const aliceInbox = await aliceStore.mailboxForRole(aliceAccount.id, "inbox");
    const bobInbox = await bobStore.mailboxForRole(bobAccount.id, "inbox");
    const aliceEmailId = randomUUID();
    const bobEmailId = randomUUID();
    const aliceAttachmentId = randomUUID();

    await aliceStore.upsertProviderEmail(providerEmail({
      id: aliceEmailId,
      accountId: aliceAccount.id,
      mailboxId: aliceInbox.id,
      providerUID: `provider-alice-${suffix}`,
      bodyText: "alice-only searchable tenant needle",
      attachmentId: aliceAttachmentId,
      attachmentBytes: Buffer.from("alice attachment bytes")
    }));
    uploadedPaths.push(`${alice.id}/${aliceEmailId}/${aliceAttachmentId}/Tenant-Proof.txt`);

    await bobStore.upsertProviderEmail(providerEmail({
      id: bobEmailId,
      accountId: bobAccount.id,
      mailboxId: bobInbox.id,
      providerUID: `provider-bob-${suffix}`,
      bodyText: "bob-only searchable tenant needle"
    }));

    await aliceStore.registerPushToken(pushToken("a"));
    await bobStore.registerPushToken(pushToken("b"));

    assert.deepEqual((await aliceStore.listEmails({ q: "tenant needle" })).map(email => email.id), [aliceEmailId]);
    assert.deepEqual((await bobStore.listEmails({ q: "tenant needle" })).map(email => email.id), [bobEmailId]);
    assert.equal(await aliceStore.getEmail(bobEmailId), null);
    assert.equal(await bobStore.getEmail(aliceEmailId), null);
    assert.deepEqual((await aliceStore.listPushTokens()).map(token => token.deviceName), ["alice iPhone"]);
    assert.deepEqual((await bobStore.listPushTokens()).map(token => token.deviceName), ["bob iPhone"]);

    const attachment = await aliceStore.getAttachment(aliceEmailId, aliceAttachmentId);
    assert.equal(Buffer.from(attachment.data).toString("utf8"), "alice attachment bytes");
    assert.equal(await bobStore.getAttachment(aliceEmailId, aliceAttachmentId), null);
  } finally {
    await cleanupStorage(store, uploadedPaths);
    await pool.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[alice.id, bob.id]]);
    await store.close();
    await pool.end();
  }
});

function testUser(name, suffix) {
  return {
    id: randomUUID(),
    email: `${name}-${suffix}@example.com`,
    displayName: name === "alice" ? "Alice Test" : "Bob Test"
  };
}

function sharedAccountInput() {
  return {
    provider: "gmail",
    email: "shared-provider-account@example.com",
    displayName: "Shared Provider Account",
    authType: "gmail_oauth",
    status: "connected"
  };
}

function providerEmail({
  id,
  accountId,
  mailboxId,
  providerUID,
  bodyText,
  attachmentId = null,
  attachmentBytes = null
}) {
  return {
    id,
    accountId,
    mailboxId,
    providerUID,
    threadId: randomUUID(),
    senderName: "Billing",
    senderEmail: "billing@example.com",
    senderAvatarURL: null,
    recipients: ["shared-provider-account@example.com"],
    cc: [],
    bcc: [],
    subject: "Tenant proof",
    snippet: bodyText.slice(0, 180),
    bodyText,
    bodyHTML: `<p>${bodyText}</p>`,
    rfcMessageID: `<${id}@example.com>`,
    inReplyTo: null,
    references: [],
    sentAt: "2026-05-24T10:00:00.000Z",
    receivedAt: "2026-05-24T10:00:00.000Z",
    isRead: false,
    isStarred: false,
    importance: "normal",
    hasAttachments: Boolean(attachmentBytes),
    trackingId: null,
    openedAt: null,
    createdAt: "2026-05-24T10:00:00.000Z",
    attachments: attachmentBytes ? [{
      id: attachmentId,
      filename: "Tenant Proof.txt",
      mimeType: "text/plain",
      data: attachmentBytes
    }] : []
  };
}

function pushToken(prefix) {
  return {
    token: prefix.repeat(64),
    platform: "ios",
    bundleId: "com.borjadotai.email.ios",
    environment: "development",
    deviceName: prefix === "a" ? "alice iPhone" : "bob iPhone"
  };
}

async function seedAuthUser(pool, user) {
  await pool.query(`
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    )
    VALUES (
      $1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '',
      timezone('utc', now()), '{"provider":"email","providers":["email"]}'::jsonb, $3::jsonb,
      timezone('utc', now()), timezone('utc', now())
    )
    ON CONFLICT (id) DO NOTHING
  `, [user.id, user.email, JSON.stringify({ full_name: user.displayName })]);
}

async function cleanupStorage(store, paths) {
  if (!store.attachmentStorage || paths.length === 0) return;
  await store.attachmentStorage.remove(paths);
}
