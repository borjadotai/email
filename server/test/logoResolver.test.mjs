import assert from "node:assert/strict";
import test from "node:test";
import { logoDomainForEmail, senderLogoURLForEmail } from "../src/logoResolver.js";

test("resolves stable logo domains from sender email addresses", () => {
  assert.equal(logoDomainForEmail("Apple <noreply@email.apple.com>"), "apple.com");
  assert.equal(logoDomainForEmail("alerts@security.google.co.uk"), "google.co.uk");
  assert.equal(logoDomainForEmail("person@gmail.com"), "gmail.com");
  assert.equal(logoDomainForEmail("not-an-email"), null);
});

test("builds a sender logo URL for AsyncImage", () => {
  assert.equal(
    senderLogoURLForEmail("newsletter@email.apple.com"),
    "https://www.google.com/s2/favicons?domain=apple.com&sz=128"
  );
});
