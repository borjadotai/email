import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fallbackFilterQueryPlan } from "../src/filterQueryPlanner.js";
import { fallbackInboxTriagePlan, InboxTriageService } from "../src/inboxTriage.js";
import { MailStore } from "../src/store.js";

test("inbox triage classifies unread inbox messages and caches matching signatures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-triage-"));
  const store = new MailStore({
    databasePath: join(dir, "mail.sqlite"),
    filterQueryPlanner: fallbackFilterQueryPlan
  });
  let classifierCalls = 0;
  const triage = new InboxTriageService({
    store,
    classifier: emails => {
      classifierCalls += 1;
      return {
        source: "test",
        summaryBullets: ["One message needs attention."],
        read: [{
          id: emails.find(email => email.subject.includes("Security")).id,
          priority: "high",
          reason: "Security alert.",
          summaryBullets: ["Apple reported a new sign-in."]
        }],
        archive: [{
          id: emails.find(email => email.subject.includes("Sale")).id,
          priority: "low",
          reason: "Promotional update."
        }]
      };
    }
  });

  try {
    const account = store.createAccount({
      provider: "icloud",
      email: "person@icloud.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const security = store.upsertProviderEmail(testProviderEmail({
      id: "security-alert",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-security-alert",
      senderName: "Apple",
      senderEmail: "apple@example.com",
      subject: "Security alert",
      snippet: "A new device signed in.",
      isRead: false
    }));
    const promo = store.upsertProviderEmail(testProviderEmail({
      id: "promo-sale",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-promo-sale",
      senderName: "Shop",
      senderEmail: "newsletter@shop.example",
      subject: "Sale this weekend",
      snippet: "Save 20%. Unsubscribe here.",
      isRead: false
    }));
    store.upsertProviderEmail(testProviderEmail({
      id: "read-inbox",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-read-inbox",
      isRead: true
    }));

    const first = await triage.analyze();
    const second = await triage.analyze();

    assert.equal(classifierCalls, 1);
    assert.equal(first.unreadCount, 2);
    assert.equal(first.analyzedCount, 2);
    assert.equal(first.isCached, false);
    assert.equal(second.isCached, true);
    assert.equal(first.sections.find(section => section.id === "read").emails[0].id, security.id);
    assert.equal(first.sections.find(section => section.id === "archive").emails[0].id, promo.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fallback inbox triage keeps uncertain mail in the reading pile", () => {
  const plan = fallbackInboxTriagePlan([
    testTriageEmail({
      id: "newsletter",
      senderEmail: "newsletter@example.com",
      subject: "Weekly digest",
      snippet: "Read online. Unsubscribe."
    }),
    testTriageEmail({
      id: "billing",
      senderEmail: "billing@example.com",
      subject: "Your invoice is ready",
      snippet: "Payment receipt attached."
    }),
    testTriageEmail({
      id: "human",
      senderEmail: "friend@example.com",
      subject: "Quick question",
      snippet: "Could you check this?"
    })
  ]);

  assert.deepEqual(plan.archive.map(item => item.id), ["newsletter"]);
  assert.deepEqual(plan.read.map(item => item.id), ["billing", "human"]);
  assert.equal(plan.read.find(item => item.id === "human").reason, "Unclear messages stay in the reading pile.");
});

function testProviderEmail(overrides = {}) {
  return {
    id: overrides.id,
    accountId: overrides.accountId,
    mailboxId: overrides.mailboxId,
    providerUID: overrides.providerUID,
    threadId: overrides.providerUID,
    senderName: overrides.senderName ?? "Sender",
    senderEmail: overrides.senderEmail ?? "sender@example.com",
    senderAvatarURL: null,
    recipients: ["person@example.com"],
    cc: [],
    bcc: [],
    subject: overrides.subject ?? "Hello",
    snippet: overrides.snippet ?? "A short message.",
    bodyText: overrides.bodyText ?? overrides.snippet ?? "A short message.",
    bodyHTML: null,
    rfcMessageID: null,
    inReplyTo: null,
    references: [],
    sentAt: "2026-05-23T10:00:00.000Z",
    receivedAt: overrides.receivedAt ?? "2026-05-23T10:00:00.000Z",
    isRead: overrides.isRead ?? false,
    isStarred: false,
    importance: "normal",
    hasAttachments: false,
    trackingId: null,
    openedAt: null,
    createdAt: "2026-05-23T10:00:00.000Z"
  };
}

function testTriageEmail(overrides = {}) {
  return {
    id: overrides.id,
    accountId: "account",
    accountEmail: "person@example.com",
    senderName: overrides.senderName ?? "Sender",
    senderEmail: overrides.senderEmail,
    senderAvatarURL: null,
    subject: overrides.subject,
    snippet: overrides.snippet,
    bodyText: overrides.bodyText ?? overrides.snippet,
    receivedAt: "2026-05-23T10:00:00.000Z"
  };
}
