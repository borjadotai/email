import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCLI } from "../src/cli.js";
import { MemorySecretStore } from "../src/secretStore.js";
import { MailStore } from "../src/store.js";

test("CLI initializes a local Carta profile and reports status", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-"));
  try {
    const env = testEnv(temp);
    const initOut = new CaptureStream();
    await runCLI([
      "init",
      "--name", "Alex Carter",
      "--email", "alex@example.com",
      "--history", "2-years",
      "--attachments", "false"
    ], { env, stdout: initOut, stderr: new CaptureStream(), stdin: fakeInput() });

    assert.match(initOut.text, /Carta email profile ready/u);
    assert.equal(countOccurrences(initOut.text, "Carta email profile ready."), 1);

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], { env, stdout: statusOut, stderr: new CaptureStream(), stdin: fakeInput() });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.initialized, true);
    assert.equal(status.profile.displayName, "Alex Carter");
    assert.equal(status.profile.primaryEmail, "alex@example.com");
    assert.equal(status.defaults.history, "2-years");
    assert.equal(status.defaults.attachments, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup initializes a profile without connecting accounts when requested", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-setup-"));
  try {
    const env = testEnv(temp);
    const setupOut = new CaptureStream();
    await runCLI([
      "setup",
      "--name", "Setup Tester",
      "--email", "setup@example.com",
      "--history", "6-months",
      "--attachments", "false",
      "--no-account"
    ], { env, stdout: setupOut, stderr: new CaptureStream(), stdin: fakeInput() });

    assert.match(setupOut.text, /Carta email profile ready/u);
    assert.equal(countOccurrences(setupOut.text, "Carta email profile ready."), 1);
    assert.match(setupOut.text, /Setup complete/u);
    assert.match(setupOut.text, /Client apps: http:\/\/127\.0\.0\.1:0/u);
    assert.match(setupOut.text, /Run in background: carta server install/u);
    assert.match(setupOut.text, /Check server: carta server status --check/u);

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], { env, stdout: statusOut, stderr: new CaptureStream(), stdin: fakeInput() });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.initialized, true);
    assert.equal(status.profile.displayName, "Setup Tester");
    assert.equal(status.accounts.length, 0);
    assert.equal(status.server.access.mode, "local");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup can prepare the background server install when requested", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-setup-server-"));
  try {
    const env = {
      ...testEnv(temp),
      HOME: temp
    };
    const out = new CaptureStream();
    await runCLI([
      "setup",
      "--name", "Server Tester",
      "--email", "server@example.com",
      "--history", "6-months",
      "--attachments", "false",
      "--expose", "local-only",
      "--no-account",
      "--install-server",
      "--dry-run",
      "--bin", "/opt/homebrew/bin/carta",
      "--uid", "123"
    ], {
      env,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      launchctl: async () => {
        throw new Error("launchctl should not be called in dry-run mode");
      }
    });

    assert.match(out.text, /LaunchAgent: com\.carta\.email\.cli\.server/u);
    assert.match(out.text, /Command: \/opt\/homebrew\/bin\/carta server start/u);
    assert.match(out.text, /Background server: install preview generated/u);
    assert.match(out.text, /Setup complete/u);
    assert.match(out.text, /Client apps: http:\/\/127\.0\.0\.1:0/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup can persist relay configuration for later commands", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-setup-relay-"));
  const secretStore = new MemorySecretStore();
  try {
    const env = testEnv(temp);
    await runCLI([
      "setup",
      "--name", "Relay Tester",
      "--email", "relay@example.com",
      "--history", "6-months",
      "--attachments", "true",
      "--relay-url", "https://relay.example.test/",
      "--relay-token", "relay-token",
      "--no-account"
    ], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], {
      env,
      stdout: statusOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.relay.configured, true);
    assert.equal(status.relay.baseURL, "https://relay.example.test");
    assert.equal(status.relay.source, "stored");
    assert.equal(status.relay.tokenConfigured, true);
    assert.equal(status.relay.tokenSource, "keychain");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI interactive first-run setup accepts typed answers and stored relay config", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-interactive-setup-"));
  const secretStore = new MemorySecretStore();
  try {
    const env = cartaEnv(temp);
    const stdin = fakeTTYInput([
      "Borja",
      "hi@borja.ai",
      "1",
      "y"
    ]);
    const out = new CaptureStream({ isTTY: true, onWrite: stdin.answerOnPrompt });
    let serveConfigured = false;
    await runCLI([
      "setup",
      "--relay-url", "https://relay.example.test",
      "--relay-token", "relay-token",
      "--expose", "tailscale",
      "--no-account",
      "--no-install-server"
    ], {
      env,
      stdout: out,
      stderr: new CaptureStream(),
      stdin,
      secretStore,
      detectTailscale: async () => ({
        installed: true,
        available: true,
        state: "Running",
        dnsName: "space.tailb90a7f.ts.net",
        ip: "100.102.74.1",
        ips: ["100.102.74.1"],
        serveURL: serveConfigured ? "https://space.tailb90a7f.ts.net:8443" : ""
      }),
      configureTailscaleServe: async ({ port, httpsPort, targetHost }) => {
        assert.equal(port, 7332);
        assert.equal(httpsPort, 8443);
        assert.equal(targetHost, "127.0.0.1");
        serveConfigured = true;
      }
    });

    assert.match(stripANSI(out.text), /Your name/u);
    assert.match(stripANSI(out.text), /Server access: Tailscale \(https:\/\/space\.tailb90a7f\.ts\.net:8443\)/u);
    assert.match(stripANSI(out.text), /Tailscale HTTPS proxy: https:\/\/space\.tailb90a7f\.ts\.net:8443 -> http:\/\/127\.0\.0\.1:7332/u);
    assert.match(stripANSI(out.text), /Carta relay configured: https:\/\/relay\.example\.test/u);
    assert.match(stripANSI(out.text), /Setup complete/u);

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], {
      env,
      stdout: statusOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.initialized, true);
    assert.equal(status.profile.displayName, "Borja");
    assert.equal(status.profile.primaryEmail, "hi@borja.ai");
    assert.equal(status.defaults.history, "last-week");
    assert.equal(status.server.access.mode, "tailscale");
    assert.equal(status.server.host, "127.0.0.1");
    assert.equal(status.server.baseURL, "https://space.tailb90a7f.ts.net:8443");
    assert.equal(status.relay.configured, true);
    assert.equal(status.relay.source, "stored");
    assert.equal(status.accounts.length, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup does not ask users to choose a relay", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-relay-default-"));
  try {
    const env = cartaEnv(temp);
    const stdin = fakeTTYInput([
      "Relay Hidden",
      "relay-hidden@example.com",
      "2",
      "y",
      "n"
    ]);
    const out = new CaptureStream({ isTTY: true, onWrite: stdin.answerOnPrompt });
    await runCLI([
      "setup",
      "--expose", "local-only",
      "--no-install-server"
    ], {
      env,
      stdout: out,
      stderr: new CaptureStream(),
      stdin
    });

    const text = stripANSI(out.text);
    assert.doesNotMatch(text, /Configure a Carta relay/u);
    assert.doesNotMatch(text, /Relay URL/u);
    assert.match(text, /Setup complete/u);

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], {
      env,
      stdout: statusOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.initialized, true);
    assert.equal(status.relay.configured, true);
    assert.equal(status.relay.baseURL, "https://carta-email-relay.vercel.app");
    assert.equal(status.relay.source, "bundled");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI relay command stores, reports, and clears relay configuration", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-relay-"));
  const secretStore = new MemorySecretStore();
  try {
    const env = testEnv(temp);
    const configureOut = new CaptureStream();
    await runCLI([
      "relay",
      "configure",
      "--url", "https://relay.example.test/",
      "--token", "relay-token",
      "--json"
    ], {
      env,
      stdout: configureOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const configured = JSON.parse(configureOut.text);
    assert.equal(configured.relay.configured, true);
    assert.equal(configured.relay.baseURL, "https://relay.example.test");
    assert.equal(configured.relay.tokenConfigured, true);

    const providersOut = new CaptureStream();
    await runCLI(["accounts", "providers", "--json"], {
      env,
      stdout: providersOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const providers = JSON.parse(providersOut.text);
    assert.equal(providers.providers[0].available, true);
    assert.equal(providers.providers[0].oauthMode, "relay");
    assert.equal(providers.providers[0].relaySource, "stored");
    assert.equal(providers.providers[0].relayTokenSource, "keychain");

    const clearOut = new CaptureStream();
    await runCLI(["relay", "clear", "--json"], {
      env,
      stdout: clearOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const cleared = JSON.parse(clearOut.text);
    assert.equal(cleared.relay.configured, false);
    assert.equal(cleared.relay.tokenConfigured, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI reset clears local mail state and account secrets while preserving relay by default", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-reset-"));
  const secretStore = new MemorySecretStore();
  try {
    const env = testEnv(temp);
    await runCLI([
      "setup",
      "--name", "Reset Tester",
      "--email", "reset@example.com",
      "--relay-url", "https://relay.example.test",
      "--relay-token", "relay-token",
      "--no-account"
    ], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    await runCLI(["fixtures", "seed"], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });

    const beforeOut = new CaptureStream();
    await runCLI(["status", "--json"], {
      env,
      stdout: beforeOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const before = JSON.parse(beforeOut.text);
    assert.equal(before.initialized, true);
    assert.equal(before.accounts.length, 2);
    secretStore.set(`account:${before.accounts[0].id}:gmail.refresh_token`, "gmail-refresh-token");
    secretStore.set(`account:${before.accounts[1].id}:icloud.app_password`, "icloud-password");

    const resetOut = new CaptureStream();
    await runCLI(["reset", "--yes", "--json"], {
      env,
      stdout: resetOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const reset = JSON.parse(resetOut.text);
    assert.equal(reset.reset.accountsRemoved, 2);
    assert.equal(reset.reset.accountSecretsRemoved, 8);
    assert.equal(reset.reset.relay, "preserved");
    assert.equal(secretStore.get(`account:${before.accounts[0].id}:gmail.refresh_token`), null);
    assert.equal(secretStore.get(`account:${before.accounts[1].id}:icloud.app_password`), null);

    const afterOut = new CaptureStream();
    await runCLI(["status", "--json"], {
      env,
      stdout: afterOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const after = JSON.parse(afterOut.text);
    assert.equal(after.initialized, false);
    assert.equal(after.accounts.length, 0);
    assert.equal(after.profile.displayName, "Local Profile");
    assert.equal(after.profile.primaryEmail, null);
    assert.equal(after.relay.configured, true);
    assert.equal(after.relay.baseURL, "https://relay.example.test");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI reset requires confirmation and falls back to the bundled relay after clearing stored relay configuration", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-reset-confirm-"));
  const secretStore = new MemorySecretStore();
  try {
    const env = testEnv(temp);
    await runCLI([
      "relay",
      "configure",
      "--url", "https://relay.example.test",
      "--token", "relay-token"
    ], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });

    await assert.rejects(
      runCLI(["reset"], {
        env,
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdin: fakeInput(),
        secretStore
      }),
      /--yes/u
    );

    await runCLI(["reset", "--yes", "--all"], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], {
      env,
      stdout: statusOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore
    });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.relay.configured, true);
    assert.equal(status.relay.baseURL, "https://carta-email-relay.vercel.app");
    assert.equal(status.relay.source, "bundled");
    assert.equal(status.relay.tokenConfigured, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup local-only clears a previous public server URL", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-local-reset-"));
  try {
    const env = cartaEnv(temp);
    await runCLI([
      "setup",
      "--name", "Access Tester",
      "--email", "access@example.com",
      "--expose", "tailscale",
      "--no-tailscale-serve",
      "--no-account"
    ], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      detectTailscale: async () => ({
        installed: true,
        available: true,
        state: "Running",
        dnsName: "space.tailb90a7f.ts.net",
        ip: "100.64.0.42",
        ips: ["100.64.0.42"]
      })
    });

    await runCLI([
      "setup",
      "--name", "Access Tester",
      "--email", "access@example.com",
      "--expose", "local-only",
      "--no-account"
    ], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });

    const out = new CaptureStream();
    await runCLI(["connection", "--json"], {
      env,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const result = JSON.parse(out.text);
    assert.equal(result.server.baseURL, "http://127.0.0.1:7332");
    assert.equal(result.server.access.mode, "local");
    assert.equal(result.server.access.publicBaseURL, "");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup requires explicit consent for open-port server access", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-open-port-"));
  try {
    const env = cartaEnv(temp);
    await assert.rejects(
      runCLI([
        "setup",
        "--name", "Open Port Tester",
        "--email", "open@example.com",
        "--expose", "open-port",
        "--public-url", "http://public.example.test:7332",
        "--no-account"
      ], {
        env,
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdin: fakeInput()
      }),
      /allow-insecure-open-port/u
    );

    const setupOut = new CaptureStream();
    await runCLI([
      "setup",
      "--name", "Open Port Tester",
      "--email", "open@example.com",
      "--expose", "open-port",
      "--public-url", "http://public.example.test:7332",
      "--allow-insecure-open-port",
      "--no-account"
    ], {
      env,
      stdout: setupOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    assert.match(setupOut.text, /Warning: open-port mode exposes/u);

    const connectionOut = new CaptureStream();
    await runCLI(["connection", "--json"], {
      env,
      stdout: connectionOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const connection = JSON.parse(connectionOut.text);
    assert.equal(connection.server.baseURL, "http://public.example.test:7332");
    assert.equal(connection.server.access.mode, "open-port");
    assert.match(connection.security.warning, /no extra Carta API authentication/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup can persist Tailscale server access", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-tailscale-"));
  try {
    const env = cartaEnv(temp);
    const setupOut = new CaptureStream();
    let serveConfigured = false;
    await runCLI([
      "setup",
      "--name", "Tailnet Tester",
      "--email", "tailnet@example.com",
      "--history", "6-months",
      "--attachments", "false",
      "--expose", "tailscale",
      "--no-account"
    ], {
      env,
      stdout: setupOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      detectTailscale: async () => ({
        installed: true,
        available: true,
        state: "Running",
        dnsName: "space.tailb90a7f.ts.net",
        ip: "100.64.0.42",
        ips: ["100.64.0.42"],
        serveURL: serveConfigured ? "https://space.tailb90a7f.ts.net:8443" : ""
      }),
      configureTailscaleServe: async ({ port, httpsPort, targetHost }) => {
        assert.equal(port, 7332);
        assert.equal(httpsPort, 8443);
        assert.equal(targetHost, "127.0.0.1");
        serveConfigured = true;
      }
    });

    assert.match(setupOut.text, /Server access: Tailscale/u);

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], { env, stdout: statusOut, stderr: new CaptureStream(), stdin: fakeInput() });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.server.host, "127.0.0.1");
    assert.equal(status.server.port, 7332);
    assert.equal(status.server.publicBaseURL, "https://space.tailb90a7f.ts.net:8443");
    assert.equal(status.server.access.mode, "tailscale");
    assert.equal(status.server.access.tailscaleDNSName, "space.tailb90a7f.ts.net");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup refuses explicit Tailscale exposure when Tailscale is not ready", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-tailscale-missing-"));
  try {
    await assert.rejects(
      runCLI([
        "setup",
        "--name", "Tailnet Tester",
        "--email", "tailnet@example.com",
        "--expose", "tailscale",
        "--no-account"
      ], {
        env: cartaEnv(temp),
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdin: fakeInput(),
        detectTailscale: async () => ({
          installed: false,
          available: false,
          state: "not-installed"
        })
      }),
      /Tailscale is not ready/u
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup prefers an existing Tailscale Serve URL for the selected port", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-tailscale-serve-"));
  try {
    const env = cartaEnv(temp);
    await runCLI([
      "setup",
      "--name", "Tailnet Serve Tester",
      "--email", "tailnet-serve@example.com",
      "--expose", "tailscale",
      "--no-account"
    ], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      detectTailscale: async () => ({
        installed: true,
        available: true,
        state: "Running",
        dnsName: "space.tailb90a7f.ts.net",
        ip: "100.64.0.42",
        serveURL: "https://space.tailb90a7f.ts.net:8443"
      })
    });

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], { env, stdout: statusOut, stderr: new CaptureStream(), stdin: fakeInput() });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.server.host, "127.0.0.1");
    assert.equal(status.server.publicBaseURL, "https://space.tailb90a7f.ts.net:8443");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI setup server port persists over the wrapper default port", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-port-"));
  try {
    const env = cartaWrapperEnv(temp);
    await runCLI([
      "setup",
      "--name", "Port Tester",
      "--email", "port@example.com",
      "--expose", "local-only",
      "--server-port", "7444",
      "--no-account"
    ], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], { env, stdout: statusOut, stderr: new CaptureStream(), stdin: fakeInput() });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.server.host, "127.0.0.1");
    assert.equal(status.server.port, 7444);
    assert.equal(status.server.baseURL, "http://127.0.0.1:7444");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI prints client connection details and optional health status", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-connection-"));
  try {
    const env = cartaWrapperEnv(temp);
    await runCLI([
      "setup",
      "--name", "Connection Tester",
      "--email", "connection@example.com",
      "--expose", "local-only",
      "--server-port", "7444",
      "--no-account"
    ], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });

    const out = new CaptureStream();
    await runCLI(["connection", "--check", "--json"], {
      env,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const result = JSON.parse(out.text);
    assert.equal(result.server.baseURL, "http://127.0.0.1:7444");
    assert.equal(result.server.healthURL, "http://127.0.0.1:7444/api/health");
    assert.equal(result.command, "carta server start");
    assert.equal(result.backgroundCommand, "carta server install");
    assert.equal(result.statusCommand, "carta server status --check");
    assert.equal(result.health.ok, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI renders a separate LaunchAgent for the background server", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-launch-agent-"));
  try {
    const out = new CaptureStream();
    await runCLI([
      "server",
      "install",
      "--dry-run",
      "--json",
      "--bin", "/opt/homebrew/bin/carta",
      "--uid", "123"
    ], {
      env: {
        CARTA_DATA_DIR: join(temp, "data"),
        CARTA_SERVER_PORT: "7332",
        HOME: temp,
        CARTA_RELAY_BASE_URL: "https://relay.example.test",
        CARTA_RELAY_TOKEN: "relay-token",
        CARTA_GOOGLE_OAUTH_CLIENT_SECRET: "test-secret"
      },
      cwd: temp,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      launchctl: async () => {
        throw new Error("launchctl should not be called in dry-run mode");
      }
    });
    const result = JSON.parse(out.text);
    assert.equal(result.launchAgent.label, "com.carta.email.cli.server");
    assert.equal(result.launchAgent.domain, "gui/123");
    assert.equal(result.launchAgent.plistPath, join(temp, "Library", "LaunchAgents", "com.carta.email.cli.server.plist"));
    assert.equal(result.launchAgent.logDir, join(temp, "Library", "Logs", "CartaCLI"));
    assert.deepEqual(result.launchAgent.programArguments, ["/opt/homebrew/bin/carta", "server", "start"]);
    assert.equal(result.launchAgent.environmentVariables.CARTA_CLI, "1");
    assert.equal(result.launchAgent.environmentVariables.CARTA_USE_STORED_SERVER_ACCESS, "1");
    assert.equal(result.launchAgent.environmentVariables.CARTA_DATA_DIR, join(temp, "data"));
    assert.equal(result.launchAgent.environmentVariables.EMAIL_AUTO_SYNC, "1");
    assert.equal(result.launchAgent.environmentVariables.CARTA_RELAY_BASE_URL, "https://relay.example.test");
    assert.equal(result.launchAgent.environmentVariables.CARTA_RELAY_TOKEN, "relay-token");
    assert.match(result.launchAgent.plist, /com\.carta\.email\.cli\.server/u);
    assert.match(result.launchAgent.plist, /<key>CARTA_USE_STORED_SERVER_ACCESS<\/key>\n    <string>1<\/string>/u);
    assert.doesNotMatch(result.launchAgent.plist, /<key>\s*<key>/u);
    assert.doesNotMatch(result.launchAgent.plist, /EmailApp|com\.borjadotai\.email\.server/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI renders a systemd service for Linux background server", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-systemd-"));
  try {
    const out = new CaptureStream();
    await runCLI([
      "server",
      "install",
      "--dry-run",
      "--json",
      "--bin", "/usr/local/bin/carta",
      "--user"
    ], {
      platform: "linux",
      env: {
        CARTA_DATA_DIR: join(temp, "data"),
        CARTA_SERVER_PORT: "7332",
        HOME: temp,
        CARTA_RELAY_BASE_URL: "https://relay.example.test",
        CARTA_RELAY_TOKEN: "relay-token"
      },
      cwd: temp,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      systemctl: async () => {
        throw new Error("systemctl should not be called in dry-run mode");
      }
    });
    const result = JSON.parse(out.text);
    assert.equal(result.systemd.name, "carta-email-cli.service");
    assert.equal(result.systemd.scope, "user");
    assert.equal(result.systemd.unitPath, join(temp, ".config", "systemd", "user", "carta-email-cli.service"));
    assert.deepEqual(result.systemd.programArguments, ["/usr/local/bin/carta", "server", "start"]);
    assert.equal(result.systemd.environmentVariables.CARTA_CLI, "1");
    assert.equal(result.systemd.environmentVariables.CARTA_USE_STORED_SERVER_ACCESS, "1");
    assert.equal(result.systemd.environmentVariables.CARTA_DATA_DIR, join(temp, "data"));
    assert.equal(result.systemd.environmentVariables.CARTA_SECRETS_PATH, join(temp, "data", "secrets.json"));
    assert.equal(result.systemd.environmentVariables.CARTA_RELAY_BASE_URL, "https://relay.example.test");
    assert.equal(result.systemd.environmentVariables.CARTA_RELAY_TOKEN, "relay-token");
    assert.match(result.systemd.unit, /Description=Carta Email CLI Server/u);
    assert.match(result.systemd.unit, /ExecStart="\/usr\/local\/bin\/carta" "server" "start"/u);
    assert.match(result.systemd.unit, /WantedBy=default\.target/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI accepts shallow history windows for test backfills", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-shallow-history-"));
  try {
    const env = testEnv(temp);
    await runCLI([
      "init",
      "--name", "Shallow Tester",
      "--email", "shallow@example.com",
      "--history", "last-week",
      "--attachments", "false"
    ], { env, stdout: new CaptureStream(), stderr: new CaptureStream(), stdin: fakeInput() });

    const statusOut = new CaptureStream();
    await runCLI(["status", "--json"], { env, stdout: statusOut, stderr: new CaptureStream(), stdin: fakeInput() });
    assert.equal(JSON.parse(statusOut.text).defaults.history, "last-week");

    await runCLI([
      "init",
      "--name", "Shallow Tester",
      "--email", "shallow@example.com",
      "--history", "last-month",
      "--attachments", "false"
    ], { env, stdout: new CaptureStream(), stderr: new CaptureStream(), stdin: fakeInput() });

    const monthOut = new CaptureStream();
    await runCLI(["status", "--json"], { env, stdout: monthOut, stderr: new CaptureStream(), stdin: fakeInput() });
    assert.equal(JSON.parse(monthOut.text).defaults.history, "last-month");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI server install tolerates a transient launchctl kickstart failure", {
  skip: process.platform !== "darwin"
}, async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-launch-kickstart-"));
  try {
    const out = new CaptureStream();
    const calls = [];
    await runCLI([
      "server",
      "install",
      "--json",
      "--bin", "/opt/homebrew/bin/carta",
      "--uid", "123"
    ], {
      env: {
        ...testEnv(temp),
        HOME: temp
      },
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      launchctl: async args => {
        calls.push(args);
        if (args[0] === "bootout") {
          throw new Error("not loaded");
        }
        if (args[0] === "kickstart") {
          const error = new Error("Command failed: launchctl kickstart");
          error.stderr = "service already started";
          throw error;
        }
        if (args[0] === "print") {
          return { stdout: "state = running\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }
    });

    const result = JSON.parse(out.text);
    assert.equal(result.launchAgent.loaded, true);
    assert.equal(result.launchAgent.status, "loaded");
    assert.match(result.launchAgent.launchctlNotes.join("\n"), /kickstart reported service already started/u);
    assert.deepEqual(calls.map(args => args[0]), ["bootout", "bootstrap", "kickstart", "print", "print"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI searches the local mail index", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-search-"));
  try {
    const env = testEnv(temp);
    seedSearchEmail(env.EMAIL_DATABASE_PATH);

    const out = new CaptureStream();
    await runCLI(["search", "quarterly", "--json"], {
      env,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const result = JSON.parse(out.text);
    assert.equal(result.emails.length, 1);
    assert.equal(result.emails[0].subject, "Quarterly roadmap");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI lists mailbox emails and reports sync status", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-list-"));
  try {
    const env = testEnv(temp);
    const { account } = seedSearchEmail(env.EMAIL_DATABASE_PATH);
    const store = new MailStore({ databasePath: env.EMAIL_DATABASE_PATH });
    try {
      store.updateAccountMetadata(account.id, {
        cartaSyncStatus: {
          status: "running",
          imported: 12,
          oldestReceivedAt: "2026-05-01T12:00:00.000Z"
        }
      });
    } finally {
      store.close();
    }

    const listOut = new CaptureStream();
    await runCLI(["list", "--unread", "--json"], {
      env,
      stdout: listOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const list = JSON.parse(listOut.text);
    assert.equal(list.emails.length, 1);
    assert.equal(list.emails[0].mailboxRole, "inbox");

    const statusOut = new CaptureStream();
    await runCLI(["sync", "status", "--json"], {
      env,
      stdout: statusOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const status = JSON.parse(statusOut.text);
    assert.equal(status.accounts.length, 1);
    assert.equal(status.accounts[0].syncStatus.status, "running");
    assert.equal(status.accounts[0].syncStatus.imported, 12);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI seeds agent fixtures and supports realistic filtered queries", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-fixtures-"));
  try {
    const env = testEnv(temp);
    const seedOut = new CaptureStream();
    await runCLI(["fixtures", "seed", "--json"], {
      env,
      stdout: seedOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const seeded = JSON.parse(seedOut.text);
    assert.equal(seeded.accounts.length, 2);
    assert.equal(seeded.emails.length, 8);

    const taylorOut = new CaptureStream();
    await runCLI(["search", "--from", "Taylor", "--since", "7d", "--json"], {
      env,
      stdout: taylorOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const taylor = JSON.parse(taylorOut.text);
    assert.deepEqual(taylor.emails.map(email => email.id), ["fixture-gmail-taylor-roadmap"]);

    const newsletterOut = new CaptureStream();
    await runCLI(["search", "newsletter", "--limit", "10", "--json"], {
      env,
      stdout: newsletterOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const newsletters = JSON.parse(newsletterOut.text);
    assert.deepEqual(newsletters.emails.map(email => email.id), [
      "fixture-gmail-product-newsletter",
      "fixture-icloud-ai-newsletter"
    ]);

    const invoiceOut = new CaptureStream();
    await runCLI(["search", "invoice", "--has-attachments", "--attachment-kind", "invoice", "--json"], {
      env,
      stdout: invoiceOut,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const invoices = JSON.parse(invoiceOut.text);
    assert.deepEqual(invoices.emails.map(email => email.id), [
      "fixture-gmail-stripe-invoice",
      "fixture-icloud-cloud-bill"
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI email actions update local state and report provider status", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-action-"));
  try {
    const env = testEnv(temp);
    seedSearchEmail(env.EMAIL_DATABASE_PATH);

    const out = new CaptureStream();
    await runCLI(["archive", "cli-search-email", "--json"], {
      env,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore: new MemorySecretStore()
    });
    const result = JSON.parse(out.text);
    assert.equal(result.action, "archive");
    assert.equal(result.email.mailboxRole, "archive");
    assert.equal(result.provider.status, "failed");

    const store = new MailStore({ databasePath: env.EMAIL_DATABASE_PATH });
    try {
      assert.equal(store.getEmail("cli-search-email").mailboxRole, "archive");
    } finally {
      store.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI non-interactive account onboarding fails instead of waiting for input", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-noninteractive-"));
  try {
    await assert.rejects(
      runCLI(["accounts", "add", "imap"], {
        env: testEnv(temp),
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdin: fakeInput()
      }),
      /email is required/u
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI Gmail onboarding explains missing relay or local OAuth", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-gmail-oauth-"));
  try {
    await assert.rejects(
      runCLI(["accounts", "add", "gmail"], {
        env: {
          EMAIL_DATA_DIR: temp,
          EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
          EMAIL_SERVER_HOST: "127.0.0.1",
          EMAIL_SERVER_PORT: "0",
          EMAIL_PUBLIC_BASE_URL: "",
          CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH: "1",
          CARTA_DISABLE_BUNDLED_RELAY: "1"
        },
        cwd: temp,
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdin: fakeInput(),
        openBrowser: async () => {}
      }),
      /Set CARTA_RELAY_BASE_URL/u
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI reports provider availability for onboarding", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-providers-"));
  try {
    const out = new CaptureStream();
    await runCLI(["accounts", "providers", "--json"], {
      env: {
        EMAIL_DATA_DIR: temp,
        EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
        EMAIL_SERVER_HOST: "127.0.0.1",
        EMAIL_SERVER_PORT: "0",
        EMAIL_PUBLIC_BASE_URL: "",
        CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH: "1",
        CARTA_DISABLE_BUNDLED_RELAY: "1"
      },
      cwd: temp,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const result = JSON.parse(out.text);
    assert.deepEqual(result.providers.map(provider => provider.id), ["gmail", "icloud", "imap"]);
    assert.equal(result.providers[0].available, false);
    assert.equal(result.providers[0].reason, "missing Carta relay URL or Google OAuth Desktop credentials");
    assert.equal(result.providers[1].available, true);
    assert.equal(result.providers[2].available, true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI reports Gmail provider availability when OAuth is configured", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-providers-gmail-"));
  try {
    const out = new CaptureStream();
    await runCLI(["accounts", "providers", "--json"], {
      env: {
        EMAIL_DATA_DIR: temp,
        EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
        EMAIL_SERVER_HOST: "127.0.0.1",
        EMAIL_SERVER_PORT: "0",
        EMAIL_PUBLIC_BASE_URL: "",
        CARTA_DISABLE_BUNDLED_RELAY: "1",
        CARTA_GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
        CARTA_GOOGLE_OAUTH_CLIENT_SECRET: "test-secret"
      },
      cwd: temp,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const result = JSON.parse(out.text);
    assert.equal(result.providers[0].id, "gmail");
    assert.equal(result.providers[0].available, true);
    assert.equal(result.providers[0].oauthMode, "desktop");
    assert.equal(result.providers[0].oauthSource, "CARTA_GOOGLE_OAUTH_CLIENT_ID");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI reports Gmail provider availability through the Carta relay", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-providers-gmail-relay-"));
  try {
    const out = new CaptureStream();
    await runCLI(["accounts", "providers", "--json"], {
      env: {
        EMAIL_DATA_DIR: temp,
        EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
        EMAIL_SERVER_HOST: "127.0.0.1",
        EMAIL_SERVER_PORT: "0",
        EMAIL_PUBLIC_BASE_URL: "",
        CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH: "1",
        CARTA_RELAY_BASE_URL: "https://relay.example.test",
        CARTA_RELAY_TOKEN: "relay-token"
      },
      cwd: temp,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const result = JSON.parse(out.text);
    assert.equal(result.providers[0].id, "gmail");
    assert.equal(result.providers[0].available, true);
    assert.equal(result.providers[0].oauthMode, "relay");
    assert.equal(result.providers[0].relayConfigured, true);
    assert.equal(result.providers[0].relaySource, "CARTA_RELAY_BASE_URL");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI explains when Gmail has a Desktop client ID but no matching secret", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-providers-gmail-secret-"));
  try {
    const out = new CaptureStream();
    await runCLI(["accounts", "providers", "--json"], {
      env: {
        EMAIL_DATA_DIR: temp,
        EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
        EMAIL_SERVER_HOST: "127.0.0.1",
        EMAIL_SERVER_PORT: "0",
        EMAIL_PUBLIC_BASE_URL: "",
        CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH: "1",
        CARTA_DISABLE_BUNDLED_RELAY: "1",
        CARTA_GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com"
      },
      cwd: temp,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });
    const result = JSON.parse(out.text);
    assert.equal(result.providers[0].id, "gmail");
    assert.equal(result.providers[0].available, false);
    assert.equal(result.providers[0].reason, "missing matching Google OAuth Desktop client secret");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI skips ambient .env files unless explicitly requested", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-dotenv-"));
  try {
    writeFileSync(join(temp, ".env"), [
      "EMAIL_SERVER_PORT=9999",
      "GOOGLE_OAUTH_CLIENT_ID=dotenv-client-id.apps.googleusercontent.com",
      "GOOGLE_OAUTH_CLIENT_SECRET=dotenv-secret"
    ].join("\n"));

    const skippedOut = new CaptureStream();
    await runCLI(["doctor", "--json"], {
      env: {
        CARTA_DATA_DIR: temp,
        CARTA_SERVER_PORT: "7332",
        CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH: "1",
        CARTA_DISABLE_BUNDLED_RELAY: "1"
      },
      cwd: temp,
      stdout: skippedOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      detectTailscale: async () => ({ installed: false, available: false })
    });
    const skipped = JSON.parse(skippedOut.text);
    assert.equal(skipped.checks.server, "http://127.0.0.1:7332");
    assert.equal(skipped.checks.gmailOAuth, "missing Carta relay URL or Google OAuth Desktop credentials");

    const loadedOut = new CaptureStream();
    await runCLI(["doctor", "--json"], {
      env: {
        CARTA_DATA_DIR: temp,
        CARTA_LOAD_DOTENV: "1",
        CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH: "1",
        CARTA_DISABLE_BUNDLED_RELAY: "1"
      },
      cwd: temp,
      stdout: loadedOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      detectTailscale: async () => ({ installed: false, available: false })
    });
    const loaded = JSON.parse(loadedOut.text);
    assert.equal(loaded.checks.server, "http://127.0.0.1:9999");
    assert.equal(loaded.checks.gmailOAuth, "configured (desktop via GOOGLE_OAUTH_CLIENT_ID)");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI sends a local outbound message and reports provider failure", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-send-"));
  try {
    const env = testEnv(temp);
    seedSearchEmail(env.EMAIL_DATABASE_PATH, { provider: "imap" });

    const out = new CaptureStream();
    await runCLI([
      "send",
      "--to", "friend@example.com",
      "--subject", "Hello from Carta",
      "--body", "Testing the CLI send path.",
      "--json"
    ], {
      env,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore: new MemorySecretStore()
    });
    const result = JSON.parse(out.text);
    assert.equal(result.email.mailboxRole, "sent");
    assert.deepEqual(result.email.recipients, ["friend@example.com"]);
    assert.equal(result.provider.status, "failed");
    assert.match(result.provider.error, /IMAP password/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI sends attachments, replies, and forwards fixture emails", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-compose-"));
  try {
    const env = testEnv(temp);
    await runCLI(["fixtures", "seed"], {
      env,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      stdin: fakeInput()
    });

    const attachmentPath = join(temp, "brief.txt");
    writeFileSync(attachmentPath, "Attachment from the CLI.");

    const sendOut = new CaptureStream();
    await runCLI([
      "send",
      "--account", "alex.fixture@gmail.test",
      "--to", "pat@example.test",
      "--subject", "Proposal follow-up",
      "--body", "Please see attached.",
      "--attach", attachmentPath,
      "--json"
    ], {
      env,
      stdout: sendOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore: new MemorySecretStore()
    });
    const sent = JSON.parse(sendOut.text);
    assert.equal(sent.email.mailboxRole, "sent");
    assert.equal(sent.email.hasAttachments, true);
    assert.equal(sent.email.attachments[0].filename, "brief.txt");
    assert.equal(sent.email.attachments[0].isDownloaded, true);
    assert.deepEqual(sent.email.recipients, ["pat@example.test"]);
    assert.equal(sent.provider.status, "failed");

    const replyOut = new CaptureStream();
    await runCLI([
      "reply",
      "fixture-gmail-taylor-roadmap",
      "--body", "Okay, got it.",
      "--json"
    ], {
      env,
      stdout: replyOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore: new MemorySecretStore()
    });
    const reply = JSON.parse(replyOut.text);
    assert.equal(reply.email.mailboxRole, "sent");
    assert.equal(reply.email.subject, "Re: Roadmap notes from Taylor");
    assert.deepEqual(reply.email.recipients, ["taylor@northstar.test"]);
    assert.equal(reply.email.bodyText, "Okay, got it.");

    const forwardOut = new CaptureStream();
    await runCLI([
      "forward",
      "fixture-gmail-stripe-invoice",
      "--to", "finance@example.test",
      "--body", "Please process this invoice.",
      "--include-attachments",
      "--json"
    ], {
      env,
      stdout: forwardOut,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      secretStore: new MemorySecretStore()
    });
    const forwarded = JSON.parse(forwardOut.text);
    assert.equal(forwarded.email.mailboxRole, "sent");
    assert.equal(forwarded.email.subject, "Fwd: Invoice INV-2026-1042 for Carta Email");
    assert.deepEqual(forwarded.email.recipients, ["finance@example.test"]);
    assert.match(forwarded.email.bodyText, /Forwarded message/u);
    assert.equal(forwarded.email.attachments[0].filename, "invoice_INV-2026-1042.pdf");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI prints useful doctor output", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-doctor-"));
  try {
    const out = new CaptureStream();
    await runCLI(["doctor"], {
      env: {
        ...testEnv(temp),
        CARTA_GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
        CARTA_GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
        CARTA_DISABLE_BUNDLED_RELAY: "1"
      },
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      detectTailscale: async () => ({
        installed: true,
        available: true,
        state: "Running",
        dnsName: "space.tailb90a7f.ts.net",
        ip: "100.64.0.42"
      })
    });
    assert.match(out.text, /Node:/u);
    assert.match(out.text, /Database:/u);
    assert.match(out.text, /Server access:/u);
    assert.match(out.text, /Tailscale: available/u);
    assert.match(out.text, /Relay: not configured/u);
    assert.match(out.text, /Gmail OAuth: configured \(desktop via CARTA_GOOGLE_OAUTH_CLIENT_ID\)/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI doctor gives an action when Gmail OAuth is missing", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-doctor-oauth-"));
  try {
    const out = new CaptureStream();
    await runCLI(["doctor", "--json"], {
      env: {
        EMAIL_DATA_DIR: temp,
        EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
        EMAIL_SERVER_HOST: "127.0.0.1",
        EMAIL_SERVER_PORT: "0",
        EMAIL_PUBLIC_BASE_URL: "",
        CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH: "1",
        CARTA_DISABLE_BUNDLED_RELAY: "1"
      },
      cwd: temp,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      detectTailscale: async () => ({
        installed: false,
        available: false,
        state: "not-installed"
      })
    });
    const result = JSON.parse(out.text);
    assert.equal(result.checks.gmailOAuth, "missing Carta relay URL or Google OAuth Desktop credentials");
    assert.match(result.checks.gmailOAuthAction, /CARTA_RELAY_BASE_URL/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI doctor reports relay-backed Gmail OAuth", async () => {
  const temp = mkdtempSync(join(tmpdir(), "carta-cli-doctor-relay-"));
  try {
    const out = new CaptureStream();
    await runCLI(["doctor", "--json"], {
      env: {
        EMAIL_DATA_DIR: temp,
        EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
        EMAIL_SERVER_HOST: "127.0.0.1",
        EMAIL_SERVER_PORT: "0",
        EMAIL_PUBLIC_BASE_URL: "",
        CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH: "1",
        CARTA_RELAY_BASE_URL: "https://relay.example.test",
        CARTA_RELAY_TOKEN: "relay-token"
      },
      cwd: temp,
      stdout: out,
      stderr: new CaptureStream(),
      stdin: fakeInput(),
      detectTailscale: async () => ({
        installed: false,
        available: false,
        state: "not-installed"
      })
    });
    const result = JSON.parse(out.text);
    assert.equal(result.checks.relay, "configured (CARTA_RELAY_BASE_URL)");
    assert.equal(result.checks.gmailOAuth, "configured (relay via CARTA_RELAY_BASE_URL)");
    assert.equal(result.checks.gmailOAuthAction, "ready");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function seedSearchEmail(databasePath, { provider = "gmail" } = {}) {
  const store = new MailStore({ databasePath });
  try {
    const account = store.createAccount({
      provider,
      email: "alex@example.com",
      displayName: "Alex Carter"
    });
    const inbox = store.mailboxForRole(account.id, "inbox");
    store.upsertProviderEmail({
      id: "cli-search-email",
      accountId: account.id,
      mailboxId: inbox.id,
      providerUID: "provider-cli-search-email",
      threadId: "thread-cli-search",
      senderName: "Roadmap Team",
      senderEmail: "roadmap@example.com",
      recipients: [account.email],
      cc: [],
      bcc: [],
      subject: "Quarterly roadmap",
      snippet: "Planning notes for the next quarter",
      bodyText: "The quarterly roadmap has launch milestones and customer interviews.",
      bodyHTML: null,
      sentAt: "2026-05-01T12:00:00.000Z",
      receivedAt: "2026-05-01T12:00:00.000Z",
      isRead: false,
      isStarred: false,
      importance: "normal",
      hasAttachments: false,
      trackingId: null,
      openedAt: null,
      createdAt: "2026-05-01T12:00:00.000Z",
      attachments: []
    });
    return { account };
  } finally {
    store.close();
  }
}

function testEnv(temp) {
  return {
    EMAIL_DATA_DIR: temp,
    EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
    EMAIL_AUTO_HISTORY_BACKFILL: "0",
    EMAIL_AUTO_SYNC: "0",
    EMAIL_SERVER_HOST: "127.0.0.1",
    EMAIL_SERVER_PORT: "0"
  };
}

function cartaEnv(temp) {
  return {
    CARTA_DATA_DIR: temp,
    CARTA_SERVER_PORT: "7332",
    EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
    EMAIL_AUTO_HISTORY_BACKFILL: "0",
    EMAIL_AUTO_SYNC: "0"
  };
}

function cartaWrapperEnv(temp) {
  return {
    ...cartaEnv(temp),
    CARTA_SERVER_PORT_DEFAULT: "1"
  };
}

function fakeInput() {
  return {
    isTTY: false,
    on() {},
    once() {},
    removeListener() {},
    pause() {},
    resume() {}
  };
}

function fakeTTYInput(lines) {
  const input = new PassThrough();
  input.isTTY = true;
  const answers = [...lines];
  let buffer = "";
  input.answerOnPrompt = chunk => {
    buffer += String(chunk);
    if (answers.length === 0) return;
    if (/(?:Choose \[[^\]]+\]: |: |\[[Yy]\/[Nn]\]: |\[[Yy]\/n\]: |y\/N\]: )$/u.test(buffer)) {
      input.write(`${answers.shift()}\n`);
      buffer = "";
    }
  };
  return input;
}

function stripANSI(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function countOccurrences(value, needle) {
  return String(value).split(needle).length - 1;
}

class CaptureStream {
  constructor({ isTTY = false, onWrite = null } = {}) {
    this.text = "";
    this.isTTY = isTTY;
    this.onWrite = onWrite;
  }

  write(chunk) {
    this.text += String(chunk);
    this.onWrite?.(chunk);
    return true;
  }

  on() {
    return this;
  }

  once() {
    return this;
  }

  removeListener() {
    return this;
  }
}
