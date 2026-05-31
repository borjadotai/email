import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PushNotificationService } from "../src/pushNotifications.js";
import { MailStore } from "../src/store.js";

test("push notifications can be sent through the relay without local APNs secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-push-relay-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });
  const originalFetch = globalThis.fetch;
  const calls = [];

  try {
    store.registerPushToken({
      token: "a".repeat(64),
      platform: "ios",
      bundleId: "com.borjadotai.email.ios",
      environment: "development",
      deviceName: "Borja iPhone"
    });

    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ sent: 1, failed: 0, failures: [] });
    };

    const service = new PushNotificationService({
      store,
      config: {
        relay: {
          baseURL: "https://relay.example.test",
          token: "relay-token"
        },
        apns: {}
      }
    });

    const result = await service.sendTestNotification();
    assert.equal(result.configured, true);
    assert.equal(result.sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://relay.example.test/api/push/send");
    assert.equal(calls[0].init.headers.authorization, "Bearer relay-token");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.notifications[0].topic, "com.borjadotai.email.ios");
    assert.equal(body.notifications[0].token, "a".repeat(64));
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
