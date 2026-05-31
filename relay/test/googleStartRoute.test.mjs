import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/oauth/google/start/route.js";
import { openOAuthState } from "../lib/oauthState.js";

test("Google OAuth relay start returns an auth URL without exposing local secrets", async () => {
  await withEnv({
    CARTA_RELAY_PUBLIC_URL: "https://relay.example.test",
    CARTA_RELAY_TOKEN: "relay-token",
    CARTA_RELAY_STATE_SECRET: "state-secret",
    CARTA_RELAY_ALLOWED_CALLBACK_HOSTS: "127.0.0.1,.ts.net",
    GOOGLE_OAUTH_CLIENT_ID: "google-web-client.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-web-secret"
  }, async () => {
    const response = await POST(new Request("https://relay.example.test/api/oauth/google/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer relay-token"
      },
      body: JSON.stringify({
        state: "local-state",
        deliveryToken: "one-time-delivery-token",
        callbackURL: "http://127.0.0.1:7332/api/auth/gmail/relay/callback",
        deliveryMode: "local-code"
      })
    }));

    assert.equal(response.status, 200);
    const payload = await response.json();
    const authorizationURL = new URL(payload.authorizationURL);
    assert.equal(payload.relay, true);
    assert.equal(payload.deliveryMode, "local-code");
    assert.equal(payload.redirectURI, "http://127.0.0.1:7332/api/auth/gmail/relay/callback");
    assert.equal(authorizationURL.hostname, "accounts.google.com");
    assert.equal(authorizationURL.searchParams.get("client_id"), "google-web-client.apps.googleusercontent.com");
    assert.equal(authorizationURL.searchParams.get("redirect_uri"), payload.redirectURI);
    assert.equal(authorizationURL.searchParams.get("state"), "local-state");
  });
});

test("Google OAuth relay start can use the hosted relay callback", async () => {
  await withEnv({
    CARTA_RELAY_PUBLIC_URL: "https://relay.example.test",
    CARTA_RELAY_TOKEN: "relay-token",
    CARTA_RELAY_STATE_SECRET: "state-secret",
    CARTA_RELAY_ALLOWED_CALLBACK_HOSTS: "127.0.0.1,.ts.net",
    GOOGLE_OAUTH_CLIENT_ID: "google-web-client.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-web-secret"
  }, async () => {
    const response = await POST(new Request("https://relay.example.test/api/oauth/google/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer relay-token"
      },
      body: JSON.stringify({
        state: "local-state",
        deliveryToken: "one-time-delivery-token",
        callbackURL: "http://127.0.0.1:7332/api/auth/gmail/relay/callback"
      })
    }));

    assert.equal(response.status, 200);
    const payload = await response.json();
    const authorizationURL = new URL(payload.authorizationURL);
    assert.equal(payload.deliveryMode, "relay-callback");
    assert.equal(payload.redirectURI, "https://relay.example.test/api/oauth/google/callback");
    assert.equal(authorizationURL.searchParams.get("redirect_uri"), payload.redirectURI);
    assert.equal(authorizationURL.searchParams.get("state").includes("local-state"), false);

    const relayState = openOAuthState(authorizationURL.searchParams.get("state"), "state-secret");
    assert.equal(relayState.localState, "local-state");
    assert.equal(relayState.deliveryToken, "one-time-delivery-token");
    assert.equal(relayState.callbackURL, "http://127.0.0.1:7332/api/auth/gmail/relay/callback");
  });
});

test("Google OAuth relay start does not require a CLI relay token", async () => {
  await withEnv({
    CARTA_RELAY_PUBLIC_URL: "https://relay.example.test",
    CARTA_RELAY_STATE_SECRET: "state-secret",
    GOOGLE_OAUTH_CLIENT_ID: "google-web-client.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-web-secret"
  }, async () => {
    const response = await POST(new Request("https://relay.example.test/api/oauth/google/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: "local-state",
        deliveryToken: "one-time-delivery-token",
        callbackURL: "http://127.0.0.1:7332/api/auth/gmail/relay/callback"
      })
    }));

    assert.equal(response.status, 200);
    const payload = await response.json();
    const authorizationURL = new URL(payload.authorizationURL);
    assert.equal(authorizationURL.searchParams.get("redirect_uri"), "https://relay.example.test/api/oauth/google/callback");
  });
});

async function withEnv(values, callback) {
  const oldValues = {};
  const keys = Object.keys(values);
  for (const key of keys) {
    oldValues[key] = process.env[key];
    process.env[key] = values[key];
  }
  try {
    await callback();
  } finally {
    for (const key of keys) {
      if (oldValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = oldValues[key];
      }
    }
  }
}
