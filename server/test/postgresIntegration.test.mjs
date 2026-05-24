import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { RequestAuthenticator } from "../src/auth.js";
import { createServer } from "../src/http.js";
import { PostgresMailStore } from "../src/postgresStore.js";

const integrationConfig = {
  postgresURL: process.env.EMAIL_TEST_POSTGRES_URL,
  supabaseURL: process.env.EMAIL_TEST_SUPABASE_URL,
  publishableKey: process.env.EMAIL_TEST_SUPABASE_PUBLISHABLE_KEY,
  serviceRoleKey: process.env.EMAIL_TEST_SUPABASE_SERVICE_ROLE_KEY
};

const hasIntegrationConfig = Boolean(
  integrationConfig.postgresURL &&
  integrationConfig.supabaseURL &&
  integrationConfig.publishableKey &&
  integrationConfig.serviceRoleKey
);

test("real Supabase Postgres store isolates tenants across search, records, push tokens, and attachments", {
  skip: hasIntegrationConfig ? false : integrationSkipReason()
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
    const syncableAccounts = await store.listSyncableAccounts({ limit: 10 });
    assert.deepEqual(
      syncableAccounts
        .filter(account => account.id === aliceAccount.id || account.id === bobAccount.id)
        .map(account => [account.id, account.user.id])
        .sort(),
      [
        [aliceAccount.id, alice.id],
        [bobAccount.id, bob.id]
      ].sort()
    );

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
    const oauthState = `state-${suffix}`;
    await aliceStore.saveProviderAuthSession({
      provider: "gmail",
      state: oauthState,
      codeVerifier: "verifier-alice",
      displayName: "Alice Gmail",
      syncHistory: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    assert.deepEqual((await aliceStore.listEmails({ q: "tenant needle" })).map(email => email.id), [aliceEmailId]);
    assert.deepEqual((await bobStore.listEmails({ q: "tenant needle" })).map(email => email.id), [bobEmailId]);
    assert.equal(await aliceStore.getEmail(bobEmailId), null);
    assert.equal(await bobStore.getEmail(aliceEmailId), null);
    assert.deepEqual((await aliceStore.listPushTokens()).map(token => token.deviceName), ["alice iPhone"]);
    assert.deepEqual((await bobStore.listPushTokens()).map(token => token.deviceName), ["bob iPhone"]);

    const attachment = await aliceStore.getAttachment(aliceEmailId, aliceAttachmentId);
    assert.equal(Buffer.from(attachment.data).toString("utf8"), "alice attachment bytes");
    assert.equal(await bobStore.getAttachment(aliceEmailId, aliceAttachmentId), null);

    const oauthSession = await store.consumeProviderAuthSession({ provider: "gmail", state: oauthState });
    assert.equal(oauthSession.codeVerifier, "verifier-alice");
    assert.equal(oauthSession.displayName, "Alice Gmail");
    assert.equal(oauthSession.syncHistory, false);
    assert.equal(oauthSession.user.id, alice.id);
    assert.equal(await store.consumeProviderAuthSession({ provider: "gmail", state: oauthState }), null);
  } finally {
    await cleanupStorage(store, uploadedPaths);
    await pool.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[alice.id, bob.id]]);
    await store.close();
    await pool.end();
  }
});

test("real hosted HTTP API verifies Supabase JWTs and scopes tenant routes", {
  skip: hasIntegrationConfig ? false : integrationSkipReason()
}, async () => {
  const suffix = randomUUID();
  const alice = testUser("http-alice", suffix);
  const bob = testUser("http-bob", suffix);
  const alicePassword = `P${randomUUID()}!1a`;
  const bobPassword = `P${randomUUID()}!1a`;
  const pool = new pg.Pool({ connectionString: integrationConfig.postgresURL });
  const store = new PostgresMailStore({
    connectionString: integrationConfig.postgresURL,
    supabaseURL: integrationConfig.supabaseURL,
    supabaseServiceRoleKey: integrationConfig.serviceRoleKey
  });
  const { server } = createServer({
    store,
    authenticator: new RequestAuthenticator({
      requireAuth: true,
      supabaseURL: integrationConfig.supabaseURL,
      supabasePublishableKey: integrationConfig.publishableKey
    })
  });

  try {
    await createConfirmedAuthUser(alice, alicePassword);
    await createConfirmedAuthUser(bob, bobPassword);
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const aliceToken = await passwordToken(alice.email, alicePassword);
    const bobToken = await passwordToken(bob.email, bobPassword);

    const unauthenticated = await fetch(`${baseURL}/api/accounts`);
    assert.equal(unauthenticated.status, 401);

    const aliceAccount = (await requestJSON(`${baseURL}/api/accounts`, {
      method: "POST",
      token: aliceToken,
      body: sharedAccountInput()
    })).account;
    const bobAccount = (await requestJSON(`${baseURL}/api/accounts`, {
      method: "POST",
      token: bobToken,
      body: sharedAccountInput()
    })).account;
    assert.notEqual(aliceAccount.id, bobAccount.id);

    assert.deepEqual((await requestJSON(`${baseURL}/api/accounts`, { token: aliceToken })).accounts.map(account => account.id), [aliceAccount.id]);
    assert.deepEqual((await requestJSON(`${baseURL}/api/accounts`, { token: bobToken })).accounts.map(account => account.id), [bobAccount.id]);

    const crossTenantPatch = await fetch(`${baseURL}/api/accounts/${bobAccount.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ displayName: "Compromised" })
    });
    assert.equal(crossTenantPatch.status, 404);

    const sent = (await requestJSON(`${baseURL}/api/messages/send`, {
      method: "POST",
      token: aliceToken,
      body: {
        accountId: aliceAccount.id,
        to: "friend@example.com",
        subject: "Hosted route proof",
        bodyText: "hosted http searchable needle"
      }
    })).email;
    assert.ok(sent.trackingId);

    const search = await requestJSON(`${baseURL}/api/emails?q=hosted%20http%20searchable`, { token: aliceToken });
    assert.deepEqual(search.emails.map(email => email.id), [sent.id]);
    assert.deepEqual((await requestJSON(`${baseURL}/api/emails?q=hosted%20http%20searchable`, { token: bobToken })).emails, []);

    const pixel = await fetch(`${baseURL}/api/track/open/${sent.trackingId}.gif`);
    assert.equal(pixel.status, 200);
    assert.equal(pixel.headers.get("content-type"), "image/gif");
    const opened = (await requestJSON(`${baseURL}/api/emails/${sent.id}`, { token: aliceToken })).email;
    assert.ok(opened.openedAt);
  } finally {
    await close(server);
    await pool.query("DELETE FROM auth.users WHERE email = ANY($1::text[])", [[alice.email, bob.email]]);
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

async function createConfirmedAuthUser(user, password) {
  const response = await fetch(`${integrationConfig.supabaseURL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: integrationConfig.serviceRoleKey,
      Authorization: `Bearer ${integrationConfig.serviceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email: user.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: user.displayName }
    })
  });
  if (!response.ok) {
    assert.fail(`Could not create confirmed auth user: ${response.status} ${await response.text()}`);
  }
}

async function passwordToken(email, password) {
  const response = await fetch(`${integrationConfig.supabaseURL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: integrationConfig.publishableKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  const body = await response.json();
  if (!response.ok) {
    assert.fail(`Could not sign in test user: ${response.status} ${JSON.stringify(body)}`);
  }
  assert.ok(body.access_token);
  return body.access_token;
}

async function requestJSON(url, { method = "GET", token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    assert.fail(`${method} ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function listen(server, port) {
  return new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function integrationSkipReason() {
  return "Set EMAIL_TEST_POSTGRES_URL, EMAIL_TEST_SUPABASE_URL, EMAIL_TEST_SUPABASE_PUBLISHABLE_KEY, and EMAIL_TEST_SUPABASE_SERVICE_ROLE_KEY.";
}
