import assert from "node:assert/strict";
import test from "node:test";
import { formatAddress, makeTextMessage } from "../src/mime.js";

test("formats display names in From headers", () => {
  const from = formatAddress("Borja", "p3rzival@gmail.com");
  const raw = makeTextMessage({
    from,
    to: "hi@borja.ai",
    subject: "Hello",
    text: "Hello"
  });

  assert.equal(from, "\"Borja\" <p3rzival@gmail.com>");
  assert.match(raw, /^From: "Borja" <p3rzival@gmail\.com>\r\n/u);
});

test("includes reply threading headers", () => {
  const raw = makeTextMessage({
    from: "person@example.com",
    to: "friend@example.com",
    subject: "Re: Hello",
    text: "Reply",
    messageId: "<reply@example.com>",
    inReplyTo: "<original@example.com>",
    references: ["<root@example.com>", "<original@example.com>"]
  });

  assert.match(raw, /^Message-ID: <reply@example\.com>\r\n/mu);
  assert.match(raw, /^In-Reply-To: <original@example\.com>\r\n/mu);
  assert.match(raw, /^References: <root@example\.com> <original@example\.com>\r\n/mu);
});
