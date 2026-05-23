import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "../src/http.js";
import { ProviderService } from "../src/providerAdapters.js";
import { MemorySecretStore } from "../src/secretStore.js";
import { MailStore } from "../src/store.js";

test("provider availability is app-owned and Gmail auth starts when configured", async () => {
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
