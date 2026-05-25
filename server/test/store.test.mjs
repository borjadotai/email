import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fallbackFilterQueryPlan } from "../src/filterQueryPlanner.js";
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
  const store = new MailStore({
    databasePath: join(dir, "mail.sqlite"),
    filterQueryPlanner: fallbackFilterQueryPlan
  });

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

test("creates editable global labels and filters across accounts", () => {
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
    const gmailInbox = store.mailboxForRole(gmail.id, "inbox");
    const icloudInbox = store.mailboxForRole(icloud.id, "inbox");
    const gmailEmail = store.upsertProviderEmail(testProviderEmail({
      id: "global-label-gmail",
      accountId: gmail.id,
      mailboxId: gmailInbox.id,
      providerUID: "provider-global-label-gmail",
      senderName: "Gmail Sender",
      senderEmail: "gmail@example.com",
      receivedAt: "2026-05-23T10:00:00.000Z"
    }));
    const icloudEmail = store.upsertProviderEmail(testProviderEmail({
      id: "global-label-icloud",
      accountId: icloud.id,
      mailboxId: icloudInbox.id,
      providerUID: "provider-global-label-icloud",
      senderName: "iCloud Sender",
      senderEmail: "icloud@example.com",
      receivedAt: "2026-05-23T11:00:00.000Z"
    }));

    const label = store.createLabel({ name: "Follow Up", color: "teal", icon: "flag" });
    assert.equal(label.accountId, null);
    assert.equal(label.color, "teal");
    assert.equal(label.icon, "flag");

    store.setEmailLabel(gmailEmail.id, label.id, "add");
    store.setEmailLabel(icloudEmail.id, label.id, "add");

    assert.deepEqual(
      store.listEmails({ labelId: label.id }).map(email => email.id),
      [icloudEmail.id, gmailEmail.id]
    );
    assert.equal(store.getEmail(gmailEmail.id).labels[0].icon, "flag");

    const updated = store.updateLabel(label.id, { name: "Waiting", color: "purple", icon: "clock" });
    assert.equal(updated.name, "Waiting");
    assert.equal(updated.color, "purple");
    assert.equal(updated.icon, "clock");
    assert.equal(store.getEmail(gmailEmail.id).labels[0].name, "Waiting");

    const accountLabel = store.createLabel({ accountId: gmail.id, name: "Gmail Only", color: "blue", icon: "tag" });
    assert.throws(
      () => store.setEmailLabel(icloudEmail.id, accountLabel.id, "add"),
      /different account/u
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creates saved filters from natural language and applies them dynamically", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({
    databasePath: join(dir, "mail.sqlite"),
    filterQueryPlanner: fallbackFilterQueryPlan
  });

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
    const gmailInbox = store.mailboxForRole(gmail.id, "inbox");
    const icloudInbox = store.mailboxForRole(icloud.id, "inbox");

    const invoice = store.upsertProviderEmail(testProviderEmail({
      id: "invoice-filter-hit",
      accountId: gmail.id,
      mailboxId: gmailInbox.id,
      providerUID: "provider-invoice-filter-hit",
      senderName: "Shop",
      senderEmail: "shop@example.com",
      subject: "Your invoice is attached",
      bodyText: "Please find your invoice attached.",
      receivedAt: "2026-05-23T10:00:00.000Z",
      attachments: [{ filename: "invoice-123.pdf", mimeType: "application/pdf", size: 128 }]
    }));
    const imageOnly = store.upsertProviderEmail(testProviderEmail({
      id: "invoice-filter-miss-image",
      accountId: gmail.id,
      mailboxId: gmailInbox.id,
      providerUID: "provider-invoice-filter-miss-image",
      senderName: "Photos",
      senderEmail: "photos@example.com",
      subject: "Weekend photos",
      bodyText: "A few images.",
      receivedAt: "2026-05-23T11:00:00.000Z",
      attachments: [{ filename: "photo.png", mimeType: "image/png", size: 128 }]
    }));
    const noAttachment = store.upsertProviderEmail(testProviderEmail({
      id: "invoice-filter-miss-no-attachment",
      accountId: icloud.id,
      mailboxId: icloudInbox.id,
      providerUID: "provider-invoice-filter-miss-no-attachment",
      senderName: "Billing",
      senderEmail: "billing@example.com",
      subject: "Invoice reminder",
      bodyText: "No attachment here.",
      receivedAt: "2026-05-23T12:00:00.000Z"
    }));

    const filter = store.createFilter({
      naturalLanguage: "All emails from any sender that contain an attachment that is an invoice"
    });

    assert.equal(filter.name, "Invoices");
    assert.equal(filter.criteria.hasAttachments, true);
    assert.equal(filter.criteria.attachmentKind, "invoice");
    assert.equal(filter.querySource, "heuristic");
    assert.deepEqual(store.listEmails({ filterId: filter.id }).map(email => email.id), [invoice.id]);

    const laterInvoice = store.upsertProviderEmail(testProviderEmail({
      id: "invoice-filter-hit-later",
      accountId: icloud.id,
      mailboxId: icloudInbox.id,
      providerUID: "provider-invoice-filter-hit-later",
      senderName: "Proveedor",
      senderEmail: "proveedor@example.com",
      subject: "Factura mayo",
      bodyText: "Factura adjunta.",
      receivedAt: "2026-05-24T10:00:00.000Z",
      attachments: [{ filename: "factura-mayo.pdf", mimeType: "application/pdf", size: 128 }]
    }));

    assert.deepEqual(store.listEmails({ filterId: filter.id }).map(email => email.id), [invoice.id]);
    assert.deepEqual(store.listEmails({ filterId: filter.id, refreshFilter: "1" }).map(email => email.id), [laterInvoice.id, invoice.id]);
    assert.ok(!store.listEmails({ filterId: filter.id }).some(email => email.id === imageOnly.id));
    assert.ok(!store.listEmails({ filterId: filter.id }).some(email => email.id === noAttachment.id));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uses AI generated saved filter queries and refreshes cached results", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({
    databasePath: join(dir, "mail.sqlite"),
    filterQueryPlanner: () => ({
      name: "Newsletters",
      color: "purple",
      icon: "newspaper",
      source: "codex",
      sql: `SELECT e.id
FROM emails e
WHERE lower(e.body_text) LIKE '%unsubscribe%'
   OR lower(e.subject) LIKE '%newsletter%'
ORDER BY e.received_at DESC`
    })
  });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const first = store.upsertProviderEmail(testProviderEmail({
      id: "newsletter-filter-hit",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-newsletter-filter-hit",
      senderName: "Daily Notes",
      senderEmail: "daily@example.com",
      subject: "Today's newsletter",
      bodyText: "Welcome. Unsubscribe here.",
      receivedAt: "2026-05-23T10:00:00.000Z"
    }));
    store.upsertProviderEmail(testProviderEmail({
      id: "newsletter-filter-miss",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-newsletter-filter-miss",
      senderName: "Friend",
      senderEmail: "friend@example.com",
      subject: "Lunch",
      bodyText: "Want to get lunch?",
      receivedAt: "2026-05-23T11:00:00.000Z"
    }));

    const filter = store.createFilter({
      naturalLanguage: "Create a view for all my newsletters"
    });

    assert.equal(filter.querySource, "codex");
    assert.equal(filter.name, "Newsletters");
    assert.deepEqual(store.listEmails({ filterId: filter.id }).map(email => email.id), [first.id]);

    const later = store.upsertProviderEmail(testProviderEmail({
      id: "newsletter-filter-hit-later",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-newsletter-filter-hit-later",
      senderName: "Digest",
      senderEmail: "digest@example.com",
      subject: "Morning links",
      bodyText: "Read online. Unsubscribe here.",
      receivedAt: "2026-05-24T10:00:00.000Z"
    }));

    assert.deepEqual(store.listEmails({ filterId: filter.id }).map(email => email.id), [first.id]);
    assert.deepEqual(store.listEmails({ filterId: filter.id, refreshFilter: "1" }).map(email => email.id), [later.id, first.id]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deletes saved filters without deleting matching emails", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-store-"));
  const store = new MailStore({
    databasePath: join(dir, "mail.sqlite"),
    filterQueryPlanner: fallbackFilterQueryPlan
  });

  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const email = store.upsertProviderEmail(testProviderEmail({
      id: "delete-filter-email",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-delete-filter-email",
      senderName: "Shop",
      senderEmail: "shop@example.com",
      subject: "Your invoice",
      bodyText: "Invoice attached.",
      attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 128 }]
    }));
    const filter = store.createFilter({
      naturalLanguage: "Create a view for all my invoices"
    });

    assert.deepEqual(store.listEmails({ filterId: filter.id }).map(item => item.id), [email.id]);
    const deleted = store.deleteFilter(filter.id);

    assert.equal(deleted.id, filter.id);
    assert.equal(store.getFilter(filter.id), null);
    assert.equal(store.getEmail(email.id).id, email.id);
    assert.deepEqual(store.listEmails().map(item => item.id), [email.id]);
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

function testProviderEmail(overrides = {}) {
  const attachments = overrides.attachments;
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
    hasAttachments: overrides.hasAttachments ?? Boolean(attachments?.length),
    attachments,
    trackingId: null,
    openedAt: null,
    createdAt: overrides.createdAt ?? "2026-05-23T10:00:00.000Z"
  };
}
