#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cartaBin = join(rootDir, "bin", "carta.js");
const relayURL = normalizeURL(process.env.CARTA_RELAY_BASE_URL || "https://carta-email-relay.vercel.app");
const explicitPort = process.env.CARTA_SMOKE_PORT;
const port = explicitPort
  ? Number.parseInt(explicitPort, 10)
  : await availablePort();

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("CARTA_SMOKE_PORT must be a TCP port number.");
}

if (explicitPort) {
  await assertPortAvailable(port);
}

const relayToken = process.env.CARTA_RELAY_TOKEN || readStoredRelayToken(relayURL);

const temp = mkdtempSync(join(tmpdir(), "carta-relay-e2e-"));
const keepTemp = process.env.CARTA_SMOKE_KEEP === "1";
const env = {
  ...process.env,
  CARTA_DATA_DIR: temp,
  EMAIL_DATABASE_PATH: join(temp, "mail.sqlite"),
  CARTA_SERVER_HOST: "127.0.0.1",
  CARTA_SERVER_PORT: String(port),
  CARTA_PUBLIC_BASE_URL: "",
  CARTA_RELAY_BASE_URL: relayURL,
  ...(relayToken ? { CARTA_RELAY_TOKEN: relayToken } : {}),
  EMAIL_PUBLIC_BASE_URL: "",
  NO_COLOR: process.env.NO_COLOR ?? "1"
};

try {
  await runCarta([
    "setup",
    "--name", "Relay E2E User",
    "--email", "relay-e2e@example.test",
    "--history", "6-months",
    "--attachments", "true",
    "--expose", "local-only",
    "--no-account",
    "--no-install-server"
  ]);

  const providers = JSON.parse((await runCarta(["accounts", "providers", "--json"])).stdout);
  const connection = JSON.parse((await runCarta(["connection", "--json"])).stdout);
  const doctor = JSON.parse((await runCarta(["doctor", "--json"])).stdout);
  const statusBeforeAuth = JSON.parse((await runCarta(["status", "--json"])).stdout);
  const gmail = await smokeGmailRelayStartAndCallback();
  const statusAfterAuth = JSON.parse((await runCarta(["status", "--json"])).stdout);

  const gmailProvider = providers.providers.find(provider => provider.id === "gmail");
  const result = {
    ok: true,
    isolatedDatabase: statusBeforeAuth.databasePath.startsWith(temp),
    initialized: statusBeforeAuth.initialized,
    relayConfigured: statusBeforeAuth.relay.configured,
    relaySource: statusBeforeAuth.relay.source,
    relayTokenSource: statusBeforeAuth.relay.tokenSource,
    gmailProviderAvailable: gmailProvider?.available === true,
    gmailOAuthMode: gmailProvider?.oauthMode,
    connectionBaseURL: connection.server.baseURL,
    connectionSecurity: connection.security.summary,
    doctorRelay: doctor.checks.relay,
    doctorGmailOAuth: doctor.checks.gmailOAuth,
    accountsAfterFakeConsent: statusAfterAuth.accounts.length,
    gmail
  };

  assertSmokeResult(result);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (!keepTemp) {
    rmSync(temp, { recursive: true, force: true });
  } else {
    console.error(`Kept smoke data dir: ${temp}`);
  }
}

function runCarta(args, { timeout = 30000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--no-warnings", cartaBin, ...args], {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`carta ${args.join(" ")} timed out`));
    }, timeout);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun({ stdout, stderr });
      } else {
        rejectRun(new Error(`carta ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function smokeGmailRelayStartAndCallback() {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawn(process.execPath, [
      "--no-warnings",
      cartaBin,
      "accounts",
      "add",
      "gmail",
      "--no-open",
      "--history",
      "6-months",
      "--initial-limit",
      "1",
      "--max-batches",
      "1"
    ], {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let callbackStarted = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectSmoke(new Error(`Gmail relay start timed out. stdout=${stdout} stderr=${stderr}`));
    }, 30000);

    child.stdout.on("data", async chunk => {
      stdout += String(chunk);
      const match = stdout.match(/https:\/\/accounts\.google\.com\/[^\s]+/u);
      if (!match || callbackStarted) return;
      callbackStarted = true;
      try {
        const authURL = new URL(match[0]);
        const callbackURL = new URL(requiredParam(authURL, "redirect_uri"));
        callbackURL.searchParams.set("state", requiredParam(authURL, "state"));
        callbackURL.searchParams.set("code", "fake-code-for-carta-relay-smoke");

        const response = await fetch(callbackURL);
        const body = await response.text();
        resolveSmoke({
          authorizationURLFound: true,
          redirectURI: callbackURL.origin + callbackURL.pathname,
          clientIdLooksGoogle: /\.apps\.googleusercontent\.com$/u.test(requiredParam(authURL, "client_id")),
          callbackStatus: response.status,
          expectedFakeCodeFailure: /Malformed auth code|Gmail connection failed/iu.test(body)
        });
      } catch (error) {
        rejectSmoke(error);
      } finally {
        clearTimeout(timer);
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => {
      clearTimeout(timer);
      rejectSmoke(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!callbackStarted) {
        rejectSmoke(new Error(`Gmail command exited before auth URL. stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
}

function assertSmokeResult(result) {
  const checks = [
    ["isolatedDatabase", result.isolatedDatabase],
    ["initialized", result.initialized],
    ["relayConfigured", result.relayConfigured],
    ["gmailProviderAvailable", result.gmailProviderAvailable],
    ["gmailOAuthMode=relay", result.gmailOAuthMode === "relay"],
    ["connectionSecurity", result.connectionSecurity === "local-only loopback"],
    ["doctorRelay", /^configured/u.test(result.doctorRelay)],
    ["doctorGmailOAuth", /relay/u.test(result.doctorGmailOAuth)],
    ["fake auth did not create account", result.accountsAfterFakeConsent === 0],
    ["authorizationURLFound", result.gmail.authorizationURLFound],
    ["clientIdLooksGoogle", result.gmail.clientIdLooksGoogle],
    ["usesLocalRelayCallback", result.gmail.redirectURI === `${result.connectionBaseURL}/api/auth/gmail/callback`],
    ["expectedFakeCodeFailure", result.gmail.expectedFakeCodeFailure]
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Relay e2e smoke failed checks: ${failed.join(", ")}`);
  }
}

function requiredParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Google auth URL is missing ${name}.`);
  return value;
}

function normalizeURL(value) {
  return String(value ?? "").trim().replace(/\/+$/u, "");
}

function readStoredRelayToken(baseURL) {
  if (process.platform !== "darwin") return "";
  for (const service of ["CartaCLI", "EmailApp"]) {
    try {
      return execFileSync("security", [
        "find-generic-password",
        "-w",
        "-s",
        service,
        "-a",
        `carta.relay.token:${baseURL}`
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      // Try the next service so existing local smoke credentials still work.
    }
  }
  return "";
}

function assertPortAvailable(candidatePort) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", error => {
      if (error.code === "EADDRINUSE") {
        rejectPort(new Error(`Port ${candidatePort} is already in use. Stop the local Carta server or set CARTA_SMOKE_PORT.`));
      } else {
        rejectPort(error);
      }
    });
    server.listen(candidatePort, "127.0.0.1", () => {
      server.close(resolvePort);
    });
  });
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) resolvePort(port);
        else rejectPort(new Error("Could not allocate an available port."));
      });
    });
  });
}
