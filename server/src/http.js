import { createServer as createHTTPServer } from "node:http";
import { httpError } from "./store.js";

const trackingPixel = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

export function createServer({ store, host = "127.0.0.1", port = 7331, publicBaseURL } = {}) {
  const events = new EventHub();
  const baseURL = publicBaseURL ?? `http://${host}:${port}`;

  const server = createHTTPServer(async (req, res) => {
    try {
      await route({ req, res, store, events, baseURL });
    } catch (error) {
      const status = error.status ?? 500;
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

async function route({ req, res, store, events, baseURL }) {
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

  if (req.method === "POST" && path === "/api/accounts") {
    const account = store.createAccount(await readJSON(req));
    events.emit("accounts.changed", { accountId: account.id });
    sendJSON(res, 201, { account });
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
    const email = store.sendMessage(await readJSON(req));
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

function sendCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

