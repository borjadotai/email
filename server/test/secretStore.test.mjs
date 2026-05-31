import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultSecretStore, FileSecretStore } from "../src/secretStore.js";

test("FileSecretStore persists and deletes secrets with private permissions", () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-secret-store-"));
  try {
    const path = join(temp, "secrets.json");
    const first = new FileSecretStore({ filePath: path });
    first.set("account:one:gmail.refresh_token", "refresh-token");

    const second = new FileSecretStore({ filePath: path });
    assert.equal(second.get("account:one:gmail.refresh_token"), "refresh-token");

    second.delete("account:one:gmail.refresh_token");
    assert.equal(first.get("account:one:gmail.refresh_token"), null);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("default secret store uses file storage on Linux", () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-secret-default-"));
  try {
    const store = createDefaultSecretStore({
      env: {},
      dataDir: temp,
      platform: "linux"
    });
    store.set("relay", "token");
    assert.equal(store.get("relay"), "token");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
