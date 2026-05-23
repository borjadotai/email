import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MailStore } from "../src/store.js";

test("seeds demo accounts and searches with FTS", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite"), seedDemo: true });

  try {
    assert.equal(store.listAccounts().length, 2);
    const results = store.listEmails({ q: "receipt" });
    assert.equal(results.length, 1);
    assert.match(results[0].subject, /Receipt/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creates an account, sends a tracked message, and records opens", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const sent = store.sendMessage({
      accountId: account.id,
      to: "friend@example.com",
      subject: "Hello",
      bodyText: "Fast local email search foundation.",
      trackOpens: true
    });

    assert.equal(sent.outboundStatus, "queued");
    assert.ok(sent.trackingId);

    const opened = store.recordOpen(sent.trackingId, { userAgent: "node-test" });
    assert.equal(opened.id, sent.id);
    assert.ok(opened.openedAt);

    const archive = store.listMailboxes(account.id).find(mailbox => mailbox.role === "archive");
    const moved = store.updateEmail(sent.id, { mailboxId: archive.id });
    assert.equal(moved.mailboxRole, "archive");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
