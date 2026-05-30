import { createServer as createHTTPServer } from "node:http";
import { Buffer } from "node:buffer";
import { summarizePushNotificationResult } from "./pushNotifications.js";
import { httpError } from "./store.js";

const trackingPixel = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

export function createServer({ store, providers, pushNotifications, inboxTriage, host = "127.0.0.1", port = 7331, publicBaseURL } = {}) {
  const events = new EventHub();
  const configuredBaseURL = normalizedBaseURL(publicBaseURL);
  const fallbackBaseURL = normalizedBaseURL(`http://${host}:${port}`);

  const server = createHTTPServer(async (req, res) => {
    try {
      await route({ req, res, store, providers, pushNotifications, inboxTriage, events, configuredBaseURL, fallbackBaseURL });
    } catch (error) {
      const status = error.status ?? 500;
      console.error(`${new Date().toISOString()} ${req.method} ${req.url} -> ${status}: ${error.message}`);
      sendJSON(res, status, {
        error: {
          message: status === 500 ? "Internal server error." : error.message,
          status
        }
      });
      if (status === 500) {
        console.error(error);
      }
    }
  });

  return { server, events };
}

async function route({ req, res, store, providers, pushNotifications, inboxTriage, events, configuredBaseURL, fallbackBaseURL }) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);
  const baseURL = requestBaseURL(req, configuredBaseURL, fallbackBaseURL);

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
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (req.method === "GET" && path === "/api/events") {
    events.subscribe(req, res);
    return;
  }

  if (req.method === "GET" && path === "/api/accounts") {
    sendJSON(res, 200, { accounts: store.listAccounts() });
    return;
  }

  if (req.method === "PATCH" && path === "/api/accounts/order") {
    const accounts = store.reorderAccounts((await readJSON(req)).ids);
    events.emit("accounts.changed", { reordered: true });
    sendJSON(res, 200, { accounts });
    return;
  }

  if (req.method === "GET" && path === "/api/profile") {
    sendJSON(res, 200, { profile: store.getProfile() });
    return;
  }

  if (req.method === "GET" && path === "/api/auth/settings") {
    requireProviders(providers);
    sendJSON(res, 200, { settings: providers.getAuthSettings({ baseURL }) });
    return;
  }

  if (req.method === "POST" && path === "/api/push/tokens") {
    const token = store.registerPushToken(await readJSON(req));
    sendJSON(res, 201, {
      token,
      pushConfigured: Boolean(pushNotifications?.isConfigured)
    });
    return;
  }

  if (req.method === "POST" && path === "/api/push/test") {
    if (!pushNotifications?.isConfigured) {
      throw httpError(503, "APNs is not configured.");
    }
    sendJSON(res, 200, {
      push: await pushNotifications.sendTestNotification()
    });
    return;
  }

  if (req.method === "POST" && path === "/api/auth/gmail/start") {
    requireProviders(providers);
    console.log(`${new Date().toISOString()} POST /api/auth/gmail/start`);
    sendJSON(res, 200, await providers.startGmailAuth(await readJSON(req), { baseURL }));
    return;
  }

  if (req.method === "GET" && path === "/api/auth/gmail/callback") {
    requireProviders(providers);
    const result = await providers.completeGmailAuth(Object.fromEntries(url.searchParams.entries()));
    events.emit("accounts.changed", { accountId: result.account.id });
    syncAccountInBackground({ providers, events, accountId: result.account.id, limit: result.syncLimit });
    sendHTML(res, 200, authSuccessPage(result));
    return;
  }

  if (req.method === "POST" && path === "/api/auth/icloud/connect") {
    requireProviders(providers);
    const body = await readJSON(req);
    console.log(`${new Date().toISOString()} POST /api/auth/icloud/connect email=${redactEmail(body.email)}`);
    const result = await providers.connectICloud(body);
    console.log(`${new Date().toISOString()} iCloud connected email=${redactEmail(result.account.email)} imported=${result.sync.imported}`);
    events.emit("accounts.changed", { accountId: result.account.id });
    events.emit("emails.changed", { accountId: result.account.id });
    sendJSON(res, 200, { ...result, sync: publicSyncResult(result.sync) });
    return;
  }

  if (req.method === "POST" && path === "/api/accounts") {
    const account = store.createAccount(await readJSON(req));
    events.emit("accounts.changed", { accountId: account.id });
    sendJSON(res, 201, { account });
    return;
  }

  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && req.method === "PATCH") {
    const account = store.updateAccountSettings(accountMatch[1], await readJSON(req));
    if (!account) throw httpError(404, "Account not found.");
    events.emit("accounts.changed", { accountId: account.id });
    events.emit("emails.changed", { accountId: account.id });
    sendJSON(res, 200, { account });
    return;
  }

  const accountSyncMatch = path.match(/^\/api\/accounts\/([^/]+)\/sync$/);
  if (accountSyncMatch && req.method === "POST") {
    requireProviders(providers);
    const body = await readJSON(req);
    const sync = await providers.syncAccount(accountSyncMatch[1], {
      limit: body.limit,
      quick: body.quick === true || url.searchParams.get("quick") === "1"
    });
    events.emit("emails.changed", { accountId: accountSyncMatch[1] });
    await sendPushNotifications(pushNotifications, sync.newEmails);
    prefetchInboxTriage(inboxTriage);
    sendJSON(res, 200, { sync: publicSyncResult(sync) });
    return;
  }

  const accountBackfillMatch = path.match(/^\/api\/accounts\/([^/]+)\/backfill$/);
  if (accountBackfillMatch && req.method === "POST") {
    requireProviders(providers);
    const body = await readJSON(req);
    const backfill = await providers.backfillAccountHistory(accountBackfillMatch[1], {
      limit: body.limit
    });
    if (backfill.imported > 0) {
      events.emit("emails.changed", { accountId: accountBackfillMatch[1], backfilled: true });
    }
    sendJSON(res, 200, { backfill });
    return;
  }

  if (req.method === "GET" && path === "/api/mailboxes") {
    sendJSON(res, 200, { mailboxes: store.listMailboxes(url.searchParams.get("accountId")) });
    return;
  }

  if (req.method === "GET" && path === "/api/labels") {
    sendJSON(res, 200, { labels: store.listLabels(url.searchParams.get("accountId")) });
    return;
  }

  if (req.method === "POST" && path === "/api/labels") {
    const label = store.createLabel(await readJSON(req));
    events.emit("labels.changed", { labelId: label.id });
    sendJSON(res, 201, { label });
    return;
  }

  const labelRouteMatch = path.match(/^\/api\/labels\/([^/]+)$/);
  if (labelRouteMatch && req.method === "PATCH") {
    const label = store.updateLabel(labelRouteMatch[1], await readJSON(req));
    events.emit("labels.changed", { labelId: label.id });
    sendJSON(res, 200, { label });
    return;
  }

  if (req.method === "GET" && path === "/api/filters") {
    sendJSON(res, 200, { filters: store.listFilters() });
    return;
  }

  if (req.method === "PATCH" && path === "/api/filters/order") {
    const filters = store.reorderFilters((await readJSON(req)).ids);
    events.emit("filters.changed", { reordered: true });
    sendJSON(res, 200, { filters });
    return;
  }

  if (req.method === "POST" && path === "/api/filters") {
    const filter = store.createFilter(await readJSON(req));
    events.emit("filters.changed", { filterId: filter.id });
    sendJSON(res, 201, { filter });
    return;
  }

  const filterRouteMatch = path.match(/^\/api\/filters\/([^/]+)$/);
  if (filterRouteMatch && req.method === "PATCH") {
    const filter = store.updateFilter(filterRouteMatch[1], await readJSON(req));
    events.emit("filters.changed", { filterId: filter.id });
    sendJSON(res, 200, { filter });
    return;
  }

  if (filterRouteMatch && req.method === "DELETE") {
    const filter = store.deleteFilter(filterRouteMatch[1]);
    events.emit("filters.changed", { filterId: filter.id, deleted: true });
    sendJSON(res, 200, { filter });
    return;
  }

  if (req.method === "GET" && path === "/api/emails") {
    const emails = store.listEmails(Object.fromEntries(url.searchParams.entries()));
    sendJSON(res, 200, { emails });
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && path === "/api/inbox/triage") {
    if (!inboxTriage) {
      throw httpError(503, "Inbox triage is not configured.");
    }
    const body = req.method === "POST" ? await readJSON(req) : {};
    const triage = await inboxTriage.analyze({
      accountId: body.accountId ?? url.searchParams.get("accountId"),
      limit: body.limit ?? url.searchParams.get("limit"),
      force: body.force === true || url.searchParams.get("force") === "1"
    });
    sendJSON(res, 200, { triage });
    return;
  }

  if (req.method === "GET" && path === "/api/contacts/suggest") {
    const contacts = store.searchContacts(url.searchParams.get("q"), url.searchParams.get("limit"));
    sendJSON(res, 200, { contacts });
    return;
  }

  const emailMatch = path.match(/^\/api\/emails\/([^/]+)$/);
  if (emailMatch && req.method === "GET") {
    let email = store.getEmail(emailMatch[1]);
    if (!email) throw httpError(404, "Email not found.");
    await ensureStoredAttachments({ store, providers, email });
    email = store.getEmail(email.id);
    sendJSON(res, 200, { email });
    return;
  }

  const threadMatch = path.match(/^\/api\/emails\/([^/]+)\/thread$/);
  if (threadMatch && req.method === "GET") {
    let emails = store.listThreadEmails(threadMatch[1]);
    if (!emails) throw httpError(404, "Email not found.");
    for (const email of emails) {
      await ensureStoredAttachments({ store, providers, email });
    }
    emails = store.listThreadEmails(threadMatch[1]);
    sendJSON(res, 200, { emails });
    return;
  }

  const attachmentDownloadMatch = path.match(/^\/api\/emails\/([^/]+)\/attachments\/([^/]+)\/download$/);
  if (attachmentDownloadMatch && req.method === "GET") {
    const email = store.getEmail(attachmentDownloadMatch[1]);
    if (!email) throw httpError(404, "Email not found.");
    let attachment = store.getAttachment(email.id, attachmentDownloadMatch[2]);
    if (!attachment?.data && providers) {
      await providers.ensureEmailAttachments(email);
      attachment = store.getAttachment(email.id, attachmentDownloadMatch[2]);
    }
    if (!attachment?.data) throw httpError(404, "Attachment not found.");
    sendAttachment(res, attachment);
    return;
  }

  if (emailMatch && req.method === "PATCH") {
    const patch = await readJSON(req);
    const current = store.getEmail(emailMatch[1]);
    if (!current) throw httpError(404, "Email not found.");
    if (typeof patch.isRead === "boolean" && providers) {
      await providers.updateEmailReadStatus(current, patch.isRead);
    }
    const email = store.updateEmail(emailMatch[1], patch);
    if (!email) throw httpError(404, "Email not found.");
    events.emit("emails.changed", { emailId: email.id });
    sendJSON(res, 200, { email });
    return;
  }

  const spamMatch = path.match(/^\/api\/emails\/([^/]+)\/spam$/);
  if (spamMatch && req.method === "POST") {
    const current = store.getEmail(spamMatch[1]);
    if (!current) throw httpError(404, "Email not found.");
    if (providers) {
      await providers.markEmailSpam(current);
    }
    const email = store.markEmailSpam(spamMatch[1]);
    events.emit("emails.changed", { emailId: email.id });
    sendJSON(res, 200, { email });
    return;
  }

  const archiveMatch = path.match(/^\/api\/emails\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    const current = store.getEmail(archiveMatch[1]);
    if (!current) throw httpError(404, "Email not found.");
    if (providers) {
      await providers.archiveEmail(current);
    }
    const email = store.archiveEmail(archiveMatch[1]);
    events.emit("emails.changed", { emailId: email.id });
    sendJSON(res, 200, { email });
    return;
  }

  const trashMatch = path.match(/^\/api\/emails\/([^/]+)\/trash$/);
  if (trashMatch && req.method === "POST") {
    const current = store.getEmail(trashMatch[1]);
    if (!current) throw httpError(404, "Email not found.");
    if (providers) {
      await providers.trashEmail(current);
    }
    const email = store.trashEmail(trashMatch[1]);
    events.emit("emails.changed", { emailId: email.id });
    sendJSON(res, 200, { email });
    return;
  }

  const blockMatch = path.match(/^\/api\/emails\/([^/]+)\/block$/);
  if (blockMatch && req.method === "POST") {
    const result = store.blockSenderForEmail(blockMatch[1], (await readJSON(req)).scope);
    if (!result) throw httpError(404, "Email not found.");
    events.emit("emails.changed", { emailId: result.email.id, affectedCount: result.affectedCount });
    sendJSON(res, 200, result);
    return;
  }

  const labelMatch = path.match(/^\/api\/emails\/([^/]+)\/labels$/);
  if (labelMatch && req.method === "POST") {
    const body = await readJSON(req);
    const email = store.setEmailLabel(labelMatch[1], body.labelId, body.action);
    events.emit("emails.changed", { emailId: email.id });
    sendJSON(res, 200, { email });
    return;
  }

  if (req.method === "POST" && path === "/api/messages/send") {
    const body = await readJSON(req);
    const email = store.sendMessage(body);
    if (providers) {
      try {
        const result = await providers.sendMessage(email, body);
        if (result.status === "sent") {
          store.markOutboundSent(email.outboundId, result.providerUID);
          email.outboundStatus = "sent";
        }
      } catch (error) {
        const message = error?.message ?? String(error);
        store.markOutboundFailed(email.outboundId, error);
        email.outboundStatus = "failed";
        email.outboundError = message;
        events.emit("emails.changed", { emailId: email.id });
        throw httpError(502, `Sending failed: ${message}`);
      }
    }
    events.emit("emails.changed", { emailId: email.id });
    sendJSON(res, 202, {
      email,
      trackingPixelURL: email.trackingId ? `${baseURL}/api/track/open/${email.trackingId}.gif` : null
    });
    return;
  }

  const trackingMatch = path.match(/^\/api\/track\/open\/([^/]+)\.gif$/);
  if (trackingMatch && req.method === "GET") {
    const email = store.recordOpen(trackingMatch[1], {
      userAgent: req.headers["user-agent"] ?? null,
      remoteAddr: req.socket.remoteAddress ?? null
    });
    if (email) {
      events.emit("emails.changed", { emailId: email.id });
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

  throw httpError(404, "Route not found.");
}

function sendJSON(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  sendCORS(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function requireProviders(providers) {
  if (!providers) throw httpError(500, "Provider services are not configured.");
}

function requestBaseURL(req, configuredBaseURL, fallbackBaseURL) {
  if (configuredBaseURL) return configuredBaseURL;

  const host = firstHeaderValue(req.headers["x-forwarded-host"]) ?? firstHeaderValue(req.headers.host);
  if (!host) return fallbackBaseURL;

  const proto = firstHeaderValue(req.headers["x-forwarded-proto"]) ?? "http";
  return normalizedBaseURL(`${proto}://${host}`);
}

function firstHeaderValue(value) {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.split(",")[0]?.trim() || null;
}

function normalizedBaseURL(value) {
  if (!value) return null;
  return String(value).replace(/\/+$/u, "");
}

function publicSyncResult(sync = {}) {
  const { newEmails, ...publicSync } = sync;
  return publicSync;
}

function prefetchInboxTriage(inboxTriage) {
  try {
    inboxTriage?.prefetchIfUseful?.();
  } catch (error) {
    console.warn(`${new Date().toISOString()} inbox triage prefetch failed: ${error.message}`);
  }
}

async function sendPushNotifications(pushNotifications, newEmails = []) {
  if (!pushNotifications || !Array.isArray(newEmails) || newEmails.length === 0) return;
  try {
    const result = await pushNotifications.sendNewEmailNotifications(newEmails);
    if (result.sent > 0 || result.skipped > 0) {
      console.log(`${new Date().toISOString()} push notifications ${summarizePushNotificationResult(result)}`);
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

function syncAccountInBackground({ providers, events, accountId, limit }) {
  setTimeout(async () => {
    try {
      console.log(`${new Date().toISOString()} background sync started account=${accountId}`);
      const sync = await providers.syncGmailAccount(accountId, { limit });
      console.log(`${new Date().toISOString()} background sync completed account=${accountId} imported=${sync.imported}`);
      events.emit("emails.changed", { accountId });
      events.emit("accounts.changed", { accountId });
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

  subscribe(req, res) {
    sendCORS(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("event: ready\ndata: {}\n\n");
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  emit(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }
}
