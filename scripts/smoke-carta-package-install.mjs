#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "carta-package-smoke-"));
const keepTemp = process.env.CARTA_SMOKE_KEEP === "1";

try {
  const packDir = join(temp, "pack");
  const prefixDir = join(temp, "prefix");
  const dataDir = join(temp, "data");
  const port = await availablePort();
  mkdirSync(packDir, { recursive: true });

  const pack = await run("npm", ["pack", "--pack-destination", packDir, "--silent"], {
    cwd: rootDir,
    timeout: 30000
  });
  const tarballName = pack.stdout.trim().split(/\r?\n/u).find(line => line.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error(`npm pack did not report a tarball. Output: ${pack.stdout}`);
  }
  const tarballPath = join(packDir, tarballName);

  await run("npm", ["install", "--global", "--prefix", prefixDir, tarballPath, "--silent"], {
    cwd: rootDir,
    timeout: 120000
  });

  const cartaBin = join(prefixDir, "bin", "carta");
  const env = {
    ...process.env,
    CARTA_DATA_DIR: dataDir,
    EMAIL_DATABASE_PATH: join(dataDir, "mail.sqlite"),
    CARTA_SERVER_HOST: "127.0.0.1",
    CARTA_SERVER_PORT: String(port),
    CARTA_PUBLIC_BASE_URL: "",
    EMAIL_PUBLIC_BASE_URL: "",
    EMAIL_AUTO_SYNC: "0",
    EMAIL_AUTO_HISTORY_BACKFILL: "0",
    HOME: join(temp, "home"),
    NO_COLOR: process.env.NO_COLOR ?? "1"
  };

  const setup = await run(cartaBin, [
    "setup",
    "--name", "Package Smoke",
    "--email", "package-smoke@example.test",
    "--history", "6-months",
    "--attachments", "false",
    "--expose", "local-only",
    "--no-account",
    "--no-install-server"
  ], { env });
  const status = JSON.parse((await run(cartaBin, ["status", "--json"], { env })).stdout);
  const fixtures = JSON.parse((await run(cartaBin, ["fixtures", "seed", "--json"], { env })).stdout);
  const invoices = JSON.parse((await run(cartaBin, ["search", "invoice", "--has-attachments", "true", "--json"], { env })).stdout);
  const notePath = join(temp, "note.txt");
  writeFileSync(notePath, "hello from the installed carta package\n");
  const sent = JSON.parse((await run(cartaBin, [
    "send",
    "--account", "alex.fixture@gmail.test",
    "--to", "pat@example.test",
    "--subject", "Package smoke",
    "--body", "Please see attached.",
    "--attach", notePath,
    "--json"
  ], { env })).stdout);
  const reply = JSON.parse((await run(cartaBin, [
    "reply",
    "fixture-gmail-taylor-roadmap",
    "--body", "Okay, got it.",
    "--json"
  ], { env })).stdout);
  const launchAgent = JSON.parse((await run(cartaBin, [
    "server",
    "install",
    "--dry-run",
    "--json",
    "--bin", cartaBin,
    "--uid", "123"
  ], { env })).stdout);
  const serverAPI = await withInstalledServer(cartaBin, env, status.server.baseURL, invoices.emails[0]?.id);
  const resetPreview = JSON.parse((await run(cartaBin, ["reset", "--dry-run", "--json"], { env })).stdout);
  const reset = JSON.parse((await run(cartaBin, ["reset", "--yes", "--json"], { env })).stdout);
  const resetStatus = JSON.parse((await run(cartaBin, ["status", "--json"], { env })).stdout);

  const result = {
    ok: true,
    tarball: tarballName,
    installedBin: cartaBin,
    setupComplete: /Setup complete/u.test(setup.stdout),
    isolatedDatabase: status.databasePath.startsWith(dataDir),
    initialized: status.initialized,
    baseURL: status.server.baseURL,
    accountsSeeded: fixtures.accounts.length,
    emailsSeeded: fixtures.emails.length,
    invoiceMatches: invoices.emails.length,
    sentMailbox: sent.email.mailboxRole,
    sentAttachment: sent.email.attachments?.[0]?.filename ?? null,
    replySubject: reply.email.subject,
    replyRecipient: reply.email.recipients?.[0] ?? null,
    launchAgentLabel: launchAgent.launchAgent.label,
    launchAgentProgram: launchAgent.launchAgent.program,
    serverHealth: serverAPI.health.status,
    serverAccounts: serverAPI.accounts.accounts.length,
    serverEmails: serverAPI.emails.emails.length,
    serverGmailConfigured: serverAPI.auth.settings.gmailConfigured,
    serverGmailOAuthMode: serverAPI.auth.settings.gmailOAuthMode,
    serverDetailSubject: serverAPI.detail.email.subject,
    serverReadAfterPatch: serverAPI.read.email.isRead,
    serverMailboxAfterArchive: serverAPI.archive.email.mailboxRole,
    resetDryRun: resetPreview.reset.dryRun,
    resetAccountsRemoved: reset.reset.accountsRemoved,
    resetInitializedAfter: resetStatus.initialized,
    resetAccountsAfter: resetStatus.accounts.length
  };
  assertSmokeResult(result, { dataDir, port, cartaBin });
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (!keepTemp) {
    rmSync(temp, { recursive: true, force: true });
  } else {
    console.error(`Kept smoke data dir: ${temp}`);
  }
}

function run(command, args, { cwd = rootDir, env = process.env, timeout = 30000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`${command} ${args.join(" ")} timed out`));
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
        rejectRun(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function assertSmokeResult(result, { dataDir, port, cartaBin }) {
  const checks = [
    ["setupComplete", result.setupComplete],
    ["isolatedDatabase", result.isolatedDatabase],
    ["initialized", result.initialized],
    ["baseURL", result.baseURL === `http://127.0.0.1:${port}`],
    ["accountsSeeded", result.accountsSeeded === 2],
    ["emailsSeeded", result.emailsSeeded >= 8],
    ["invoiceMatches", result.invoiceMatches >= 2],
    ["sentMailbox", result.sentMailbox === "sent"],
    ["sentAttachment", result.sentAttachment === "note.txt"],
    ["replySubject", /^Re:/u.test(result.replySubject)],
    ["replyRecipient", result.replyRecipient === "taylor@northstar.test"],
    ["launchAgentLabel", result.launchAgentLabel === "com.carta.email.cli.server"],
    ["launchAgentProgram", result.launchAgentProgram === cartaBin],
    ["serverHealth", result.serverHealth === "ok"],
    ["serverAccounts", result.serverAccounts === 2],
    ["serverEmails", result.serverEmails >= 1],
    ["serverGmailConfigured", typeof result.serverGmailConfigured === "boolean"],
    ["serverGmailOAuthMode", ["desktop", "relay"].includes(result.serverGmailOAuthMode)],
    ["serverDetailSubject", typeof result.serverDetailSubject === "string" && result.serverDetailSubject.length > 0],
    ["serverReadAfterPatch", result.serverReadAfterPatch === true],
    ["serverMailboxAfterArchive", result.serverMailboxAfterArchive === "archive"],
    ["resetDryRun", result.resetDryRun === true],
    ["resetAccountsRemoved", result.resetAccountsRemoved === 2],
    ["resetInitializedAfter", result.resetInitializedAfter === false],
    ["resetAccountsAfter", result.resetAccountsAfter === 0],
    ["databaseUnderDataDir", result.isolatedDatabase && dataDir]
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Package install smoke failed checks: ${failed.join(", ")}`);
  }
}

async function withInstalledServer(cartaBin, env, baseURL, actionEmailId) {
  if (!actionEmailId) throw new Error("Package smoke needs at least one email id for server API mutation checks.");
  const child = spawn(cartaBin, ["server", "start"], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  try {
    await waitForHealth(baseURL, { stdout: () => stdout, stderr: () => stderr });
    const [health, accounts, emails, auth, detail] = await Promise.all([
      fetchJSON(`${baseURL}/api/health`),
      fetchJSON(`${baseURL}/api/accounts`),
      fetchJSON(`${baseURL}/api/emails?limit=5`),
      fetchJSON(`${baseURL}/api/auth/settings`),
      fetchJSON(`${baseURL}/api/emails/${encodeURIComponent(actionEmailId)}`)
    ]);
    const read = await fetchJSON(`${baseURL}/api/emails/${encodeURIComponent(actionEmailId)}`, {
      method: "PATCH",
      body: {
        isRead: true
      }
    });
    const archive = await fetchJSON(`${baseURL}/api/emails/${encodeURIComponent(actionEmailId)}/archive`, {
      method: "POST",
      body: {}
    });
    return { health, accounts, emails, auth, detail, read, archive };
  } finally {
    await stopServer(child);
  }
}

async function waitForHealth(baseURL, logs) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJSON(`${baseURL}/api/health`);
      if (health.status === "ok") return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Installed server did not become healthy: ${lastError?.message ?? "timeout"} stdout=${logs.stdout()} stderr=${logs.stderr()}`);
}

async function fetchJSON(url, { method = "GET", body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function stopServer(child) {
  return new Promise(resolveStop => {
    if (child.exitCode !== null || child.signalCode) {
      resolveStop();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 3000);
    child.once("close", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
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
