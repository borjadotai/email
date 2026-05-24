import assert from "node:assert/strict";
import test from "node:test";
import { errorContext, isTokenRefreshFailure, operationalLogEntry } from "../src/operationalLog.js";

test("operational logs redact credential-bearing fields but keep useful context", () => {
  const entry = operationalLogEntry("warn", "provider.sync.failed", {
    provider: "gmail",
    accountId: "account-1",
    refreshToken: "refresh-token-value",
    tokenRefreshFailure: true,
    nested: {
      appPassword: "icloud-password",
      imported: 12
    }
  });

  assert.equal(entry.event, "provider.sync.failed");
  assert.equal(entry.provider, "gmail");
  assert.equal(entry.accountId, "account-1");
  assert.equal(entry.refreshToken, "[redacted]");
  assert.equal(entry.tokenRefreshFailure, true);
  assert.equal(entry.nested.appPassword, "[redacted]");
  assert.equal(entry.nested.imported, 12);
});

test("operational error context identifies token refresh failures", () => {
  const error = Object.assign(new Error("invalid_grant: token has been expired or revoked"), {
    response: {
      status: 400,
      data: {
        error: "invalid_grant"
      }
    }
  });

  const context = errorContext(error);

  assert.equal(isTokenRefreshFailure(error), true);
  assert.equal(context.name, "Error");
  assert.equal(context.status, 400);
  assert.equal(context.reason, "invalid_grant");
  assert.equal(context.tokenRefreshFailure, true);
});
