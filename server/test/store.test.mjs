import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { senderLogoURLForEmail } from "../src/logoResolver.js";
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

test("search results are sorted by newest received date first", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const older = store.upsertProviderEmail(testProviderEmail({
      id: "older-relevant",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-search-older",
      senderName: "Older Sender",
      senderEmail: "older@example.com",
      subject: "invoice invoice invoice",
      bodyText: "invoice invoice invoice",
      receivedAt: "2026-05-21T10:00:00.000Z"
    }));
    const newer = store.upsertProviderEmail(testProviderEmail({
      id: "newer-less-relevant",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-search-newer",
      senderName: "Newer Sender",
      senderEmail: "newer@example.com",
      subject: "Payment details",
      bodyText: "The invoice is attached.",
      receivedAt: "2026-05-23T10:00:00.000Z"
    }));

    const results = store.listEmails({ q: "invoice" });

    assert.deepEqual(results.map(email => email.id), [newer.id, older.id]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search indexes HTML body text and rebuilds stale indexes", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const databasePath = join(dir, "mail.sqlite");
  let store = new MailStore({ databasePath });
  let reopened;

  try {
    const account = store.createAccount({
      provider: "icloud",
      email: "person@icloud.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const saved = store.upsertProviderEmail(testProviderEmail({
      id: "html-only-body",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-html-search",
      senderName: "HTML Sender",
      senderEmail: "html@example.com",
      subject: "HTML body",
      bodyText: "",
      bodyHTML: "<html><body><p>Your nebulaSearch code is ready.</p></body></html>"
    }));

    assert.equal(store.listEmails({ q: "nebulaSearch" })[0].id, saved.id);

    store.db.prepare("DELETE FROM email_fts").run();
    store.db.prepare(`
      INSERT INTO email_fts (email_id, account_id, subject, sender_name, sender_email, recipients, snippet, body_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(saved.id, account.id, saved.subject, saved.senderName, saved.senderEmail, saved.recipients.join(" "), saved.snippet, "");
    store.setSetting("search.indexVersion", "1");
    assert.equal(store.listEmails({ q: "nebulaSearch" }).length, 0);

    store.close();
    store = null;

    reopened = new MailStore({ databasePath });
    assert.equal(reopened.listEmails({ q: "nebulaSearch" })[0].id, saved.id);
  } finally {
    reopened?.close();
    store?.close();
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
      bodyHTML: "<p><strong>Fast</strong> local email search foundation.</p>",
      trackOpens: true
    });

    assert.equal(sent.outboundStatus, "queued");
    assert.ok(sent.trackingId);
    assert.equal(sent.bodyHTML, "<p><strong>Fast</strong> local email search foundation.</p>");

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

test("sends replies in the original conversation thread", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const original = store.upsertProviderEmail(testProviderEmail({
      id: "thread-original",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-thread-original",
      threadId: "provider-thread-1",
      senderName: "Friend",
      senderEmail: "friend@example.com",
      recipients: [account.email],
      rfcMessageID: "<original@example.com>",
      references: ["<root@example.com>"]
    }));

    const reply = store.sendMessage({
      accountId: account.id,
      to: "friend@example.com",
      subject: "Re: Hello",
      bodyText: "Thanks.",
      trackOpens: false,
      replyToEmailID: original.id
    });

    assert.equal(reply.threadId, original.threadId);
    assert.equal(reply.inReplyTo, "<original@example.com>");
    assert.deepEqual(reply.references, ["<root@example.com>", "<original@example.com>"]);
    assert.match(reply.rfcMessageID, /^<.+@example\.com>$/u);
    assert.deepEqual(store.listThreadEmails(original.id).map(email => email.id), [original.id, reply.id]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("groups conversation messages across connected accounts with RFC headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const gmail = store.createAccount({
      provider: "gmail",
      email: "person@gmail.com",
      displayName: "Person"
    });
    const iCloud = store.createAccount({
      provider: "icloud",
      email: "person@icloud.com",
      displayName: "Person"
    });
    const gmailSent = store.mailboxForRole(gmail.id, "sent");
    const iCloudInbox = store.mailboxForRole(iCloud.id, "inbox");

    const original = store.upsertProviderEmail(testProviderEmail({
      id: "cross-account-original",
      accountId: gmail.id,
      mailboxId: gmailSent.id,
      providerUID: "gmail-sent-original",
      threadId: "gmail-thread-1",
      senderName: "Person",
      senderEmail: gmail.email,
      recipients: [iCloud.email],
      rfcMessageID: "<original@example.com>",
      sentAt: "2026-05-23T10:00:00.000Z",
      receivedAt: "2026-05-23T10:00:00.000Z",
      createdAt: "2026-05-23T10:00:00.000Z"
    }));
    const reply = store.upsertProviderEmail(testProviderEmail({
      id: "cross-account-reply",
      accountId: iCloud.id,
      mailboxId: iCloudInbox.id,
      providerUID: "icloud-inbox-reply",
      threadId: "<original@example.com>",
      senderName: "Friend",
      senderEmail: "friend@example.com",
      recipients: [iCloud.email],
      rfcMessageID: "<reply@example.com>",
      inReplyTo: "<original@example.com>",
      references: ["<original@example.com>"],
      sentAt: "2026-05-23T10:02:00.000Z",
      receivedAt: "2026-05-23T10:02:00.000Z",
      createdAt: "2026-05-23T10:02:00.000Z"
    }));

    assert.deepEqual(store.listThreadEmails(original.id).map(email => email.id), [original.id, reply.id]);
    assert.deepEqual(store.listThreadEmails(reply.id).map(email => email.id), [original.id, reply.id]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archives messages into the account archive mailbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const saved = store.upsertProviderEmail(testProviderEmail({
      id: "archive-candidate",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-archive-1",
      senderName: "Archive Sender",
      senderEmail: "archive@example.com",
      isRead: false
    }));

    assert.equal(store.listMailboxes(account.id).find(mailbox => mailbox.role === "inbox").unreadCount, 1);

    const archived = store.archiveEmail(saved.id);

    assert.equal(archived.mailboxRole, "archive");
    assert.equal(store.getEmail(saved.id).mailboxRole, "archive");
    assert.equal(store.listMailboxes(account.id).find(mailbox => mailbox.role === "inbox").unreadCount, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filters message lists by mailbox role", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const inboxEmail = store.upsertProviderEmail(testProviderEmail({
      id: "role-filter-inbox",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-role-filter-inbox",
      senderName: "Inbox Sender",
      senderEmail: "inbox@example.com"
    }));
    const archiveEmail = store.upsertProviderEmail(testProviderEmail({
      id: "role-filter-archive",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-role-filter-archive",
      senderName: "Archive Sender",
      senderEmail: "archive@example.com"
    }));

    store.archiveEmail(archiveEmail.id);

    assert.deepEqual(store.listEmails({ accountId: account.id, mailboxRole: "inbox" }).map(email => email.id), [inboxEmail.id]);
    assert.deepEqual(store.listEmails({ accountId: account.id, mailboxRole: "archive" }).map(email => email.id), [archiveEmail.id]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reclassifies only same-account inbox messages as sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const gmail = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const icloud = store.createAccount({
      provider: "icloud",
      email: "person@icloud.com",
      displayName: "Person iCloud"
    });
    const inbox = store.mailboxForRole(icloud.id, "inbox");
    const selfAuthored = store.upsertProviderEmail(testProviderEmail({
      id: "self-authored-inbox",
      accountId: icloud.id,
      mailboxId: inbox.id,
      providerUID: "provider-self-authored-inbox",
      senderName: "Person iCloud",
      senderEmail: icloud.email,
      isRead: false
    }));
    const crossAccountInbound = store.upsertProviderEmail(testProviderEmail({
      id: "cross-account-inbound",
      accountId: icloud.id,
      mailboxId: inbox.id,
      providerUID: "provider-cross-account-inbound",
      senderName: "Person",
      senderEmail: gmail.email,
      recipients: [icloud.email],
      isRead: false
    }));
    const unrelated = store.upsertProviderEmail(testProviderEmail({
      id: "unrelated-inbox",
      accountId: icloud.id,
      mailboxId: inbox.id,
      providerUID: "provider-unrelated-inbox",
      senderName: "Friend",
      senderEmail: "friend@example.com",
      isRead: false
    }));

    assert.equal(store.isLocalUserEmail("Person <person@example.com>"), true);
    assert.equal(store.isLocalUserEmail(gmail.email), true);
    assert.equal(store.isAccountIdentityEmail(icloud.id, gmail.email), false);
    assert.equal(store.isAccountIdentityEmail(icloud.id, icloud.email), true);
    assert.equal(store.displayNameForLocalUserEmail(gmail.email), "Person");
    assert.equal(store.reclassifyLocalUserInboxMessages(), 1);

    assert.equal(store.getEmail(selfAuthored.id).mailboxRole, "sent");
    assert.equal(store.getEmail(crossAccountInbound.id).mailboxRole, "inbox");
    assert.equal(store.getEmail(unrelated.id).mailboxRole, "inbox");
    assert.equal(store.listMailboxes(icloud.id).find(mailbox => mailbox.role === "inbox").unreadCount, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repairs cross-account inbound messages previously filed as sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const gmail = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const icloud = store.createAccount({
      provider: "icloud",
      email: "person@icloud.com",
      displayName: "Person iCloud"
    });
    const sent = store.mailboxForRole(icloud.id, "sent");
    const misfiled = store.upsertProviderEmail(testProviderEmail({
      id: "cross-account-misfiled",
      accountId: icloud.id,
      mailboxId: sent.id,
      providerUID: "provider-cross-account-misfiled",
      senderName: "Person",
      senderEmail: gmail.email,
      recipients: [icloud.email],
      isRead: false
    }));

    assert.equal(store.getEmail(misfiled.id).mailboxRole, "sent");
    assert.equal(store.repairCrossAccountSentMisclassifications(), 1);
    assert.equal(store.getEmail(misfiled.id).mailboxRole, "inbox");
    assert.equal(store.listMailboxes(icloud.id).find(mailbox => mailbox.role === "inbox").unreadCount, 1);
    assert.equal(store.listMailboxes(icloud.id).find(mailbox => mailbox.role === "sent").unreadCount, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uses account display names for self-authored provider messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const sent = store.mailboxForRole(account.id, "sent");

    const saved = store.upsertProviderEmail(testProviderEmail({
      id: "self-authored-provider",
      accountId: account.id,
      mailboxId: sent.id,
      providerUID: "provider-self-authored-provider",
      senderName: "person@example.com",
      senderEmail: "person@example.com"
    }));

    assert.equal(saved.senderName, "Person");

    store.db.prepare("UPDATE emails SET sender_name = sender_email WHERE id = ?").run(saved.id);
    assert.equal(store.repairLocalUserSenderNames(), 1);
    assert.equal(store.getEmail(saved.id).senderName, "Person");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates account settings and rewrites self-authored sender names", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person",
      syncHistory: true
    });
    const sent = store.mailboxForRole(account.id, "sent");
    const saved = store.upsertProviderEmail(testProviderEmail({
      id: "settings-sender-name",
      accountId: account.id,
      mailboxId: sent.id,
      providerUID: "provider-settings-sender-name",
      senderName: "Person",
      senderEmail: "person@example.com"
    }));

    const updated = store.updateAccountSettings(account.id, {
      displayName: "Person Updated",
      avatarURL: "https://example.com/person-updated.jpg",
      syncHistory: false
    });

    assert.equal(updated.displayName, "Person Updated");
    assert.equal(updated.avatarURL, "https://example.com/person-updated.jpg");
    assert.equal(updated.syncHistory, false);
    assert.equal(store.getEmail(saved.id).senderName, "Person Updated");
    assert.equal(store.getEmail(saved.id).senderAvatarURL, "https://example.com/person-updated.jpg");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moves messages into the account trash mailbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const saved = store.upsertProviderEmail(testProviderEmail({
      id: "trash-candidate",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-trash-1",
      senderName: "Trash Sender",
      senderEmail: "trash@example.com",
      isRead: false
    }));

    const trashed = store.trashEmail(saved.id);

    assert.equal(trashed.mailboxRole, "trash");
    assert.equal(store.getEmail(saved.id).mailboxRole, "trash");
    assert.equal(store.listMailboxes(account.id).find(mailbox => mailbox.role === "inbox").unreadCount, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("derives account avatars from stored sender avatars", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const sent = store.mailboxForRole(account.id, "sent");
    const avatarURL = "https://example.com/person.png";

    store.upsertProviderEmail({
      id: "email-with-avatar",
      accountId: account.id,
      mailboxId: sent.id,
      providerUID: "provider-avatar-1",
      threadId: "thread-avatar-1",
      senderName: "Person",
      senderEmail: "person@example.com",
      senderAvatarURL: avatarURL,
      recipients: ["friend@example.com"],
      cc: [],
      bcc: [],
      subject: "Avatar source",
      snippet: "An email with a sender image.",
      bodyText: "An email with a sender image.",
      bodyHTML: null,
      sentAt: "2026-05-23T10:00:00.000Z",
      receivedAt: "2026-05-23T10:00:00.000Z",
      isRead: true,
      isStarred: false,
      importance: "normal",
      hasAttachments: false,
      trackingId: null,
      openedAt: null,
      createdAt: "2026-05-23T10:00:00.000Z"
    });

    assert.equal(store.getAccount(account.id).avatarURL, avatarURL);
    assert.equal(store.listAccounts()[0].avatarURL, avatarURL);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fills email sender avatars from the sender domain logo", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");

    const saved = store.upsertProviderEmail({
      id: "email-with-domain-logo",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-logo-1",
      threadId: "thread-logo-1",
      senderName: "Apple",
      senderEmail: "noreply@email.apple.com",
      senderAvatarURL: null,
      recipients: ["person@example.com"],
      cc: [],
      bcc: [],
      subject: "Domain logo source",
      snippet: "An email without an explicit sender image.",
      bodyText: "An email without an explicit sender image.",
      bodyHTML: null,
      sentAt: "2026-05-23T10:00:00.000Z",
      receivedAt: "2026-05-23T10:00:00.000Z",
      isRead: true,
      isStarred: false,
      importance: "normal",
      hasAttachments: false,
      trackingId: null,
      openedAt: null,
      createdAt: "2026-05-23T10:00:00.000Z"
    });
    const expectedLogoURL = senderLogoURLForEmail("noreply@email.apple.com");

    assert.equal(saved.senderAvatarURL, expectedLogoURL);
    assert.equal(store.listEmails()[0].senderAvatarURL, expectedLogoURL);
    assert.equal(store.getEmail(saved.id).senderAvatarURL, expectedLogoURL);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("marks messages as spam", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const saved = store.upsertProviderEmail(testProviderEmail({
      id: "spam-candidate",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-spam-1",
      senderName: "Pushy Sender",
      senderEmail: "alerts@noise.example"
    }));

    const spammed = store.markEmailSpam(saved.id);

    assert.equal(store.getEmail(saved.id).providerUID, "provider-spam-1");
    assert.equal(spammed.mailboxRole, "spam");
    assert.equal(store.mailboxForRole(account.id, "spam").role, "spam");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocks an exact sender and routes future messages to spam", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const first = store.upsertProviderEmail(testProviderEmail({
      id: "blocked-first",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-blocked-1",
      senderName: "Persistent Sender",
      senderEmail: "alerts@noise.example"
    }));
    store.upsertProviderEmail(testProviderEmail({
      id: "other-sender",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-other-1",
      senderName: "Other Sender",
      senderEmail: "team@noise.example"
    }));

    const result = store.blockSenderForEmail(first.id, "email");
    assert.equal(result.rule.scope, "email");
    assert.equal(result.rule.value, "alerts@noise.example");
    assert.equal(result.affectedCount, 1);
    assert.equal(result.email.mailboxRole, "spam");

    const future = store.upsertProviderEmail(testProviderEmail({
      id: "blocked-future",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-blocked-2",
      senderName: "Persistent Sender",
      senderEmail: "alerts@noise.example"
    }));

    assert.equal(future.mailboxRole, "spam");
    assert.equal(store.listEmails({ mailboxId: inbox.id }).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocks a sender domain and includes subdomains", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const account = store.createAccount({
      provider: "icloud",
      email: "person@icloud.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const first = store.upsertProviderEmail(testProviderEmail({
      id: "domain-first",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-domain-1",
      senderName: "Marketing",
      senderEmail: "hello@mail.vendor.example"
    }));

    const result = store.blockSenderForEmail(first.id, "domain");
    assert.equal(result.rule.scope, "domain");
    assert.equal(result.rule.value, "mail.vendor.example");

    const future = store.upsertProviderEmail(testProviderEmail({
      id: "domain-future",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-domain-2",
      senderName: "Marketing",
      senderEmail: "offers@eu.mail.vendor.example"
    }));
    const unrelated = store.upsertProviderEmail(testProviderEmail({
      id: "domain-unrelated",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-domain-3",
      senderName: "Useful",
      senderEmail: "team@vendor.example"
    }));

    assert.equal(future.mailboxRole, "spam");
    assert.equal(unrelated.mailboxRole, "inbox");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registers and refreshes push notification tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const first = store.registerPushToken({
      token: "a".repeat(64),
      platform: "ios",
      bundleId: "com.borjadotai.email.ios",
      environment: "development",
      deviceName: "Borja"
    });
    const updated = store.registerPushToken({
      token: "a".repeat(64),
      platform: "ios",
      bundleId: "com.borjadotai.email.ios",
      environment: "development",
      deviceName: "Borja iPhone"
    });

    assert.equal(first.id, updated.id);
    assert.equal(updated.deviceName, "Borja iPhone");
    assert.equal(store.listPushTokens().length, 1);

    store.disablePushToken(updated.id, "Unregistered");
    assert.equal(store.listPushTokens().length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scopes accounts, search results, and push tokens to the current app user", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const aliceStore = store.forUser({
      id: "user-alice",
      email: "alice@example.com",
      displayName: "Alice"
    });
    const bobStore = store.forUser({
      id: "user-bob",
      email: "bob@example.com",
      displayName: "Bob"
    });

    const aliceAccount = aliceStore.createAccount({
      provider: "gmail",
      email: "alice@gmail.com",
      displayName: "Alice Gmail"
    });
    const bobAccount = bobStore.createAccount({
      provider: "icloud",
      email: "bob@icloud.com",
      displayName: "Bob iCloud"
    });

    const aliceInbox = aliceStore.mailboxForRole(aliceAccount.id, "inbox");
    const bobInbox = bobStore.mailboxForRole(bobAccount.id, "inbox");

    const aliceEmail = aliceStore.upsertProviderEmail(testProviderEmail({
      id: "alice-email",
      accountId: aliceAccount.id,
      mailboxId: aliceInbox.id,
      providerUID: "alice-provider-email",
      senderName: "Project",
      senderEmail: "project@example.com",
      subject: "Quarterly launch plan",
      bodyText: "The launch plan is ready."
    }));
    const bobEmail = bobStore.upsertProviderEmail(testProviderEmail({
      id: "bob-email",
      accountId: bobAccount.id,
      mailboxId: bobInbox.id,
      providerUID: "bob-provider-email",
      senderName: "Project",
      senderEmail: "project@example.com",
      subject: "Quarterly launch plan",
      bodyText: "The launch plan is ready."
    }));

    aliceStore.registerPushToken({
      token: "a".repeat(64),
      platform: "ios",
      bundleId: "com.borjadotai.email.ios",
      environment: "development",
      deviceName: "Alice iPhone"
    });
    bobStore.registerPushToken({
      token: "b".repeat(64),
      platform: "ios",
      bundleId: "com.borjadotai.email.ios",
      environment: "development",
      deviceName: "Bob iPhone"
    });

    assert.deepEqual(aliceStore.listAccounts().map(account => account.id), [aliceAccount.id]);
    assert.deepEqual(bobStore.listAccounts().map(account => account.id), [bobAccount.id]);
    assert.equal(aliceStore.getAccount(bobAccount.id), null);
    assert.equal(bobStore.getAccount(aliceAccount.id), null);
    assert.deepEqual(aliceStore.listEmails({ q: "launch" }).map(email => email.id), [aliceEmail.id]);
    assert.deepEqual(bobStore.listEmails({ q: "launch" }).map(email => email.id), [bobEmail.id]);
    assert.equal(aliceStore.getEmail(bobEmail.id), null);
    assert.equal(bobStore.getEmail(aliceEmail.id), null);
    assert.deepEqual(aliceStore.listPushTokens().map(token => token.deviceName), ["Alice iPhone"]);
    assert.deepEqual(bobStore.listPushTokens().map(token => token.deviceName), ["Bob iPhone"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function testProviderEmail(overrides = {}) {
  return {
    id: overrides.id,
    accountId: overrides.accountId,
    mailboxId: overrides.mailboxId,
    providerUID: overrides.providerUID,
    threadId: overrides.threadId ?? overrides.providerUID,
    senderName: overrides.senderName,
    senderEmail: overrides.senderEmail,
    senderAvatarURL: overrides.senderAvatarURL ?? null,
    recipients: overrides.recipients ?? ["person@example.com"],
    cc: [],
    bcc: [],
    subject: overrides.subject ?? "Hello",
    snippet: overrides.snippet ?? "A short message.",
    bodyText: overrides.bodyText ?? "A short message.",
    bodyHTML: overrides.bodyHTML ?? null,
    rfcMessageID: overrides.rfcMessageID ?? null,
    inReplyTo: overrides.inReplyTo ?? null,
    references: overrides.references ?? [],
    sentAt: overrides.sentAt ?? "2026-05-23T10:00:00.000Z",
    receivedAt: overrides.receivedAt ?? "2026-05-23T10:00:00.000Z",
    isRead: overrides.isRead ?? true,
    isStarred: false,
    importance: "normal",
    hasAttachments: false,
    trackingId: null,
    openedAt: null,
    createdAt: overrides.createdAt ?? "2026-05-23T10:00:00.000Z"
  };
}
