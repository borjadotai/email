import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedCallbackURL, openDeliveryPayload, openOAuthState, sealDeliveryPayload, sealOAuthState } from "../lib/oauthState.js";

test("relay OAuth state round-trips and expires", () => {
  const sealed = sealOAuthState({
    localState: "local-state",
    deliveryToken: "delivery-token",
    callbackURL: "http://127.0.0.1:7332/api/auth/gmail/relay/callback",
    expiresAt: Date.now() + 1000
  }, "test-secret");
  const opened = openOAuthState(sealed, "test-secret");
  assert.equal(opened.localState, "local-state");
  assert.equal(opened.deliveryToken, "delivery-token");
});

test("relay validates callback hosts", () => {
  assert.equal(
    assertAllowedCallbackURL("http://127.0.0.1:7332/api/auth/gmail/relay/callback", ["127.0.0.1"]),
    "http://127.0.0.1:7332/api/auth/gmail/relay/callback"
  );
  assert.throws(
    () => assertAllowedCallbackURL("https://evil.example/callback", ["127.0.0.1"]),
    /not allowed/u
  );
});

test("relay delivery payload encrypts OAuth tokens for the local callback", () => {
  const sealed = sealDeliveryPayload({
    tokens: {
      refresh_token: "refresh-secret",
      access_token: "access-secret"
    }
  }, "one-time-delivery-token");

  assert.equal(sealed.includes("refresh-secret"), false);
  assert.equal(sealed.includes("access-secret"), false);

  const opened = openDeliveryPayload(sealed, "one-time-delivery-token");
  assert.equal(opened.tokens.refresh_token, "refresh-secret");
  assert.equal(opened.tokens.access_token, "access-secret");
  assert.throws(() => openDeliveryPayload(sealed, "wrong-token"), /Unsupported state|Invalid|authenticate|decrypt|bad decrypt|unable/u);
});
