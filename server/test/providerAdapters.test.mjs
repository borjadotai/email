import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderService, plainSnippet } from "../src/providerAdapters.js";
import { MemorySecretStore } from "../src/secretStore.js";
import { MailStore } from "../src/store.js";

test("classifies sent messages by the synced account identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "email-provider-"));
  const store = new MailStore({ databasePath: join(dir, "mail.sqlite") });

  try {
    const gmail = store.createAccount({
      provider: "gmail",
      email: "person@example.com",
      displayName: "Person"
    });
    const icloud = store.createAccount({
      provider: "icloud",
      email: "person@icloud.com",
      displayName: "Person iCloud"
    });
    const providers = new ProviderService({
      store,
      secretStore: new MemorySecretStore(),
      config: {},
      baseURL: "http://127.0.0.1:7331"
    });

    const gmailSelfMailbox = await providers.gmailMailboxFor(gmail.id, {
      labelIds: ["INBOX"],
      payload: {
        headers: [{ name: "From", value: "Person <person@example.com>" }]
      }
    });
    const gmailInboundMailbox = await providers.gmailMailboxFor(gmail.id, {
      labelIds: ["INBOX"],
      payload: {
        headers: [{ name: "From", value: "Person iCloud <person@icloud.com>" }]
      }
    });
    const iCloudInboundMailbox = await providers.iCloudMailboxFor(icloud.id, {
      from: {
        value: [{ address: "person@example.com" }]
      }
    });
    const iCloudSelfMailbox = await providers.iCloudMailboxFor(icloud.id, {
      from: {
        value: [{ address: "person@icloud.com" }]
      }
    });

    assert.equal(gmailSelfMailbox.role, "sent");
    assert.equal(gmailInboundMailbox.role, "inbox");
    assert.equal(iCloudInboundMailbox.role, "inbox");
    assert.equal(iCloudSelfMailbox.role, "sent");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extracts email snippets from visible HTML body content", () => {
  const html = `
    <!doctype html>
    <html>
      <head>
        <title>Order metadata title</title>
        <meta content="not preview content">
        <style>.hidden { display: none; }</style>
      </head>
      <body>
        <div style="display:none">Hidden preheader text</div>
        <p>Your order is ready.</p>
        <p>It ships tomorrow.</p>
      </body>
    </html>
  `;

  assert.equal(plainSnippet(html), "Your order is ready. It ships tomorrow.");
});
