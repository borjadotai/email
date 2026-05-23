import { Buffer } from "node:buffer";

export function base64url(input) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function makeTextMessage({ from, to, cc, bcc, subject, text, html }) {
  const headers = [
    ["From", from],
    ["To", to],
    ["Cc", cc],
    ["Bcc", bcc],
    ["Subject", subject],
    ["MIME-Version", "1.0"],
    ["Date", new Date().toUTCString()]
  ]
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `${name}: ${encodeHeader(value)}`);

  if (html) {
    const boundary = `email-${Date.now().toString(36)}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
      `--${boundary}--`,
      ""
    ].join("\r\n");
  }

  return [
    ...headers,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    ""
  ].join("\r\n");
}

function encodeHeader(value) {
  return String(value).replace(/\r?\n/gu, " ");
}

