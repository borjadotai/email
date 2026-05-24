import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EncryptedSecretStore, SecretCipher, generateSecretEncryptionKey } from "../src/encryption.js";
import { FileSecretStore, MemorySecretStore, PostgresSecretStore } from "../src/secretStore.js";

test("encrypts provider secrets before storing them", async () => {
  const backingStore = new MemorySecretStore();
  const secretStore = new EncryptedSecretStore({
    store: backingStore,
    cipher: new SecretCipher({ key: generateSecretEncryptionKey() })
  });

  await secretStore.set("account-1:gmail.refresh_token", "refresh-token-value");

  const stored = backingStore.get("account-1:gmail.refresh_token");
  assert.notEqual(stored, "refresh-token-value");
  assert.match(stored, /"alg":"aes-256-gcm"/);
  assert.equal(await secretStore.get("account-1:gmail.refresh_token"), "refresh-token-value");
});

test("binds encrypted secrets to their storage key", async () => {
  const backingStore = new MemorySecretStore();
  const cipher = new SecretCipher({ key: generateSecretEncryptionKey() });
  const secretStore = new EncryptedSecretStore({ store: backingStore, cipher });

  await secretStore.set("account-1:icloud.app_password", "app-password");
  backingStore.set("account-2:icloud.app_password", backingStore.get("account-1:icloud.app_password"));

  await assert.rejects(
    () => secretStore.get("account-2:icloud.app_password"),
    /Unsupported state|authenticate|Invalid/
  );
});

test("persists encrypted secrets in a file-backed store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-secrets-"));
  const path = join(dir, "secrets.json");

  try {
    const cipher = new SecretCipher({ key: generateSecretEncryptionKey() });
    const firstStore = new EncryptedSecretStore({
      store: new FileSecretStore({ path }),
      cipher
    });

    await firstStore.set("account-1:gmail.refresh_token", "refresh-token");

    const secondStore = new EncryptedSecretStore({
      store: new FileSecretStore({ path }),
      cipher
    });
    assert.equal(await secondStore.get("account-1:gmail.refresh_token"), "refresh-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stores encrypted provider secrets in the private Postgres schema", async () => {
  const pool = new FakePool();
  const secretStore = new PostgresSecretStore({ pool });
  const encrypted = JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    kid: "primary",
    nonce: "nonce",
    tag: "tag",
    ciphertext: "ciphertext"
  });

  await secretStore.set("account:00000000-0000-4000-8000-000000000001:gmail.refresh_token", encrypted);
  assert.deepEqual(pool.queries[0].params, [
    "00000000-0000-4000-8000-000000000001",
    "gmail.refresh_token",
    "aes-256-gcm",
    "ciphertext",
    "nonce",
    "tag",
    "primary"
  ]);
  assert.match(pool.queries[0].sql, /email_private\.provider_secrets/);
  assert.match(pool.queries[0].sql, /FROM public\.accounts/);

  const stored = await secretStore.get("account:00000000-0000-4000-8000-000000000001:gmail.refresh_token");
  assert.deepEqual(JSON.parse(stored), JSON.parse(encrypted));
});

class FakePool {
  queries = [];

  async query(sql, params) {
    this.queries.push({ sql, params });
    if (/SELECT algorithm/u.test(sql)) {
      return {
        rows: [{
          algorithm: "aes-256-gcm",
          ciphertext: "ciphertext",
          nonce: "nonce",
          authTag: "tag",
          keyId: "primary"
        }]
      };
    }
    return { rowCount: 1, rows: [{ id: "secret-id" }] };
  }
}
