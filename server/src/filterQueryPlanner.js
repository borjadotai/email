import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CODEX_TIMEOUT_MS = 25_000;

const STOP_WORDS = new Set([
  "a", "all", "and", "any", "are", "create", "email", "emails", "for", "from",
  "have", "i", "in", "is", "it", "mail", "me", "messages", "my", "of", "on",
  "or", "show", "that", "the", "to", "view", "with"
]);

export function defaultFilterQueryPlan(prompt, options = {}) {
  const fallback = fallbackFilterQueryPlan(prompt);
  if (process.env.EMAIL_FILTER_DISABLE_CODEX === "1") {
    return fallback;
  }
  if (isInvoicePrompt(prompt) || isTaxPrompt(prompt)) {
    return fallback;
  }

  const command = resolveCodexCommand();
  const timeoutMs = Number.parseInt(process.env.EMAIL_FILTER_CODEX_TIMEOUT_MS ?? "", 10) || DEFAULT_CODEX_TIMEOUT_MS;
  const runner = options.runner ?? execFileSync;

  try {
    const output = runner(command, codexArgs(), {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      input: plannerPrompt(prompt),
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        NO_COLOR: "1"
      }
    });
    return normalizePlan(extractJSON(output), fallback, "codex");
  } catch (error) {
    return {
      ...fallback,
      source: "heuristic",
      error: `Codex filter planner unavailable: ${error.message}`
    };
  }
}

export function fallbackFilterQueryPlan(prompt) {
  const lower = String(prompt ?? "").toLowerCase();
  if (isInvoicePrompt(prompt)) {
    return {
      name: "Invoices",
      color: "green",
      icon: "doc.text",
      source: "heuristic",
      sql: `SELECT e.id
FROM emails e
WHERE (
    lower(e.subject) LIKE '%invoice%'
    OR lower(e.subject) LIKE '%factura%'
    OR lower(e.subject) LIKE '%receipt%'
    OR lower(e.subject) LIKE '%recibo%'
    OR lower(e.subject) LIKE '%billing%'
    OR lower(e.subject) LIKE '%nomina%'
    OR lower(e.subject) LIKE '%nómina%'
    OR lower(e.subject) LIKE '%pedido%'
    OR lower(e.subject) LIKE '%payment confirmation%'
    OR lower(e.subject) LIKE '%direct debit paid%'
    OR lower(e.sender_name) LIKE '%receipt%'
    OR lower(e.sender_email) LIKE '%receipt%'
    OR lower(e.sender_name) LIKE '%billing%'
    OR lower(e.sender_email) LIKE '%billing%'
    OR lower(e.sender_name) LIKE '%accounting%'
    OR lower(e.sender_email) LIKE '%accounting%'
    OR (
      lower(e.sender_email) LIKE '%amazon.%'
      AND (
        lower(e.subject) LIKE '%order%'
        OR lower(e.subject) LIKE '%pedido%'
        OR lower(e.subject) LIKE '%entregado%'
      )
    )
    OR (
      lower(e.sender_email) LIKE '%uber.%'
      AND lower(e.sender_name) LIKE '%receipt%'
    )
    OR EXISTS (
      SELECT 1
      FROM email_attachments ea
      WHERE ea.email_id = e.id
        AND ea.is_inline = 0
        AND (
          lower(ea.filename) LIKE '%invoice%'
          OR lower(ea.filename) LIKE '%factura%'
          OR lower(ea.filename) LIKE '%receipt%'
          OR lower(ea.filename) LIKE '%recibo%'
          OR lower(ea.filename) LIKE '%nomina%'
          OR lower(ea.filename) LIKE '%nómina%'
        )
    )
    OR (
      e.has_attachments = 1
      AND (
        lower(e.snippet) LIKE '%invoice%'
        OR lower(e.snippet) LIKE '%factura%'
        OR lower(e.snippet) LIKE '%receipt%'
        OR lower(e.snippet) LIKE '%recibo%'
        OR lower(e.snippet) LIKE '%billing%'
        OR lower(e.snippet) LIKE '%nomina%'
        OR lower(e.snippet) LIKE '%nómina%'
        OR lower(e.body_text) LIKE '%invoice%'
        OR lower(e.body_text) LIKE '%factura%'
        OR lower(e.body_text) LIKE '%receipt%'
        OR lower(e.body_text) LIKE '%recibo%'
        OR lower(e.body_text) LIKE '%billing%'
        OR lower(e.body_text) LIKE '%nomina%'
        OR lower(e.body_text) LIKE '%nómina%'
      )
    )
  )
ORDER BY e.received_at DESC`
    };
  }

  if (/\b(newsletter|newsletters|digest|digests)\b/u.test(lower)) {
    return {
      name: "Newsletters",
      color: "purple",
      icon: "newspaper",
      source: "heuristic",
      sql: `SELECT e.id
FROM emails e
WHERE lower(e.sender_name) LIKE '%newsletter%'
  OR lower(e.sender_email) LIKE '%newsletter%'
  OR lower(e.subject) LIKE '%newsletter%'
  OR lower(e.subject) LIKE '%digest%'
  OR lower(e.body_text) LIKE '%unsubscribe%'
  OR lower(e.body_text) LIKE '%manage preferences%'
  OR lower(e.body_text) LIKE '%email preferences%'
  OR lower(e.body_text) LIKE '%view in browser%'
  OR lower(e.body_text) LIKE '%read online%'
ORDER BY e.received_at DESC`
    };
  }

  if (isTaxPrompt(prompt)) {
    return taxFilterQueryPlan();
  }

  const terms = meaningfulTerms(prompt);
  const conditions = terms.length
    ? terms.map(term => {
      const pattern = sqlString(`%${term}%`);
      return `(lower(e.subject) LIKE ${pattern} OR lower(e.snippet) LIKE ${pattern} OR lower(e.body_text) LIKE ${pattern} OR lower(e.sender_name) LIKE ${pattern} OR lower(e.sender_email) LIKE ${pattern})`;
    }).join("\n  AND ")
    : "1 = 1";

  return {
    name: titleFromPrompt(prompt),
    color: "teal",
    icon: "line.3.horizontal.decrease.circle",
    source: "heuristic",
    sql: `SELECT e.id
FROM emails e
WHERE ${conditions}
ORDER BY e.received_at DESC`
  };
}

export function isInvoicePrompt(prompt) {
  return /\b(invoice|invoices|factura|facturas|receipt|receipts|recibo|recibos|billing|nomina|nómina)\b/iu.test(String(prompt ?? ""));
}

export function isTaxPrompt(prompt) {
  return /\b(tax|taxes|taxation|accountant|accountants|accounting|taxscouts|taxdown|impuesto|impuestos|renta|irpf|iva|vat|hacienda|aeat|gestor|gestores|gestoria|gestoría|gestorias|gestorías|asesor fiscal|asesoria fiscal|asesoría fiscal|agencia tributaria)\b/iu.test(String(prompt ?? ""));
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
  if (process.env.EMAIL_FILTER_CODEX_COMMAND) {
    return process.env.EMAIL_FILTER_CODEX_COMMAND;
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

function plannerPrompt(prompt) {
  return `You turn a user's email view request into a safe SQLite query.

Return ONLY compact JSON. No markdown. Shape:
{"name":"Short title","color":"teal|green|blue|orange|purple|red|pink|cyan|indigo|mint|yellow|gray","icon":"SF Symbols name","sql":"SELECT e.id FROM emails e ... ORDER BY e.received_at DESC"}

The query must:
- be exactly one read-only SELECT returning only e.id
- start from "emails e"
- use only these tables: emails e, accounts a, mailboxes m, labels l, email_labels el, email_attachments ea, email_fts
- never use semicolons, comments, PRAGMA, ATTACH, INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, REPLACE, VACUUM, or parameters
- prefer EXISTS subqueries for attachments and labels
- include ORDER BY e.received_at DESC
- never use unbounded short substring predicates such as LIKE '%tax%', LIKE '%vat%', or LIKE '%iva%'. Short words must be matched as whole tokens with delimiters or by stronger phrases/senders, otherwise terms like "iva" match "privacy" and "activation".

Columns:
emails e: id, account_id, mailbox_id, sender_name, sender_email, recipients_json, cc_json, bcc_json, subject, snippet, body_text, sent_at, received_at, is_read, is_starred, importance, has_attachments
accounts a: id, provider, email, display_name
mailboxes m: id, account_id, name, role
labels l: id, account_id, name, color, icon
email_labels el: email_id, label_id
email_attachments ea: email_id, filename, mime_type, size, disposition, is_inline
email_fts: email_id, account_id, subject, sender_name, sender_email, recipients, snippet, body_text

For "invoices", match invoice/receipt/factura/recibo/billing/payment evidence in subject, sender, or attachment filename. Body-only evidence should be used only with another signal such as e.has_attachments = 1, because newsletters often mention invoice words in footers. Do not require e.has_attachments = 1 just because the prompt says invoice; many receipt emails are link-only.
For "newsletters", look for newsletter/digest signals and subscription markers such as unsubscribe, manage preferences, view in browser, read online, sender/newsletter naming.
For "tax/accountant/tax firm" views, do not use loose substring checks for short tax terms like "iva", "vat", or "tax"; those match unrelated words like "privacy" and "activation". Prefer sender/domain tax firm signals, tax-return phrases, official tax authority names, or attachment filenames. Body-only tax mentions are usually too noisy. Generic vendor VAT billing notices should not match unless the user explicitly asks for vendor VAT/GST billing.

User request: ${JSON.stringify(String(prompt ?? ""))}`;
}

function taxFilterQueryPlan() {
  const senderSignals = [
    likeAny("e.sender_name", [
      "taxscouts", "taxdown", "accountant", "accounting", "gestor", "gestoría",
      "gestoria", "asesor fiscal", "asesoría fiscal", "asesoria fiscal",
      "hacienda", "agencia tributaria", "hmrc"
    ]),
    likeAny("e.sender_email", [
      "taxscouts", "taxdown", "accountant", "accounting", "gestor", "gestoria",
      "hacienda", "aeat", "agenciatributaria", "hmrc"
    ]),
    wordAny("e.sender_name", ["tax", "taxes", "aeat", "irpf"]),
    wordAny("e.sender_email", ["tax", "taxes", "aeat", "irpf"])
  ];
  const subjectSignals = [
    likeAny("e.subject", [
      "tax return", "tax filing", "declaracion de la renta", "declaración de la renta",
      "declaracion de iva", "declaración de iva", "agencia tributaria", "asesor fiscal",
      "asesoría fiscal", "asesoria fiscal", "modelo 100", "modelo 130", "modelo 303"
    ]),
    wordAny("e.subject", ["impuesto", "impuestos", "renta", "irpf", "hacienda", "aeat"])
  ];
  const snippetSignals = [
    likeAny("e.snippet", [
      "tax return", "tax filing", "declaracion de la renta", "declaración de la renta",
      "agencia tributaria", "modelo 100", "modelo 130", "modelo 303"
    ]),
    wordAny("e.snippet", ["irpf", "hacienda", "aeat"])
  ];
  const attachmentSignals = [
    likeAny("ea.filename", [
      "tax-return", "tax_return", "declaracion-renta", "declaracion_renta",
      "declaración-renta", "declaración_renta"
    ]),
    wordAny("ea.filename", ["tax", "taxes", "renta", "irpf", "iva", "hacienda", "aeat", "impuesto", "impuestos"])
  ];

  return {
    name: "Tax",
    color: "teal",
    icon: "doc.text.magnifyingglass",
    source: "heuristic",
    sql: `SELECT e.id
FROM emails e
WHERE (
    ${[...senderSignals, ...subjectSignals, ...snippetSignals].filter(Boolean).join("\n    OR ")}
    OR EXISTS (
      SELECT 1
      FROM email_attachments ea
      WHERE ea.email_id = e.id
        AND ea.is_inline = 0
        AND (
          ${attachmentSignals.filter(Boolean).join("\n          OR ")}
        )
    )
  )
ORDER BY e.received_at DESC`
  };
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

function normalizePlan(value, fallback, source) {
  const plan = value && typeof value === "object" ? value : {};
  return {
    name: cleanString(plan.name) ?? fallback.name,
    color: cleanString(plan.color) ?? fallback.color,
    icon: cleanString(plan.icon) ?? fallback.icon,
    sql: cleanString(plan.sql) ?? fallback.sql,
    source,
    error: null
  };
}

function meaningfulTerms(value) {
  return [...new Set(String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/gu, " ")
    .split(/\s+/u)
    .map(term => term.trim())
    .filter(term => term.length >= 3 && !STOP_WORDS.has(term))
    .slice(0, 6))];
}

function likeAny(field, values) {
  const conditions = values
    .map(value => cleanString(value))
    .filter(Boolean)
    .map(value => `lower(coalesce(${field}, '')) LIKE ${sqlString(`%${value.toLowerCase()}%`)}`);
  return conditions.length ? `(${conditions.join(" OR ")})` : "";
}

function wordAny(field, values) {
  const haystack = normalizedWordHaystack(field);
  const conditions = values
    .map(value => cleanString(value))
    .filter(Boolean)
    .map(value => `${haystack} LIKE ${sqlString(`% ${value.toLowerCase()} %`)}`);
  return conditions.length ? `(${conditions.join(" OR ")})` : "";
}

function normalizedWordHaystack(field) {
  let expression = `lower(coalesce(${field}, ''))`;
  for (const character of [".", ",", ":", ";", "/", "\\", "-", "_", "(", ")", "[", "]", "{", "}", "<", ">", "@", "+", "*", "#", "&", "!", "?", "\n", "\r", "\t"]) {
    expression = `replace(${expression}, ${sqlCharacterExpression(character)}, ' ')`;
  }
  return `(' ' || ${expression} || ' ')`;
}

function sqlCharacterExpression(value) {
  switch (value) {
    case "\n":
      return "char(10)";
    case "\r":
      return "char(13)";
    case "\t":
      return "char(9)";
    case ":":
      return "char(58)";
    case ";":
      return "char(59)";
    case "\\":
      return "char(92)";
    case "*":
      return "char(42)";
    case "/":
      return "char(47)";
    case "?":
      return "char(63)";
    case "@":
      return "char(64)";
    default:
      return sqlString(value);
  }
}

function titleFromPrompt(value) {
  const terms = meaningfulTerms(value).slice(0, 3);
  if (terms.length === 0) return "New Filter";
  return terms.map(term => term[0].toUpperCase() + term.slice(1)).join(" ");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
