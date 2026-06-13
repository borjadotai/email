import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMailRuntime } from "../src/runtime.js";

test("runtime waits for in-flight background work before closing the store", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-runtime-close-"));
  try {
    const runtime = createMailRuntime({
      env: {
        CARTA_CLI: "1",
        EMAIL_DATA_DIR: temp,
        EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
        EMAIL_SERVER_HOST: "127.0.0.1",
        EMAIL_SERVER_PORT: "0",
        EMAIL_AUTO_HISTORY_BACKFILL: "0",
        EMAIL_AUTO_SYNC: "0"
      },
      logger: quietLogger()
    });
    runtime.store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person",
      authType: "gmail_oauth"
    });

    let releaseBackfill;
    const backfillStarted = new Promise(resolveStarted => {
      runtime.providers.backfillAccountHistory = async () => {
        resolveStarted();
        await new Promise(resolveRelease => {
          releaseBackfill = resolveRelease;
        });
        return { imported: 0, complete: false };
      };
    });

    let storeClosed = false;
    const originalClose = runtime.store.close.bind(runtime.store);
    runtime.store.close = () => {
      storeClosed = true;
      originalClose();
    };

    const backfill = runtime.runHistoryBackfillPass();
    await backfillStarted;
    assert.equal(runtime.store.getAccount(runtime.store.listAccounts()[0].id).providerMetadata.cartaSyncStatus.status, "running");

    let closeResolved = false;
    const close = new Promise(resolveClose => {
      runtime.close(() => {
        closeResolved = true;
        resolveClose();
      });
    });

    await sleep(100);
    assert.equal(storeClosed, false);
    assert.equal(closeResolved, false);

    releaseBackfill();
    await close;
    await backfill;
    assert.equal(storeClosed, true);
    assert.equal(closeResolved, true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("auto sync marks revoked Gmail tokens as needing auth", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-runtime-auth-failure-"));
  try {
    const runtime = createMailRuntime({
      env: {
        CARTA_CLI: "1",
        EMAIL_DATA_DIR: temp,
        EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
        EMAIL_SERVER_HOST: "127.0.0.1",
        EMAIL_SERVER_PORT: "0",
        EMAIL_AUTO_HISTORY_BACKFILL: "0",
        EMAIL_AUTO_SYNC: "0"
      },
      logger: quietLogger()
    });
    const account = runtime.store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person",
      authType: "gmail_oauth",
      status: "connected"
    });

    runtime.providers.syncAccount = async () => {
      throw Object.assign(new Error("Token has been expired or revoked."), { status: 502 });
    };

    await runtime.runAutoSyncPass();

    const updated = runtime.store.getAccount(account.id);
    assert.equal(updated.status, "needs_auth");
    assert.equal(updated.providerMetadata.cartaSyncStatus.status, "failed");
    assert.match(updated.providerMetadata.cartaSyncStatus.error, /Gmail needs to be reconnected/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function quietLogger() {
  return {
    log() {},
    warn() {},
    error() {}
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
