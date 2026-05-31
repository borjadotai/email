import { Buffer } from "node:buffer";

export function base64url(input) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function formatAddress(name, email) {
  const cleanEmail = encodeHeader(email).trim();
  const cleanName = encodeHeader(name).trim();
  if (!cleanName || cleanName.toLowerCase() === cleanEmail.toLowerCase()) {
    return cleanEmail;
  }
  return `"${cleanName.replace(/["\\]/gu, "\\$&")}" <${cleanEmail}>`;
}

export function makeTextMessage({ from, to, cc, bcc, subject, text, html, messageId, inReplyTo, references, attachments = [] }) {
  const headers = [
    ["From", from],
    ["To", to],
    ["Cc", cc],
    ["Bcc", bcc],
    ["Subject", subject],
    ["Message-ID", messageId],
    ["In-Reply-To", inReplyTo],
    ["References", Array.isArray(references) ? references.join(" ") : references],
    ["MIME-Version", "1.0"],
    ["Date", new Date().toUTCString()]
  ]
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `${name}: ${encodeHeader(value)}`);

  if (attachments.length > 0) {
    const mixedBoundary = `email-mixed-${Date.now().toString(36)}`;
    const bodyPart = html
      ? multipartAlternativePart({ text, html })
      : textPart(text);
    return [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      "",
      `--${mixedBoundary}`,
      bodyPart,
      ...attachments.map(attachment => attachmentPart(mixedBoundary, attachment)),
      `--${mixedBoundary}--`,
      ""
    ].join("\r\n");
  }

  if (html) {
    return [...headers, multipartAlternativePart({ text, html }), ""].join("\r\n");
  }

  return [
    ...headers,
    textPart(text),
    ""
  ].join("\r\n");
}

function encodeHeader(value) {
  return String(value).replace(/\r?\n/gu, " ");
}

function textPart(text) {
  return [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text
  ].join("\r\n");
}

function multipartAlternativePart({ text, html }) {
  const boundary = `email-alt-${Date.now().toString(36)}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    textPart(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`
  ].join("\r\n");
}

function attachmentPart(boundary, attachment) {
  const filename = encodeHeader(attachment.filename || "Attachment");
  const mimeType = encodeHeader(attachment.mimeType || "application/octet-stream");
  const data = Buffer.isBuffer(attachment.data)
    ? attachment.data
    : attachment.data
      ? Buffer.from(attachment.data)
      : Buffer.alloc(0);
  return [
    `--${boundary}`,
    `Content-Type: ${mimeType}; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    wrapBase64(data.toString("base64"))
  ].join("\r\n");
}

function wrapBase64(value) {
  return String(value).match(/.{1,76}/gu)?.join("\r\n") ?? "";
}
