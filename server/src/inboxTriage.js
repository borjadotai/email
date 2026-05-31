import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CODEX_TIMEOUT_MS = 45_000;
const DEFAULT_ANALYSIS_LIMIT = 50;
const DEFAULT_PREFETCH_THRESHOLD = 10;
const SUMMARY_BODY_LIMIT = 900;

export class InboxTriageService {
  constructor({
    store,
    classifier = defaultInboxTriageClassifier,
    prefetchThreshold = DEFAULT_PREFETCH_THRESHOLD,
    logger = console
  } = {}) {
    this.store = store;
    this.classifier = classifier;
    this.prefetchThreshold = prefetchThreshold;
    this.logger = logger;
    this.inFlight = new Map();
  }

  async analyze({ accountId = null, limit = DEFAULT_ANALYSIS_LIMIT, force = false } = {}) {
    const scope = normalizeScope({ accountId });
    const cappedLimit = clampInt(limit, 1, 100, DEFAULT_ANALYSIS_LIMIT);
    const emails = this.store.listUnreadInboxEmailsForTriage({ accountId: scope.accountId, limit: cappedLimit });
    const unreadCount = this.store.countUnreadInboxEmails({ accountId: scope.accountId });
    const signature = triageSignature({ scope, unreadCount, emails });
    const cacheKey = triageCacheKey(scope);

    if (!force) {
      const cached = this.cachedResult(cacheKey, signature);
      if (cached) {
        return { ...cached, isCached: true };
      }
      if (this.inFlight.has(cacheKey)) {
        return this.inFlight.get(cacheKey);
      }
    }

    const promise = this.buildAndCacheResult({
      cacheKey,
      scope,
      emails,
      unreadCount,
      signature,
      limit: cappedLimit
    });
    this.inFlight.set(cacheKey, promise);

    try {
      return await promise;
    } finally {
      if (this.inFlight.get(cacheKey) === promise) {
        this.inFlight.delete(cacheKey);
      }
    }
  }

  prefetchIfUseful({ accountId = null, limit = DEFAULT_ANALYSIS_LIMIT } = {}) {
    const scope = normalizeScope({ accountId });
    const unreadCount = this.store.countUnreadInboxEmails({ accountId: scope.accountId });
    if (unreadCount < this.prefetchThreshold) {
      return { started: false, reason: "below_threshold", unreadCount };
    }

    const cappedLimit = clampInt(limit, 1, 100, DEFAULT_ANALYSIS_LIMIT);
    const emails = this.store.listUnreadInboxEmailsForTriage({ accountId: scope.accountId, limit: cappedLimit });
    const signature = triageSignature({ scope, unreadCount, emails });
    const cacheKey = triageCacheKey(scope);
    if (this.cachedResult(cacheKey, signature) || this.inFlight.has(cacheKey)) {
      return { started: false, reason: "cached_or_running", unreadCount };
    }

    this.analyze({ accountId: scope.accountId, limit: cappedLimit, force: false })
      .then(result => {
        this.logger?.log?.(`${new Date().toISOString()} inbox triage prefetched unread=${result.unreadCount} analyzed=${result.analyzedCount} source=${result.source}`);
      })
      .catch(error => {
        this.logger?.warn?.(`${new Date().toISOString()} inbox triage prefetch failed: ${error.message}`);
      });

    return { started: true, unreadCount };
  }

  cachedResult(cacheKey, signature) {
    const cached = parseJSON(this.store.getSetting(cacheKey, null), null);
    if (!cached || cached.signature !== signature || !cached.result) return null;
    return cached.result;
  }

  async buildAndCacheResult({ cacheKey, scope, emails, unreadCount, signature, limit }) {
    let plan;
    let source = "heuristic";
    let error = null;

    if (emails.length > 0) {
      try {
        plan = await this.classifier(emails, { limit });
        source = cleanString(plan?.source) ?? "codex";
      } catch (classificationError) {
        error = classificationError.message;
        plan = fallbackInboxTriagePlan(emails);
      }
    } else {
      plan = { source: "empty", read: [], archive: [], summaryBullets: [] };
      source = "empty";
    }

    const normalizedPlan = normalizeTriagePlan(plan, emails);
    if (normalizedPlan.fallbackUsed && source !== "heuristic") {
      source = "heuristic";
    }

    const now = new Date().toISOString();
    const result = {
      id: signature,
      scope,
      generatedAt: now,
      source,
      error,
      isCached: false,
      unreadCount,
      analyzedCount: emails.length,
      limit,
      summaryBullets: normalizedPlan.summaryBullets,
      sections: normalizedPlan.sections
    };

    this.store.setSetting(cacheKey, JSON.stringify({ signature, result }));
    return result;
  }
}

export async function defaultInboxTriageClassifier(emails, options = {}) {
  if (process.env.EMAIL_TRIAGE_DISABLE_CODEX === "1") {
    return fallbackInboxTriagePlan(emails);
  }

  const command = resolveCodexCommand();
  const timeoutMs = Number.parseInt(process.env.EMAIL_TRIAGE_CODEX_TIMEOUT_MS ?? "", 10) || DEFAULT_CODEX_TIMEOUT_MS;
  const runner = options.runner ?? execFile;
  const output = await runClassifierCommand(runner, command, codexArgs(), {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    input: triagePrompt(emails),
    env: {
      ...process.env,
      NO_COLOR: "1"
    }
  });
  return { ...extractJSON(output), source: "codex" };
}

function runClassifierCommand(runner, command, args, options) {
  return new Promise((resolve, reject) => {
    const child = runner(command, args, {
      encoding: options.encoding,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env: options.env
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });

    child?.stdin?.end?.(options.input);
  });
}

export function fallbackInboxTriagePlan(emails) {
  const read = [];
  const archive = [];

  for (const email of emails) {
    const classification = fallbackClassification(email);
    const item = {
      id: email.id,
      reason: classification.reason,
      priority: classification.priority
    };

    if (classification.intent === "archive") {
      archive.push(item);
    } else {
      read.push({
        ...item,
        summaryBullets: fallbackSummaryBullets(email)
      });
    }
  }

  return {
    source: "heuristic",
    summaryBullets: read.slice(0, 5).map(item => item.summaryBullets[0]).filter(Boolean),
    read,
    archive
  };
}

function normalizeTriagePlan(plan, emails) {
  const emailById = new Map(emails.map(email => [email.id, email]));
  const assigned = new Set();
  let fallbackUsed = false;

  const readItems = normalizeItems(plan?.read ?? plan?.worthReading ?? [], emailById, assigned, "read");
  const archiveItems = normalizeItems(plan?.archive ?? plan?.canArchive ?? [], emailById, assigned, "archive");

  const missingEmails = emails.filter(email => !assigned.has(email.id));
  if (missingEmails.length > 0 || (readItems.length === 0 && archiveItems.length === 0 && emails.length > 0)) {
    fallbackUsed = true;
    const fallback = fallbackInboxTriagePlan(missingEmails.length > 0 ? missingEmails : emails);
    readItems.push(...normalizeItems(fallback.read, emailById, assigned, "read"));
    archiveItems.push(...normalizeItems(fallback.archive, emailById, assigned, "archive"));
  }

  const summaryBullets = arrayOfCleanStrings(plan?.summaryBullets)
    .concat(readItems.flatMap(item => item.summaryBullets ?? []).slice(0, 5))
    .slice(0, 6);

  return {
    fallbackUsed,
    summaryBullets: uniqueStrings(summaryBullets),
    sections: [
      triageSection({
        id: "read",
        title: "Worth Reading",
        intent: "read",
        emails: readItems
      }),
      triageSection({
        id: "archive",
        title: "Can Archive",
        intent: "archive",
        emails: archiveItems
      })
    ]
  };
}

function normalizeItems(items, emailById, assigned, intent) {
  const normalized = [];
  for (const rawItem of Array.isArray(items) ? items : []) {
    const id = typeof rawItem === "string" ? rawItem : cleanString(rawItem?.id);
    if (!id || assigned.has(id)) continue;
    const email = emailById.get(id);
    if (!email) continue;
    assigned.add(id);
    normalized.push(publicTriageEmail(email, {
      intent,
      reason: cleanString(rawItem?.reason) ?? fallbackClassification(email).reason,
      priority: cleanString(rawItem?.priority) ?? fallbackClassification(email).priority,
      summaryBullets: intent === "read"
        ? arrayOfCleanStrings(rawItem?.summaryBullets ?? rawItem?.bullets).slice(0, 4)
        : []
    }));
  }
  return normalized;
}

function triageSection({ id, title, intent, emails }) {
  return {
    id,
    title,
    intent,
    count: emails.length,
    emails
  };
}

function publicTriageEmail(email, { intent, reason, priority, summaryBullets }) {
  return {
    id: email.id,
    accountId: email.accountId,
    accountEmail: email.accountEmail,
    senderName: email.senderName,
    senderEmail: email.senderEmail,
    senderAvatarURL: email.senderAvatarURL,
    subject: email.subject,
    snippet: email.snippet,
    receivedAt: email.receivedAt,
    intent,
    reason,
    priority,
    summaryBullets: summaryBullets.length > 0 ? summaryBullets : (intent === "read" ? fallbackSummaryBullets(email) : [])
  };
}

function fallbackClassification(email) {
  const text = `${email.senderName} ${email.senderEmail} ${email.subject} ${email.snippet} ${email.bodyText}`.toLowerCase();
  const sender = String(email.senderEmail ?? "").toLowerCase();

  if (/\b(security|verify|verification|password|sign.?in|login|2fa|two.?factor|alert|blocked|suspicious)\b/u.test(text)) {
    return { intent: "read", priority: "high", reason: "Security or account access signal." };
  }
  if (/\b(invoice|receipt|payment|paid|billing|bill|statement|refund|charge|direct debit|factura|recibo|nomina|nómina)\b/u.test(text)) {
    return { intent: "read", priority: "high", reason: "Money, billing, or receipt signal." };
  }
  if (/\b(interview|meeting|calendar|invitation|rsvp|booking|flight|hotel|reservation|ticket|delivery|shipment|order)\b/u.test(text)) {
    return { intent: "read", priority: "medium", reason: "Time-sensitive logistics or scheduling signal." };
  }
  if (/\b(action required|respond|reply|urgent|important|deadline|due|approved|rejected|failed|problem|issue)\b/u.test(text)) {
    return { intent: "read", priority: "high", reason: "Looks actionable or time-sensitive." };
  }
  if (/\b(unsubscribe|manage preferences|view in browser|read online|newsletter|digest|sale|discount|offer|promo|promotion|new post|recommended|suggested|followers?|likes?|reposted|notification)\b/u.test(text)) {
    return { intent: "archive", priority: "low", reason: "Bulk, promotional, or notification-style message." };
  }
  if (/^(no-?reply|noreply|donotreply|notifications?|newsletter|updates?)@/u.test(sender)) {
    return { intent: "archive", priority: "low", reason: "Automated sender with no strong action signal." };
  }

  return { intent: "read", priority: "medium", reason: "Unclear messages stay in the reading pile." };
}

function fallbackSummaryBullets(email) {
  const subject = cleanString(email.subject) || "(No subject)";
  const sender = cleanString(email.senderName) || cleanString(email.senderEmail) || "Unknown sender";
  const preview = cleanString(email.snippet) || cleanString(email.bodyText) || "No preview text available.";
  return [`${sender}: ${subject}. ${preview}`.slice(0, 220)];
}

function triagePrompt(emails) {
  const items = emails.map(email => ({
    id: email.id,
    from: `${email.senderName} <${email.senderEmail}>`,
    account: email.accountEmail,
    subject: email.subject,
    snippet: email.snippet,
    receivedAt: email.receivedAt,
    bodyText: trimForPrompt(email.bodyText, SUMMARY_BODY_LIMIT)
  }));

  return `You classify unread inbox email for a private email client.

Return ONLY compact JSON. No markdown. Shape:
{"summaryBullets":["Overall bullet"],"read":[{"id":"email-id","priority":"high|medium|low","reason":"Short reason","summaryBullets":["Bullet point summary"]}],"archive":[{"id":"email-id","priority":"low","reason":"Short reason"}]}

Rules:
- Every email id must appear exactly once in either read or archive.
- Put uncertain emails in read.
- Put security, billing, receipts, invoices, travel, delivery, calendar, direct human messages, support, deadlines, failed payments, and account alerts in read.
- Put clear newsletters, promotions, social notifications, marketing blasts, and automated low-signal updates in archive.
- For read emails, give 1-3 useful summary bullets based only on the email fields provided.
- Keep reasons and bullets short.

Unread emails:
${JSON.stringify(items)}`;
}

function codexArgs() {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-c",
    "model_reasoning_effort=\"low\"",
    "--color",
    "never",
    "-"
  ];
}

function resolveCodexCommand() {
  if (process.env.EMAIL_TRIAGE_CODEX_COMMAND) {
    return process.env.EMAIL_TRIAGE_CODEX_COMMAND;
  }

  for (const candidate of [
    join(homedir(), ".local/bin/codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
    "codex"
  ]) {
    if (candidate === "codex" || existsSync(candidate)) {
      return candidate;
    }
  }

  return "codex";
}

function extractJSON(output) {
  const text = String(output ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Codex did not return JSON.");
  }
}

function triageSignature({ scope, unreadCount, emails }) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    scope,
    unreadCount,
    ids: emails.map(email => [email.id, email.receivedAt, email.subject, email.snippet])
  }));
  return hash.digest("hex").slice(0, 24);
}

function triageCacheKey(scope) {
  return `inboxTriage.cache.${scope.accountId ?? "all"}`;
}

function normalizeScope({ accountId }) {
  return {
    accountId: cleanString(accountId),
    mailboxRole: "inbox",
    unreadOnly: true
  };
}

function trimForPrompt(value, limit) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function arrayOfCleanStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter(value => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function parseJSON(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
