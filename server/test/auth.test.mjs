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
      baseURL: "http://127.0.0.1:7332"
    });
    server = createServer({ store, providers }).server;
    await listen(server, 0);
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const availability = await requestJSON(`${baseURL}/api/auth/settings`);
    assert.equal(availability.settings.gmailConfigured, true);
    assert.equal(availability.settings.icloudConfigured, true);
    assert.equal(availability.settings.imapConfigured, true);
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
      baseURL: "http://127.0.0.1:7332"
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

test("Gmail OAuth desktop client uses public-client authentication without a secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });
  try {
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {
        googleOAuthClientId: "test-client-id.apps.googleusercontent.com",
        googleOAuthClientSecret: ""
      },
      baseURL: "http://127.0.0.1:7332"
    });
    const client = providers.gmailOAuthClient("http://127.0.0.1:7332/api/auth/gmail/callback");
    assert.equal(client.clientAuthentication, "None");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gmail can be advertised through a configured relay without local Google secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-relay-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });
  try {
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {
        googleOAuthClientId: "",
        googleOAuthClientSecret: "",
        relay: {
          baseURL: "https://relay.example.test",
          token: "relay-token",
          source: "CARTA_RELAY_BASE_URL"
        }
      },
      baseURL: "http://127.0.0.1:7332"
    });
    const settings = providers.getAuthSettings();
    assert.equal(settings.gmailConfigured, true);
    assert.equal(settings.gmailOAuthMode, "relay");
    assert.equal(settings.gmailRelayConfigured, true);
    assert.equal(settings.gmailRelayTokenConfigured, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gmail relay auth starts with the local callback and relay exchange by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-relay-start-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        authorizationURL: "https://accounts.google.com/o/oauth2/v2/auth?state=local-state",
        redirectURI: "http://127.0.0.1:7332/api/auth/gmail/callback",
        relay: true,
        deliveryMode: "local-code"
      });
    };
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {
        googleOAuthClientId: "",
        googleOAuthClientSecret: "",
        relay: {
          baseURL: "https://relay.example.test",
          token: "relay-token",
          source: "stored",
          tokenSource: "keychain"
        }
      },
      baseURL: "http://127.0.0.1:7332"
    });

    const auth = await providers.startGmailAuth({ displayName: "Relay User" }, { baseURL: "http://127.0.0.1:7332" });
    assert.equal(auth.relay, true);
    assert.equal(auth.redirectURI, "http://127.0.0.1:7332/api/auth/gmail/callback");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://relay.example.test/api/oauth/google/start");
    assert.equal(calls[0].init.headers.authorization, "Bearer relay-token");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.deliveryMode, "local-code");
    assert.equal(body.callbackURL, "http://127.0.0.1:7332/api/auth/gmail/callback");
    assert.equal(body.state, auth.state);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gmail relay code callback uses the shared local Gmail callback path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-relay-code-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/api/oauth/google/start")) {
        return Response.json({
          authorizationURL: `https://accounts.google.com/o/oauth2/v2/auth?state=${body.state}&redirect_uri=${encodeURIComponent(body.callbackURL)}`,
          redirectURI: body.callbackURL,
          relay: true,
          deliveryMode: "local-code"
        });
      }
      if (String(url).endsWith("/api/oauth/google/exchange")) {
        return Response.json({
          access_token: "relay-access-token",
          refresh_token: "relay-refresh-token",
          scope: "https://www.googleapis.com/auth/gmail.modify"
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {
        googleOAuthClientId: "",
        googleOAuthClientSecret: "",
        relay: {
          baseURL: "https://relay.example.test",
          token: "",
          source: "bundled",
          tokenSource: "missing"
        }
      },
      baseURL: "http://127.0.0.1:7332"
    });
    providers.connectGmailTokens = async (tokens, session) => ({
      account: {
        id: "relay-account",
        email: "relay@example.test"
      },
      sync: {
        provider: "gmail",
        imported: 0,
        status: "queued"
      },
      syncLimit: session.syncHistory ? 500 : 50,
      tokens
    });

    const auth = await providers.startGmailAuth({}, { baseURL: "http://127.0.0.1:7332" });
    const result = await providers.completeGmailAuth({
      state: auth.state,
      code: "relay-auth-code"
    });

    assert.equal(auth.redirectURI, "http://127.0.0.1:7332/api/auth/gmail/callback");
    assert.equal(result.account.email, "relay@example.test");
    assert.equal(result.tokens.refresh_token, "relay-refresh-token");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://relay.example.test/api/oauth/google/exchange");
    const exchangeBody = JSON.parse(calls[1].init.body);
    assert.equal(exchangeBody.code, "relay-auth-code");
    assert.equal(exchangeBody.redirectURI, "http://127.0.0.1:7332/api/auth/gmail/callback");
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gmail relay can be configured with only a relay URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-auth-relay-token-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });
  try {
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {
        googleOAuthClientId: "",
        googleOAuthClientSecret: "",
        relay: {
          baseURL: "https://relay.example.test",
          token: "",
          source: "CARTA_RELAY_BASE_URL",
          tokenSource: "missing"
        }
      },
      baseURL: "http://127.0.0.1:7332"
    });
    const settings = providers.getAuthSettings();
    assert.equal(settings.gmailConfigured, true);
    assert.equal(settings.gmailRelayBaseURLConfigured, true);
    assert.equal(settings.gmailRelayTokenConfigured, false);
    assert.equal(settings.gmailOAuthMode, "relay");
  } finally {
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
