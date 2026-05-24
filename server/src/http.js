import { createServer as createHTTPServer } from "node:http";
import { Buffer } from "node:buffer";
import { httpError } from "./store.js";

const trackingPixel = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
const manualSyncLeaseTtlMs = 15 * 60 * 1000;
const defaultRateLimits = {
  enabled: true,
  gmailStart: { limit: 10, windowMs: 15 * 60 * 1000 },
  gmailCallback: { limit: 60, windowMs: 15 * 60 * 1000 },
  icloudConnect: { limit: 5, windowMs: 60 * 60 * 1000 },
  manualSync: { limit: 20, windowMs: 15 * 60 * 1000 },
  sendMessage: { limit: 120, windowMs: 60 * 60 * 1000 },
  attachmentDownload: { limit: 300, windowMs: 15 * 60 * 1000 }
};

export function createServer({
  store,
  providers,
  pushNotifications,
  authenticator,
  host = "127.0.0.1",
  port = 7331,
  publicBaseURL,
  rateLimits
} = {}) {
  const events = new EventHub();
  const baseURL = publicBaseURL ?? `http://${host}:${port}`;
  const normalizedRateLimits = normalizeRateLimits(rateLimits);

  const server = createHTTPServer(async (req, res) => {
    try {
      await route({
        req,
        res,
        store,
        providers,
        pushNotifications,
        authenticator,
        events,
        baseURL,
        rateLimits: normalizedRateLimits
      });
    } catch (error) {
      const status = error.status ?? 500;
      console.error(`${new Date().toISOString()} ${req.method} ${req.url} -> ${status}: ${error.message}`);
      sendJSON(res, status, {
        error: {
          message: status === 500 ? "Internal server error." : error.message,
          status
        }
      }, error.headers);
      if (status === 500) {
        console.error(error);
      }
    }
  });

  return { server, events };
}

async function route({ req, res, store, providers, pushNotifications, authenticator, events, baseURL, rateLimits }) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);

  if (req.method === "OPTIONS") {
    sendCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/api/health") {
    sendJSON(res, 200, {
      status: "ok",
      databasePath: store.databasePath,
      storage: store.storageName ?? "sqlite",
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (req.method === "GET" && path === "/api/ready") {
    const readiness = await collectReadiness({ store, providers, authenticator });
    sendJSON(res, readiness.status === "ok" ? 200 : 503, readiness);
    return;
  }

  if (req.method === "GET" && path === "/api/auth/settings") {
    requireProviders(providers);
    sendJSON(res, 200, { settings: providers.getAuthSettings() });
    return;
  }

  if (req.method === "GET" && path === "/api/auth/gmail/callback") {
    requireProviders(providers);
    await enforceRateLimit({
      store,
      rule: rateLimits.gmailCallback,
      scope: "gmail_callback",
      subject: clientSubject(req)
    });
    const result = await providers.completeGmailAuth(Object.fromEntries(url.searchParams.entries()));
    events.emit("accounts.changed", { accountId: result.account.id }, result.userId);
    syncAccountInBackground({ providers, events, accountId: result.account.id, limit: result.syncLimit, user: result.user });
    sendHTML(res, 200, authSuccessPage(result));
    return;
  }

  const trackingMatch = path.match(/^\/api\/track\/open\/([^/]+)\.gif$/);
  if (trackingMatch && req.method === "GET") {
    const email = await store.recordOpen(trackingMatch[1], {
      userAgent: req.headers["user-agent"] ?? null,
      remoteAddr: req.socket.remoteAddress ?? null
    });
    if (email) {
      events.emit("emails.changed", { emailId: email.id }, email.userId);
    }
    sendCORS(res);
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Content-Length": trackingPixel.length
    });
    res.end(trackingPixel);
    return;
  }

  const user = authenticator
    ? await authenticator.authenticate(req)
    : { id: "local", email: null, displayName: "Local Profile", isLocal: true };
  const requestStore = user.isLocal ? store : store.forUser(user);
  const requestProviders = providers?.forStore ? providers.forStore(requestStore, user) : providers;
  const requestPushNotifications = pushNotifications?.forStore ? pushNotifications.forStore(requestStore) : pushNotifications;

  if (req.method === "GET" && path === "/api/events") {
    events.subscribe(req, res, user.id);
    return;
  }

  if (req.method === "GET" && path === "/api/accounts") {
    sendJSON(res, 200, { accounts: await requestStore.listAccounts() });
    return;
  }

  if (req.method === "GET" && path === "/api/profile") {
    sendJSON(res, 200, { profile: await requestStore.getProfile() });
    return;
  }

  if (req.method === "POST" && path === "/api/push/tokens") {
    const token = await requestStore.registerPushToken(await readJSON(req));
    sendJSON(res, 201, {
      token,
      pushConfigured: Boolean(requestPushNotifications?.isConfigured)
    });
    return;
  }

  if (req.method === "POST" && path === "/api/auth/gmail/start") {
    requireProviders(requestProviders);
    await enforceRateLimit({
      store: requestStore,
      rule: rateLimits.gmailStart,
      scope: "gmail_start",
      subject: userSubject(user)
    });
    console.log(`${new Date().toISOString()} POST /api/auth/gmail/start`);
    sendJSON(res, 200, await requestProviders.startGmailAuth(await readJSON(req), user));
    return;
  }

  if (req.method === "POST" && path === "/api/auth/icloud/connect") {
    requireProviders(requestProviders);
    await enforceRateLimit({
      store: requestStore,
      rule: rateLimits.icloudConnect,
      scope: "icloud_connect",
      subject: userSubject(user)
    });
    const body = await readJSON(req);
    console.log(`${new Date().toISOString()} POST /api/auth/icloud/connect email=${redactEmail(body.email)}`);
    const result = await requestProviders.connectICloud(body);
    console.log(`${new Date().toISOString()} iCloud connected email=${redactEmail(result.account.email)} imported=${result.sync.imported}`);
    events.emit("accounts.changed", { accountId: result.account.id }, user.id);
    events.emit("emails.changed", { accountId: result.account.id }, user.id);
    sendJSON(res, 200, { ...result, sync: publicSyncResult(result.sync) });
    return;
  }

  if (req.method === "POST" && path === "/api/accounts") {
    const account = await requestStore.createAccount(await readJSON(req));
    events.emit("accounts.changed", { accountId: account.id }, user.id);
    sendJSON(res, 201, { account });
    return;
  }

  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && req.method === "PATCH") {
    const account = await requestStore.updateAccountSettings(accountMatch[1], await readJSON(req));
    if (!account) throw httpError(404, "Account not found.");
    events.emit("accounts.changed", { accountId: account.id }, user.id);
    events.emit("emails.changed", { accountId: account.id }, user.id);
    sendJSON(res, 200, { account });
    return;
  }

  const accountSyncMatch = path.match(/^\/api\/accounts\/([^/]+)\/sync$/);
  if (accountSyncMatch && req.method === "POST") {
    requireProviders(requestProviders);
    const accountId = accountSyncMatch[1];
    const account = await requestStore.getAccount(accountId);
    if (!account) throw httpError(404, "Account not found.");
    await enforceRateLimit({
      store: requestStore,
      rule: rateLimits.manualSync,
      scope: "manual_sync",
      subject: userSubject(user)
    });
    const leaseOwner = `manual:${user.id}`;
    let claimed = false;
    const body = await readJSON(req);
    try {
      if (typeof requestStore.claimSyncLease === "function") {
        claimed = await requestStore.claimSyncLease(accountId, {
          owner: leaseOwner,
          ttlMs: manualSyncLeaseTtlMs
        });
        if (!claimed) throw httpError(409, "Account sync is already running.");
      }
      const sync = await requestProviders.syncAccount(account.id, {
        limit: body.limit
      });
      events.emit("emails.changed", { accountId: account.id }, user.id);
      await sendPushNotifications(requestPushNotifications, sync.newEmails);
      sendJSON(res, 200, { sync: publicSyncResult(sync) });
    } finally {
      if (claimed && typeof requestStore.releaseSyncLease === "function") {
        try {
          await requestStore.releaseSyncLease(accountId, { owner: leaseOwner });
        } catch (error) {
          console.warn(`${new Date().toISOString()} manual sync lease release failed account=${accountId}: ${error.message}`);
        }
      }
    }
    return;
  }

  if (req.method === "GET" && path === "/api/mailboxes") {
    sendJSON(res, 200, { mailboxes: await requestStore.listMailboxes(url.searchParams.get("accountId")) });
    return;
  }

  if (req.method === "GET" && path === "/api/labels") {
    sendJSON(res, 200, { labels: await requestStore.listLabels(url.searchParams.get("accountId")) });
    return;
  }

  if (req.method === "POST" && path === "/api/labels") {
    const label = await requestStore.createLabel(await readJSON(req));
    events.emit("labels.changed", { labelId: label.id }, user.id);
    sendJSON(res, 201, { label });
    return;
  }

  if (req.method === "GET" && path === "/api/emails") {
    const emails = await requestStore.listEmails(Object.fromEntries(url.searchParams.entries()));
    sendJSON(res, 200, { emails });
    return;
  }

  const emailMatch = path.match(/^\/api\/emails\/([^/]+)$/);
  if (emailMatch && req.method === "GET") {
    let email = await requestStore.getEmail(emailMatch[1]);
    if (!email) throw httpError(404, "Email not found.");
    await ensureStoredAttachments({ store: requestStore, providers: requestProviders, email });
    email = await requestStore.getEmail(email.id);
    sendJSON(res, 200, { email });
    return;
  }

  const threadMatch = path.match(/^\/api\/emails\/([^/]+)\/thread$/);
  if (threadMatch && req.method === "GET") {
    let emails = await requestStore.listThreadEmails(threadMatch[1]);
    if (!emails) throw httpError(404, "Email not found.");
    for (const email of emails) {
      await ensureStoredAttachments({ store: requestStore, providers: requestProviders, email });
    }
    emails = await requestStore.listThreadEmails(threadMatch[1]);
    sendJSON(res, 200, { emails });
    return;
  }

  const attachmentDownloadMatch = path.match(/^\/api\/emails\/([^/]+)\/attachments\/([^/]+)\/download$/);
  if (attachmentDownloadMatch && req.method === "GET") {
    const email = await requestStore.getEmail(attachmentDownloadMatch[1]);
    if (!email) throw httpError(404, "Email not found.");
    await enforceRateLimit({
      store: requestStore,
      rule: rateLimits.attachmentDownload,
      scope: "attachment_download",
      subject: userSubject(user)
    });
    let attachment = await requestStore.getAttachment(email.id, attachmentDownloadMatch[2]);
    if (!attachment?.data && requestProviders) {
      await requestProviders.ensureEmailAttachments(email);
      attachment = await requestStore.getAttachment(email.id, attachmentDownloadMatch[2]);
    }
    if (!attachment?.data) throw httpError(404, "Attachment not found.");
    sendAttachment(res, attachment);
    return;
  }

  if (emailMatch && req.method === "PATCH") {
    const email = await requestStore.updateEmail(emailMatch[1], await readJSON(req));
    if (!email) throw httpError(404, "Email not found.");
    events.emit("emails.changed", { emailId: email.id }, user.id);
    sendJSON(res, 200, { email });
    return;
  }

  const spamMatch = path.match(/^\/api\/emails\/([^/]+)\/spam$/);
  if (spamMatch && req.method === "POST") {
    const current = await requestStore.getEmail(spamMatch[1]);
    if (!current) throw httpError(404, "Email not found.");
    if (requestProviders) {
      await requestProviders.markEmailSpam(current);
    }
    const email = await requestStore.markEmailSpam(spamMatch[1]);
    events.emit("emails.changed", { emailId: email.id }, user.id);
    sendJSON(res, 200, { email });
    return;
  }

  const archiveMatch = path.match(/^\/api\/emails\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    const current = await requestStore.getEmail(archiveMatch[1]);
    if (!current) throw httpError(404, "Email not found.");
    if (requestProviders) {
      await requestProviders.archiveEmail(current);
    }
    const email = await requestStore.archiveEmail(archiveMatch[1]);
    events.emit("emails.changed", { emailId: email.id }, user.id);
    sendJSON(res, 200, { email });
    return;
  }

  const trashMatch = path.match(/^\/api\/emails\/([^/]+)\/trash$/);
  if (trashMatch && req.method === "POST") {
    const current = await requestStore.getEmail(trashMatch[1]);
    if (!current) throw httpError(404, "Email not found.");
    if (requestProviders) {
      await requestProviders.trashEmail(current);
    }
    const email = await requestStore.trashEmail(trashMatch[1]);
    events.emit("emails.changed", { emailId: email.id }, user.id);
    sendJSON(res, 200, { email });
    return;
  }

  const blockMatch = path.match(/^\/api\/emails\/([^/]+)\/block$/);
  if (blockMatch && req.method === "POST") {
    const result = await requestStore.blockSenderForEmail(blockMatch[1], (await readJSON(req)).scope);
    if (!result) throw httpError(404, "Email not found.");
    events.emit("emails.changed", { emailId: result.email.id, affectedCount: result.affectedCount }, user.id);
    sendJSON(res, 200, result);
    return;
  }

  const labelMatch = path.match(/^\/api\/emails\/([^/]+)\/labels$/);
  if (labelMatch && req.method === "POST") {
    const body = await readJSON(req);
    const email = await requestStore.setEmailLabel(labelMatch[1], body.labelId, body.action);
    events.emit("emails.changed", { emailId: email.id }, user.id);
    sendJSON(res, 200, { email });
    return;
  }

  if (req.method === "POST" && path === "/api/messages/send") {
    await enforceRateLimit({
      store: requestStore,
      rule: rateLimits.sendMessage,
      scope: "send_message",
      subject: userSubject(user)
    });
    const body = await readJSON(req);
    const email = await requestStore.sendMessage(body);
    if (requestProviders) {
      try {
        const result = await requestProviders.sendMessage(email, body);
        if (result.status === "sent") {
          await requestStore.markOutboundSent(email.outboundId, result.providerUID);
          email.outboundStatus = "sent";
        }
      } catch (error) {
        const message = error?.message ?? String(error);
        await requestStore.markOutboundFailed(email.outboundId, error);
        email.outboundStatus = "failed";
        email.outboundError = message;
        events.emit("emails.changed", { emailId: email.id }, user.id);
        throw httpError(502, `Sending failed: ${message}`);
      }
    }
    events.emit("emails.changed", { emailId: email.id }, user.id);
    sendJSON(res, 202, {
      email,
      trackingPixelURL: email.trackingId ? `${baseURL}/api/track/open/${email.trackingId}.gif` : null
    });
    return;
  }

  throw httpError(404, "Route not found.");
}

async function enforceRateLimit({ store, rule, scope, subject }) {
  if (!rule?.enabled || typeof store?.consumeRateLimit !== "function") return null;
  const result = await store.consumeRateLimit({
    scope,
    subject,
    limit: rule.limit,
    windowMs: rule.windowMs
  });
  if (result.allowed) return result;
  const error = httpError(429, "Too many requests. Try again later.");
  error.headers = rateLimitHeaders(result);
  throw error;
}

function rateLimitHeaders(result) {
  const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1000));
  return {
    "Retry-After": String(retryAfterSeconds),
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": result.resetAt
  };
}

function normalizeRateLimits(rateLimits = {}) {
  const enabled = rateLimits.enabled !== false;
  return Object.fromEntries(Object.entries(defaultRateLimits).map(([key, defaultValue]) => {
    if (key === "enabled") return [key, enabled];
    const value = rateLimits[key] ?? {};
    return [key, {
      enabled,
      limit: positiveInt(value.limit, defaultValue.limit),
      windowMs: positiveInt(value.windowMs, defaultValue.windowMs)
    }];
  }));
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value ?? fallback, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function userSubject(user) {
  return `user:${user.id}`;
}

function clientSubject(req) {
  return `ip:${clientAddress(req)}`;
}

function clientAddress(req) {
  const headers = [
    req.headers["fly-client-ip"],
    req.headers["cf-connecting-ip"],
    req.headers["x-forwarded-for"]
  ];
  for (const header of headers) {
    const value = Array.isArray(header) ? header[0] : header;
    const first = value?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function sendJSON(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  sendCORS(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...headers
  });
  res.end(body);
}

function sendHTML(res, status, html) {
  const body = Buffer.from(html);
  sendCORS(res);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length
  });
  res.end(body);
}

function sendAttachment(res, attachment) {
  const body = Buffer.from(attachment.data);
  const filename = safeFilename(attachment.filename || "Attachment");
  sendCORS(res);
  res.writeHead(200, {
    "Content-Type": attachment.mimeType || "application/octet-stream",
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="${filename.replaceAll('"', '\\"')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, max-age=300"
  });
  res.end(body);
}

async function ensureStoredAttachments({ store, providers, email }) {
  if (!providers || !email?.hasAttachments || email.attachments?.length > 0) return;
  try {
    await providers.ensureEmailAttachments(email);
  } catch (error) {
    console.warn(`${new Date().toISOString()} attachment fetch failed email=${email.id}: ${error.message}`);
  }
}

function safeFilename(value) {
  return String(value)
    .replace(/[\r\n/\\:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180) || "Attachment";
}

function sendCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function requireProviders(providers) {
  if (!providers) throw httpError(500, "Provider services are not configured.");
}

async function collectReadiness({ store, providers, authenticator }) {
  const checks = {
    database: await readinessCheck(() => checkStoreDatabase(store)),
    attachmentStorage: await readinessCheck(() => checkStoreAttachmentStorage(store)),
    auth: await readinessCheck(() => checkAuthConfiguration({ providers, authenticator })),
    providers: await readinessCheck(() => checkProviderConfiguration(providers))
  };
  const status = Object.values(checks).every(check => check.status === "ok") ? "ok" : "error";
  return {
    status,
    storage: store.storageName ?? "sqlite",
    timestamp: new Date().toISOString(),
    checks
  };
}

async function readinessCheck(fn) {
  const started = Date.now();
  try {
    const details = await fn();
    return {
      status: "ok",
      latencyMs: Date.now() - started,
      ...details
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Date.now() - started,
      error: error?.message ?? String(error)
    };
  }
}

async function checkStoreDatabase(store) {
  if (typeof store?.checkDatabaseReadiness === "function") {
    return await store.checkDatabaseReadiness();
  }
  if (typeof store?.checkReadiness === "function") {
    return (await store.checkReadiness()).database ?? {};
  }
  throw new Error("Store does not expose a database readiness check.");
}

async function checkStoreAttachmentStorage(store) {
  if (typeof store?.checkAttachmentStorageReadiness === "function") {
    return await store.checkAttachmentStorageReadiness();
  }
  if (typeof store?.checkReadiness === "function") {
    return (await store.checkReadiness()).attachmentStorage ?? {};
  }
  return { mode: "unknown", bucket: null };
}

function checkAuthConfiguration({ providers, authenticator }) {
  const settings = providers?.getAuthSettings?.() ?? {};
  const requireUserAuth = authenticator?.requireAuth === true || settings.requireUserAuth === true;
  if (requireUserAuth && (!settings.supabaseURL || !settings.supabasePublishableKey)) {
    throw new Error("Supabase Auth is required but public auth config is missing.");
  }
  return {
    mode: requireUserAuth ? "supabase" : "local",
    requireUserAuth
  };
}

function checkProviderConfiguration(providers) {
  requireProviders(providers);
  const settings = providers.getAuthSettings();
  if (!settings.gmailConfigured) {
    throw new Error("Gmail OAuth is not configured.");
  }
  return {
    gmailConfigured: settings.gmailConfigured === true,
    icloudConfigured: settings.icloudConfigured === true
  };
}

function publicSyncResult(sync = {}) {
  const { newEmails, ...publicSync } = sync;
  return publicSync;
}

async function sendPushNotifications(pushNotifications, newEmails = []) {
  if (!pushNotifications || !Array.isArray(newEmails) || newEmails.length === 0) return;
  try {
    const result = await pushNotifications.sendNewEmailNotifications(newEmails);
    if (result.sent > 0) {
      console.log(`${new Date().toISOString()} push notifications sent=${result.sent}`);
    }
  } catch (error) {
    console.warn(`${new Date().toISOString()} push notifications failed: ${error.message}`);
  }
}

function authSuccessPage(result) {
  const account = result.account;
  const imported = result.sync?.imported ?? 0;
  const syncText = result.sync?.status === "queued"
    ? "Message sync is running in the background."
    : `Imported ${imported} messages into the local search index.`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Email connected</title>
    <style>
      body { font: 15px -apple-system, BlinkMacSystemFont, sans-serif; margin: 40px; color: CanvasText; background: Canvas; }
      main { max-width: 520px; }
      h1 { font-size: 24px; letter-spacing: 0; }
      p { color: color-mix(in srgb, CanvasText 72%, transparent); line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Gmail connected</h1>
      <p>${escapeHTML(account.email)} is connected. ${escapeHTML(syncText)}</p>
      <p>You can close this window and return to Email.</p>
    </main>
  </body>
</html>`;
}

function syncAccountInBackground({ providers, events, accountId, limit, user }) {
  setTimeout(async () => {
    try {
      console.log(`${new Date().toISOString()} background sync started account=${accountId}`);
      const scopedProviders = !user?.isLocal && providers.forUser ? providers.forUser(user) : providers;
      const sync = await scopedProviders.syncGmailAccount(accountId, { limit });
      console.log(`${new Date().toISOString()} background sync completed account=${accountId} imported=${sync.imported}`);
      events.emit("emails.changed", { accountId }, user?.id);
      events.emit("accounts.changed", { accountId }, user?.id);
    } catch (error) {
      console.error(`${new Date().toISOString()} background sync failed account=${accountId}: ${error.message}`);
    }
  }, 0);
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function redactEmail(value) {
  if (typeof value !== "string" || !value.includes("@")) return "unknown";
  const [local, domain] = value.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

async function readJSON(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

class EventHub {
  constructor() {
    this.clients = new Set();
  }

  subscribe(req, res, userId) {
    sendCORS(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("event: ready\ndata: {}\n\n");
    const client = { res, userId };
    this.clients.add(client);
    req.on("close", () => this.clients.delete(client));
  }

  emit(event, data, userId = null) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (userId && client.userId !== userId) continue;
      client.res.write(payload);
    }
  }
}
