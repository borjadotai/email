import { createServer as createHTTPServer } from "node:http";
import { httpError } from "./store.js";

const trackingPixel = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

export function createServer({ store, providers, host = "127.0.0.1", port = 7331, publicBaseURL } = {}) {
  const events = new EventHub();
  const baseURL = publicBaseURL ?? `http://${host}:${port}`;

  const server = createHTTPServer(async (req, res) => {
    try {
      await route({ req, res, store, providers, events, baseURL });
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

async function route({ req, res, store, providers, events, baseURL }) {
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

  if (req.method === "GET" && path === "/api/auth/settings") {
    requireProviders(providers);
    sendJSON(res, 200, { settings: providers.getAuthSettings() });
    return;
  }

  if (req.method === "POST" && path === "/api/auth/gmail/start") {
    requireProviders(providers);
    console.log(`${new Date().toISOString()} POST /api/auth/gmail/start`);
    sendJSON(res, 200, await providers.startGmailAuth(await readJSON(req)));
    return;
  }

  if (req.method === "GET" && path === "/api/auth/gmail/callback") {
    requireProviders(providers);
    const result = await providers.completeGmailAuth(Object.fromEntries(url.searchParams.entries()));
    events.emit("accounts.changed", { accountId: result.account.id });
    events.emit("emails.changed", { accountId: result.account.id });
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
    sendJSON(res, 200, result);
    return;
  }

  if (req.method === "POST" && path === "/api/accounts") {
    const account = store.createAccount(await readJSON(req));
    events.emit("accounts.changed", { accountId: account.id });
    sendJSON(res, 201, { account });
    return;
  }

  const accountSyncMatch = path.match(/^\/api\/accounts\/([^/]+)\/sync$/);
  if (accountSyncMatch && req.method === "POST") {
    requireProviders(providers);
    const sync = await providers.syncAccount(accountSyncMatch[1]);
    events.emit("emails.changed", { accountId: accountSyncMatch[1] });
    sendJSON(res, 200, { sync });
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

  if (req.method === "GET" && path === "/api/emails") {
    const emails = store.listEmails(Object.fromEntries(url.searchParams.entries()));
    sendJSON(res, 200, { emails });
    return;
  }

  const emailMatch = path.match(/^\/api\/emails\/([^/]+)$/);
  if (emailMatch && req.method === "GET") {
    const email = store.getEmail(emailMatch[1]);
    if (!email) throw httpError(404, "Email not found.");
    sendJSON(res, 200, { email });
    return;
  }

  if (emailMatch && req.method === "PATCH") {
    const email = store.updateEmail(emailMatch[1], await readJSON(req));
    if (!email) throw httpError(404, "Email not found.");
    events.emit("emails.changed", { emailId: email.id });
    sendJSON(res, 200, { email });
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

function sendCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function requireProviders(providers) {
  if (!providers) throw httpError(500, "Provider services are not configured.");
}

function authSuccessPage(result) {
  const account = result.account;
  const imported = result.sync?.imported ?? 0;
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
      <p>${escapeHTML(account.email)} is connected. Imported ${imported} messages into the local search index.</p>
      <p>You can close this window and return to Email.</p>
    </main>
  </body>
</html>`;
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
