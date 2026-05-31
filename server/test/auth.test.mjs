import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "../src/http.js";
import { ProviderService } from "../src/providerAdapters.js";
import { MemorySecretStore } from "../src/secretStore.js";
import { MailStore } from "../src/store.js";

test("provider availability is server-owned and Gmail auth starts when configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {
        googleOAuthClientId: "test-client-id.apps.googleusercontent.com",
        googleOAuthClientSecret: "test-secret"
      },
      baseURL: "http://127.0.0.1:7331"
    });
    server = createServer({ store, providers }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const availability = await requestJSON(`${baseURL}/api/auth/settings`);
    assert.equal(availability.settings.gmailConfigured, true);
    assert.equal(availability.settings.icloudConfigured, true);
    assert.equal(availability.settings.appleMailOAuthAvailable, false);
    assert.equal(Object.hasOwn(availability.settings, "gmailClientId"), false);

    const auth = await requestJSON(`${baseURL}/api/auth/gmail/start`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Test Gmail", syncHistory: false }),
      headers: { "Content-Type": "application/json" }
    });
    const authorizationURL = new URL(auth.authorizationURL);
    assert.equal(authorizationURL.hostname, "accounts.google.com");
    assert.equal(authorizationURL.searchParams.get("client_id"), "test-client-id.apps.googleusercontent.com");
    assert.equal(authorizationURL.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorizationURL.searchParams.get("code_challenge"));
    assert.equal(auth.redirectURI, `${baseURL}/api/auth/gmail/callback`);
    assert.equal(authorizationURL.searchParams.get("redirect_uri"), auth.redirectURI);
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured public base URL wins for Gmail redirect URI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {
        googleOAuthClientId: "test-client-id.apps.googleusercontent.com",
        googleOAuthClientSecret: "test-secret"
      },
      baseURL: "http://127.0.0.1:7331"
    });
    const publicBaseURL = "https://space.tailb90a7f.ts.net:8443";
    server = createServer({ store, providers, publicBaseURL }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const availability = await requestJSON(`${baseURL}/api/auth/settings`);
    assert.equal(availability.settings.gmailRedirectURI, `${publicBaseURL}/api/auth/gmail/callback`);

    const auth = await requestJSON(`${baseURL}/api/auth/gmail/start`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Test Gmail", syncHistory: false }),
      headers: { "Content-Type": "application/json" }
    });
    const authorizationURL = new URL(auth.authorizationURL);
    assert.equal(auth.redirectURI, `${publicBaseURL}/api/auth/gmail/callback`);
    assert.equal(authorizationURL.searchParams.get("redirect_uri"), auth.redirectURI);
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates account settings through the API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    server = createServer({ store }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const response = await requestJSON(`${baseURL}/api/accounts/${account.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "Person Updated",
        avatarURL: "https://example.com/avatar.jpg",
        syncHistory: false
      }),
      headers: { "Content-Type": "application/json" }
    });

    assert.equal(response.account.displayName, "Person Updated");
    assert.equal(response.account.avatarURL, "https://example.com/avatar.jpg");
    assert.equal(response.account.syncHistory, false);
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("marks provider email read locally without waiting for the remote provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const email = {
      id: "email-read-api-test",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "gmail-provider-id",
      threadId: "thread-read-api-test",
      senderName: "Sender",
      senderEmail: "sender@example.com",
      senderAvatarURL: null,
      recipients: [account.email],
      cc: [],
      bcc: [],
      subject: "Unread provider-backed message",
      snippet: "Unread provider-backed message",
      bodyText: "Hello",
      bodyHTML: null,
      rfcMessageID: null,
      inReplyTo: null,
      references: [],
      sentAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      isRead: false,
      isStarred: false,
      importance: "normal",
      hasAttachments: false,
      attachments: [],
      trackingId: null,
      openedAt: null,
      createdAt: new Date().toISOString()
    };
    store.insertEmail(email);
    store.refreshMailboxUnread(inbox.id);

    let resolveProviderUpdate;
    const providerUpdates = [];
    const providerStarted = new Promise(resolve => {
      resolveProviderUpdate = resolve;
    });
    const providers = {
      async updateEmailReadStatus(providerEmail, isRead) {
        providerUpdates.push({ id: providerEmail.id, providerUID: providerEmail.providerUID, isRead });
        resolveProviderUpdate();
        return { status: "updated", provider: "gmail" };
      }
    };
    server = createServer({ store, providers }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const response = await requestJSON(`${baseURL}/api/emails/${email.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
      headers: { "Content-Type": "application/json" }
    });

    assert.equal(response.email.isRead, true);
    assert.equal(store.getEmail(email.id).isRead, true);

    await providerStarted;
    assert.deepEqual(providerUpdates, [{ id: email.id, providerUID: email.providerUID, isRead: true }]);
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archives provider email locally without waiting for the remote provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const email = testEmail({
      id: "email-archive-api-test",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "gmail-archive-provider-id"
    });
    store.insertEmail(email);
    store.refreshMailboxUnread(inbox.id);

    let resolveProviderArchive;
    let providerEmail;
    const providerStarted = new Promise(resolve => {
      const providers = {
        async archiveEmail(emailForProvider) {
          providerEmail = emailForProvider;
          resolve();
          await new Promise(providerResolve => {
            resolveProviderArchive = providerResolve;
          });
          return { status: "updated", provider: "gmail" };
        }
      };
      server = createServer({ store, providers }).server;
    });
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const response = await requestJSON(`${baseURL}/api/emails/${email.id}/archive`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" }
    });

    assert.equal(response.email.mailboxRole, "archive");
    assert.equal(store.getEmail(email.id).mailboxRole, "archive");

    await providerStarted;
    assert.equal(providerEmail.id, email.id);
    assert.equal(providerEmail.mailboxRole, "inbox");
    resolveProviderArchive();
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queues outbound provider send after returning the local sent message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });

    let resolveProviderSend;
    let providerEmail;
    const providerStarted = new Promise(resolve => {
      const providers = {
        async sendMessage(emailForProvider) {
          providerEmail = emailForProvider;
          resolve();
          await new Promise(providerResolve => {
            resolveProviderSend = providerResolve;
          });
          return { status: "sent", providerUID: "provider-sent-message-id" };
        }
      };
      server = createServer({ store, providers }).server;
    });
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const response = await withTimeout(requestJSON(`${baseURL}/api/messages/send`, {
      method: "POST",
      body: JSON.stringify({
        accountId: account.id,
        to: "friend@example.com",
        cc: "",
        bcc: "",
        subject: "Queued send",
        bodyText: "Hello from a local-first send.",
        bodyHTML: null,
        trackOpens: false
      }),
      headers: { "Content-Type": "application/json" }
    }), 500);

    assert.equal(response.email.mailboxRole, "sent");
    assert.equal(response.email.outboundStatus, "queued");
    assert.equal(store.getEmail(response.email.id).providerUID, null);

    await providerStarted;
    assert.equal(providerEmail.id, response.email.id);
    resolveProviderSend();
    await sleep(20);
    assert.equal(store.getEmail(response.email.id).providerUID, "provider-sent-message-id");
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omits oversized HTML from email detail responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  let server;
  try {
    const account = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    const email = testEmail({
      id: "email-large-html-test",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "gmail-large-html-provider-id",
      bodyText: "Readable fallback body.",
      bodyHTML: `<article>${"Large HTML ".repeat(120_000)}</article>`
    });
    store.insertEmail(email);

    server = createServer({ store }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const response = await requestJSON(`${baseURL}/api/emails/${email.id}`);

    assert.equal(response.email.bodyHTML, null);
    assert.equal(response.email.bodyText, "Readable fallback body.");
    assert.equal(response.email.bodyHTMLWasOmitted, true);

    const patchResponse = await requestJSON(`${baseURL}/api/emails/${email.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
      headers: { "Content-Type": "application/json" }
    });
    assert.equal(patchResponse.email.bodyHTML, null);
    assert.equal(patchResponse.email.bodyHTMLWasOmitted, true);

    const archiveResponse = await requestJSON(`${baseURL}/api/emails/${email.id}/archive`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" }
    });
    assert.equal(archiveResponse.email.bodyHTML, null);
    assert.equal(archiveResponse.email.bodyHTMLWasOmitted, true);
  } finally {
    await close(server);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function requestJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

function listen(server, port) {
  return new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function withTimeout(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
    })
  ]);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function testEmail(overrides = {}) {
  return {
    id: overrides.id,
    accountId: overrides.accountId,
    mailboxId: overrides.mailboxId,
    providerUID: overrides.providerUID,
    threadId: overrides.threadId ?? overrides.providerUID,
    senderName: "Sender",
    senderEmail: "sender@example.com",
    senderAvatarURL: null,
    recipients: ["person@example.com"],
    cc: [],
    bcc: [],
    subject: overrides.subject ?? "Provider-backed message",
    snippet: overrides.snippet ?? "Provider-backed message",
    bodyText: overrides.bodyText ?? "Hello",
    bodyHTML: overrides.bodyHTML ?? null,
    rfcMessageID: null,
    inReplyTo: null,
    references: [],
    sentAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    isRead: false,
    isStarred: false,
    importance: "normal",
    hasAttachments: false,
    attachments: [],
    trackingId: null,
    openedAt: null,
    createdAt: new Date().toISOString()
  };
}
