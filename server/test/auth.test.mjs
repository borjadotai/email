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
    assert.equal(auth.redirectURI, `${baseURL}/api/auth/gmail/callback`);
    assert.equal(authorizationURL.searchParams.get("redirect_uri"), auth.redirectURI);
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured public base URL wins for Gmail redirect URI", async () => {
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
    const publicBaseURL = "https://space.tailb90a7f.ts.net";
    server = createServer({ store, providers, publicBaseURL }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const availability = await requestJSON(`${baseURL}/api/auth/settings`);
    assert.equal(availability.settings.gmailRedirectURI, `${publicBaseURL}/api/auth/gmail/callback`);

    const auth = await requestJSON(`${baseURL}/api/auth/gmail/start`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Test Gmail", syncHistory: false }),
      headers: { "Content-Type": "application/json" }
    });
    const authorizationURL = new URL(auth.authorizationURL);
    assert.equal(auth.redirectURI, `${publicBaseURL}/api/auth/gmail/callback`);
    assert.equal(authorizationURL.searchParams.get("redirect_uri"), auth.redirectURI);
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
