import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/oauth/google/exchange/route.js";

test("Google OAuth relay exchange trades a local callback code for tokens", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    await withEnv({
      CARTA_RELAY_TOKEN: "relay-token",
      CARTA_RELAY_ALLOWED_CALLBACK_HOSTS: "127.0.0.1,.ts.net",
      GOOGLE_OAUTH_CLIENT_ID: "google-web-client.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-web-secret"
    }, async () => {
      globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init });
        return Response.json({
          refresh_token: "refresh-token",
          access_token: "access-token",
          expires_in: 3600
        });
      };

      const response = await POST(new Request("https://relay.example.test/api/oauth/google/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer relay-token"
        },
        body: JSON.stringify({
          code: "google-code",
          redirectURI: "http://127.0.0.1:7332/api/auth/gmail/relay/callback"
        })
      }));

      assert.equal(response.status, 200);
      const tokens = await response.json();
      assert.equal(tokens.refresh_token, "refresh-token");
      assert.equal(requests.length, 1);
      const body = new URLSearchParams(requests[0].init.body);
      assert.equal(body.get("client_id"), "google-web-client.apps.googleusercontent.com");
      assert.equal(body.get("client_secret"), "google-web-secret");
      assert.equal(body.get("redirect_uri"), "http://127.0.0.1:7332/api/auth/gmail/relay/callback");
      assert.equal(body.get("code"), "google-code");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
