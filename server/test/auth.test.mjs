import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "../src/http.js";
import { ProviderService } from "../src/providerAdapters.js";
import { MemorySecretStore } from "../src/secretStore.js";
import { MailStore } from "../src/store.js";

test("provider availability is server-owned and Gmail auth starts when configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {
        googleOAuthClientId: "test-client-id.apps.googleusercontent.com",
        googleOAuthClientSecret: "test-secret"
      },
      baseURL: "http://127.0.0.1:7331"
    });
    server = createServer({ store, providers }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const availability = await requestJSON(`${baseURL}/api/auth/settings`);
    assert.equal(availability.settings.gmailConfigured, true);
    assert.equal(availability.settings.icloudConfigured, true);
    assert.equal(availability.settings.appleMailOAuthAvailable, false);
    assert.equal(Object.hasOwn(availability.settings, "gmailClientId"), false);

    const auth = await requestJSON(`${baseURL}/api/auth/gmail/start`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Test Gmail", syncHistory: false }),
      headers: { "Content-Type": "application/json" }
    });
    const authorizationURL = new URL(auth.authorizationURL);
    assert.equal(authorizationURL.hostname, "accounts.google.com");
    assert.equal(authorizationURL.searchParams.get("client_id"), "test-client-id.apps.googleusercontent.com");
    assert.equal(authorizationURL.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorizationURL.searchParams.get("code_challenge"));
    assert.equal(auth.redirectURI, "http://127.0.0.1:7331/api/auth/gmail/callback");

    const session = store.consumeProviderAuthSession({ provider: "gmail", state: auth.state });
    assert.equal(session.provider, "gmail");
    assert.equal(session.displayName, "Test Gmail");
    assert.equal(session.syncHistory, false);
    assert.ok(session.codeVerifier);
    assert.equal(store.consumeProviderAuthSession({ provider: "gmail", state: auth.state }), null);
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates account settings through the API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    server = createServer({ store }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const response = await requestJSON(`${baseURL}/api/accounts/${account.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "Person Updated",
        avatarURL: "https://example.com/avatar.jpg",
        syncHistory: false
      }),
      headers: { "Content-Type": "application/json" }
    });

    assert.equal(response.account.displayName, "Person Updated");
    assert.equal(response.account.avatarURL, "https://example.com/avatar.jpg");
    assert.equal(response.account.syncHistory, false);
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authenticated API requests are scoped to the bearer user", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const aliceStore = store.forUser({
      id: "user-alice",
      email: "alice@example.com",
      displayName: "Alice"
    });
    const bobStore = store.forUser({
      id: "user-bob",
      email: "bob@example.com",
      displayName: "Bob"
    });
    const aliceAccount = aliceStore.createAccount({
      provider: "gmail",
      email: "alice@gmail.com",
      displayName: "Alice Gmail"
    });
    const bobAccount = bobStore.createAccount({
      provider: "icloud",
      email: "bob@icloud.com",
      displayName: "Bob iCloud"
    });

    server = createServer({
      store,
      authenticator: new HeaderAuthenticator()
    }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const unauthenticated = await fetch(`${baseURL}/api/accounts`);
    assert.equal(unauthenticated.status, 401);

    const aliceResponse = await requestJSON(`${baseURL}/api/accounts`, {
      headers: { Authorization: "Bearer user-alice" }
    });
    const bobResponse = await requestJSON(`${baseURL}/api/accounts`, {
      headers: { Authorization: "Bearer user-bob" }
    });

    assert.deepEqual(aliceResponse.accounts.map(account => account.id), [aliceAccount.id]);
    assert.deepEqual(bobResponse.accounts.map(account => account.id), [bobAccount.id]);

    const crossTenant = await fetch(`${baseURL}/api/accounts/${bobAccount.id}`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer user-alice",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ displayName: "Compromised" })
    });
    assert.equal(crossTenant.status, 404);
    assert.equal(bobStore.getAccount(bobAccount.id).displayName, "Bob iCloud");
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function requestJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    assert.fail(await response.text());
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

class HeaderAuthenticator {
  authenticate(req) {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
    if (!token) {
      const error = new Error("Authentication is required.");
      error.status = 401;
      throw error;
    }
    return {
      id: token,
      email: `${token}@example.com`,
      displayName: token
    };
  }
}
