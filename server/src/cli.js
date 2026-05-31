import { createServer as createHTTPServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  applyStoredServerAccess,
  effectiveServerBaseURL,
  normalizeBaseURL,
  serverAccessFromStore,
  storeServerAccess
} from "./serverAccess.js";
import {
  applyStoredRelay,
  clearRelayConfig,
  relayConfigStatus,
  storeRelayConfig
} from "./relayConfig.js";

const DEFAULT_HISTORY_WINDOW = "last-year";
const DEFAULT_BATCH_LIMIT = 500;
const DEFAULT_INITIAL_LIMIT = 500;
const SETTING_INITIALIZED = "carta.initialized";
const SETTING_SYNC_WINDOW = "carta.sync.window";
const SETTING_SYNC_ATTACHMENTS = "carta.sync.attachments";
const CLI_LAUNCH_AGENT_LABEL = "com.carta.email.cli.server";

const HISTORY_WINDOWS = new Map([
  ["6-months", { id: "6-months", label: "last 6 months", months: 6 }],
  ["last-year", { id: "last-year", label: "last year", years: 1 }],
  ["1-year", { id: "last-year", label: "last year", years: 1 }],
  ["2-years", { id: "2-years", label: "last 2 years", years: 2 }],
  ["5-years", { id: "5-years", label: "last 5 years", years: 5 }],
  ["all", { id: "all", label: "full history", all: true }]
]);

export async function runCLI(argv = process.argv.slice(2), options = {}) {
  const streams = {
    stdin: options.stdin ?? processStdin,
    stdout: options.stdout ?? processStdout,
    stderr: options.stderr ?? process.stderr
  };
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseArgs(argv);
  const [command = "help", subcommand = null, ...rest] = parsed.positionals;

  if (command === "help" || command === "--help" || command === "-h") {
    write(streams.stdout, helpText());
    return 0;
  }

  const env = prepareEnv(options.env ?? process.env, cwd);
  const { createMailRuntime } = await import("./runtime.js");
  const runtime = createMailRuntime({
    env,
    secretStore: options.secretStore,
    store: options.store,
    logger: options.logger ?? quietLogger()
  });
  const context = {
    ...runtime,
    env,
    cwd,
    streams,
    detectTailscale: options.detectTailscale ?? detectTailscale,
    configureTailscaleServe: options.configureTailscaleServe ?? configureTailscaleServe,
    openBrowser: options.openBrowser ?? openBrowser,
    launchctl: options.launchctl ?? launchctl
  };
  const keepRuntimeOpen = command === "server" && subcommand === "start";

  try {
    switch (command) {
      case "init":
      case "onboard":
        await initCommand(context, parsed.options);
        break;
      case "setup":
        await setupCommand(context, parsed.options);
        break;
      case "status":
        statusCommand(context, parsed.options);
        break;
      case "reset":
        await resetCommand(context, parsed.options);
        break;
      case "connection":
      case "connect-info":
        await connectionCommand(context, parsed.options);
        break;
      case "relay":
        await relayCommand(context, subcommand, parsed.options);
        break;
      case "profile":
        await profileCommand(context, parsed.options);
        break;
      case "accounts":
      case "account":
        await accountsCommand(context, subcommand, rest, parsed.options);
        break;
      case "sync":
        await syncCommand(context, subcommand, rest, parsed.options);
        break;
      case "list":
      case "emails":
        listEmailsCommand(context, parsed.options);
        break;
      case "search":
        searchCommand(context, [subcommand, ...rest].filter(Boolean), parsed.options);
        break;
      case "send":
        await sendCommand(context, parsed.options);
        break;
      case "reply":
        await replyCommand(context, subcommand, parsed.options);
        break;
      case "forward":
      case "fwd":
        await forwardCommand(context, subcommand, parsed.options);
        break;
      case "archive":
      case "trash":
      case "spam":
      case "mark-read":
      case "mark-unread":
        await emailActionCommand(context, command, subcommand, parsed.options);
        break;
      case "show":
      case "read":
        showCommand(context, subcommand, parsed.options);
        break;
      case "server":
        await serverCommand(context, subcommand, rest, parsed.options);
        break;
      case "doctor":
        await doctorCommand(context, parsed.options);
        break;
      case "fixtures":
      case "fixture":
        fixturesCommand(context, subcommand, parsed.options);
        break;
      default:
        throw cliError(64, `Unknown command: ${command}. Run carta help.`);
    }
    return 0;
  } finally {
    if (!keepRuntimeOpen) {
      runtime.close();
    }
  }
}

async function initCommand(context, options) {
  const prompts = createPrompts(context.streams);
  try {
    const profile = context.store.getProfile();
    const displayName = options.name
      ?? await prompts.text("Your name", profile.displayName === "Local Profile" ? "" : profile.displayName);
    const primaryEmail = options.email
      ?? await prompts.text("Carta account email", profile.primaryEmail ?? "");
    const historyWindow = normalizeHistoryWindow(options.history
      ?? await prompts.select("How far back should account sync go?", DEFAULT_HISTORY_WINDOW, [
        "6-months",
        "last-year",
        "2-years",
        "5-years",
        "all"
      ]));
    const includeAttachments = parseBoolean(options.attachments, null)
      ?? await prompts.confirm("Download attachments during backfill?", true);

    const nextProfile = context.store.updateProfile({
      displayName,
      primaryEmail
    });
    context.store.setSetting(SETTING_INITIALIZED, "1");
    context.store.setSetting(SETTING_SYNC_WINDOW, historyWindow.id);
    context.store.setSetting(SETTING_SYNC_ATTACHMENTS, includeAttachments ? "1" : "0");

    write(context.streams.stdout, formatProfileReady(context, nextProfile, historyWindow, includeAttachments));
  } finally {
    prompts.close();
  }
}

async function setupCommand(context, options) {
  await initCommand(context, options);
  await configureServerAccessCommand(context, options);
  await maybeConfigureRelayDuringSetup(context, options);

  if (!options["no-account"]) {
    let first = true;
    while (true) {
      const prompts = createPrompts(context.streams);
      let provider = null;
      try {
        if (first) {
          const shouldConnect = parseBoolean(options.account, null)
            ?? (context.streams.stdin.isTTY ? await prompts.confirm("Connect an email account now?", true) : false);
          if (!shouldConnect) break;
        } else {
          if (!context.streams.stdin.isTTY || options.provider) break;
          const shouldConnectMore = await prompts.confirm("Connect another email account?", false);
          if (!shouldConnectMore) break;
        }

        provider = options.provider
          ?? await promptForAccountProvider(context, prompts);
      } finally {
        prompts.close();
      }

      try {
        await addAccountCommand(context, provider, options);
        first = false;
      } catch (error) {
        if (!context.streams.stdin.isTTY || options.provider) {
          throw error;
        }
        write(context.streams.stdout, `Could not connect ${provider}: ${error.message}\n`);
        first = true;
      }
    }
  }

  const backgroundServer = await maybeInstallBackgroundServerDuringSetup(context, options);
  await writeSetupSummary(context, { backgroundServer });
}

async function configureServerAccessCommand(context, options) {
  if (options["no-access"] || options["no-exposure"]) return;

  const explicitMode = options.expose ?? options.exposure ?? options.access ?? options["server-access"];
  const explicitPublicURL = options["public-url"] ?? options.publicURL ?? options.publicBaseURL;
  let mode = normalizeAccessMode(explicitMode, explicitPublicURL);
  const port = normalizePort(options["server-port"] ?? options.port ?? context.config.port, context.config.port);
  let tailscale = null;

  const prompts = createPrompts(context.streams);
  try {
    if (!mode && context.streams.stdin.isTTY) {
      tailscale = await context.detectTailscale({ port });
      write(context.streams.stdout, [
        "",
        "Server access",
        "Tailscale is recommended so your Carta clients can reach this server over your private tailnet."
      ].join("\n") + "\n");
      if (tailscale.available) {
        write(context.streams.stdout, `Detected Tailscale: ${tailscale.dnsName || tailscale.ip}\n`);
        mode = await prompts.select("How should clients reach this server?", "tailscale", [
          "tailscale",
          "local-only",
          "open-port"
        ]);
      } else {
        const reason = tailscale.installed
          ? `Tailscale is installed but not ready (${tailscale.state || tailscale.error || "not running"}).`
          : "Tailscale is not installed.";
        write(context.streams.stdout, `${reason} Install and sign in to Tailscale, then rerun setup for secure remote access.\n`);
        mode = await prompts.select("How should clients reach this server for now?", "local-only", [
          "local-only",
          "open-port"
        ]);
      }
    }

    mode = normalizeAccessMode(mode, explicitPublicURL) ?? "local";
    if (mode === "tailscale") {
      tailscale ??= await context.detectTailscale({ port });
      if (!tailscale.available) {
        throw cliError(69, "Tailscale is not ready. Install it, sign in with `tailscale up`, then rerun `carta setup --expose tailscale`.");
      }
      const access = await tailscaleServerAccess(context, {
        explicitPublicURL,
        options,
        port,
        tailscale
      });
      storeServerAccess(context.store, {
        mode: "tailscale",
        host: access.host,
        port,
        publicBaseURL: access.publicBaseURL,
        tailscaleDNSName: tailscale.dnsName,
        tailscaleIP: tailscale.ip
      });
      refreshContextServerAccess(context);
      write(context.streams.stdout, [
        `Server access: Tailscale (${access.publicBaseURL})`,
        access.serveProxy ? `Tailscale HTTPS proxy: ${access.serveProxy}` : null,
        access.warning ? `Tailscale HTTPS warning: ${access.warning}` : null,
        `Server will bind to ${access.host}:${port}.`
      ].filter(Boolean).join("\n") + "\n");
      return;
    }

    if (mode === "open-port") {
      await confirmOpenPortAccess(context, prompts, options);
      const host = options["server-host"] ?? "0.0.0.0";
      const publicBaseURL = normalizeBaseURL(explicitPublicURL
        ?? (context.streams.stdin.isTTY ? await prompts.text("Public URL for this server, if you have one", "") : ""));
      storeServerAccess(context.store, {
        mode: "open-port",
        host,
        port,
        publicBaseURL
      });
      refreshContextServerAccess(context);
      write(context.streams.stdout, [
        "Server access: open port",
        publicBaseURL
          ? `Clients should use ${publicBaseURL}.`
          : "No public URL was saved. You still need to handle router/firewall/DNS outside Carta.",
        "Warning: open-port mode exposes the Carta HTTP API to whatever network can reach this host.",
        "Tailscale is safer for normal use."
      ].join("\n") + "\n");
      return;
    }

    storeServerAccess(context.store, {
      mode: "local",
      host: options["server-host"] ?? "127.0.0.1",
      port,
      publicBaseURL: ""
    });
    refreshContextServerAccess(context);
    write(context.streams.stdout, `Server access: local only (${effectiveServerBaseURL(context.config)})\n`);
  } finally {
    prompts.close();
  }
}

async function confirmOpenPortAccess(context, prompts, options) {
  const allowed = parseBoolean(
    options["allow-insecure-open-port"] ?? options["allow-open-port"] ?? options["confirm-open-port"],
    null
  );
  if (allowed === true) return;
  if (allowed === false) {
    throw cliError(78, "Open-port server access was not confirmed.");
  }
  const warning = [
    "Open-port mode can expose your local Carta HTTP API and email data to any network that can reach this machine.",
    "Use Tailscale unless you are deliberately handling network security yourself."
  ].join(" ");
  if (!context.streams.stdin.isTTY) {
    throw cliError(78, `${warning} Re-run with --allow-insecure-open-port if you explicitly accept that risk.`);
  }
  write(context.streams.stdout, `${warning}\n`);
  const confirmed = await prompts.confirm("Use open-port mode anyway?", false);
  if (!confirmed) {
    throw cliError(78, "Open-port server access was not confirmed.");
  }
}

async function maybeInstallBackgroundServerDuringSetup(context, options) {
  const explicitInstall = parseBoolean(
    options["install-server"] ?? options["server-install"] ?? options["background-server"],
    null
  );
  if (explicitInstall === false || options["no-install-server"]) return null;

  let shouldInstall = explicitInstall;
  if (shouldInstall === null && process.platform === "darwin" && context.streams.stdin.isTTY) {
    const prompts = createPrompts(context.streams);
    try {
      shouldInstall = await prompts.confirm("Start Carta server in background now?", true);
    } finally {
      prompts.close();
    }
  }
  if (!shouldInstall) return null;

  await installServerLaunchAgent(context, options);
  return {
    status: options["dry-run"] ? "dry-run" : "installed"
  };
}

async function writeSetupSummary(context, { backgroundServer = null } = {}) {
  const connection = await connectionPayload(context);
  write(context.streams.stdout, [
    "",
    "Setup complete.",
    `Client apps: ${connection.server.baseURL}`,
    `Start server: ${connection.command}`,
    backgroundServer?.status === "installed" ? "Background server: installed" : null,
    backgroundServer?.status === "dry-run" ? "Background server: install preview generated" : null,
    !backgroundServer && connection.backgroundCommand ? `Run in background: ${connection.backgroundCommand}` : null,
    `Check server: ${connection.statusCommand}`,
    `Health check: ${connection.server.healthURL}`
  ].filter(Boolean).join("\n") + "\n");
}

async function relayCommand(context, subcommand, options) {
  switch (subcommand ?? "status") {
    case "configure":
    case "config":
    case "set":
      await configureRelayCommand(context, options, { forcePrompt: true });
      return;
    case "status":
    case "show":
      relayStatusCommand(context, options);
      return;
    case "clear":
    case "reset":
      clearRelayConfig(context.store, context.secretStore);
      refreshContextRelay(context);
      writeJSONOrText(context.streams.stdout, options.json, { relay: relayStatusPayload(context) }, () => {
        return "Carta relay configuration cleared.\n";
      });
      return;
    default:
      throw cliError(64, `Unknown relay command: ${subcommand}. Try carta relay status or carta relay configure.`);
  }
}

async function maybeConfigureRelayDuringSetup(context, options) {
  if (options["no-relay"]) return;
  const explicitRelay = hasRelayConfigOptions(options);
  if (explicitRelay) {
    await configureRelayCommand(context, options);
    return;
  }

  const relay = relayStatusPayload(context);
  if (!relay.configured) return;

  if (context.config.relay?.token && (relay.source !== "stored" || relay.tokenSource !== "keychain")) {
    storeRelayConfig(context.store, context.secretStore, {
      baseURL: context.config.relay.baseURL,
      token: context.config.relay.token
    });
    refreshContextRelay(context);
  }
}

async function configureRelayCommand(context, options, { forcePrompt = false } = {}) {
  const explicitURL = options["relay-url"] ?? options.relayURL ?? options.url;
  const explicitToken = options["relay-token"] ?? options.relayToken ?? options.token;
  const current = relayConfigStatus(context.config);
  const shouldPrompt = context.streams.stdin.isTTY && (forcePrompt || !explicitURL || !explicitToken);
  const prompts = createPrompts(context.streams);
  try {
    const baseURL = normalizeBaseURL(explicitURL ?? (shouldPrompt
      ? await prompts.text("Relay URL", current.baseURL)
      : ""));
    const token = explicitToken ?? (shouldPrompt ? await prompts.text("Relay token") : "");
    try {
      storeRelayConfig(context.store, context.secretStore, { baseURL, token });
    } catch (error) {
      throw cliError(64, error.message);
    }
    refreshContextRelay(context);
    const relay = relayStatusPayload(context);
    writeJSONOrText(context.streams.stdout, options.json, { relay }, () => {
      return `Carta relay configured: ${relay.baseURL}\n`;
    });
  } finally {
    prompts.close();
  }
}

function relayStatusCommand(context, options) {
  const relay = relayStatusPayload(context);
  writeJSONOrText(context.streams.stdout, options.json, { relay }, () => {
    return [
      `Relay: ${relay.configured ? "configured" : "not configured"}`,
      relay.baseURL ? `URL: ${relay.baseURL}` : null,
      `Token: ${relay.tokenConfigured ? `configured (${relay.tokenSource})` : "missing"}`
    ].filter(Boolean).join("\n") + "\n";
  });
}

function relayStatusPayload(context) {
  return relayConfigStatus(context.config);
}

function hasRelayConfigOptions(options) {
  return Boolean(options["relay-url"] ?? options.relayURL ?? options.url ?? options["relay-token"] ?? options.relayToken ?? options.token);
}

async function profileCommand(context, options) {
  if (options.name || options.email) {
    const profile = context.store.updateProfile({
      displayName: options.name,
      primaryEmail: options.email
    });
    writeJSONOrText(context.streams.stdout, options.json, { profile }, () => {
      return `Profile updated: ${profile.displayName}${profile.primaryEmail ? ` <${profile.primaryEmail}>` : ""}\n`;
    });
    return;
  }

  const profile = context.store.getProfile();
  writeJSONOrText(context.streams.stdout, options.json, { profile }, () => {
    return `${profile.displayName}${profile.primaryEmail ? ` <${profile.primaryEmail}>` : ""}\n`;
  });
}

function statusCommand(context, options) {
  const payload = statusPayload(context);
  writeJSONOrText(context.streams.stdout, options.json, payload, () => formatStatus(payload));
}

async function resetCommand(context, options) {
  const dryRun = options["dry-run"] === true;
  const keepRelay = resetKeepsRelay(options);
  const accounts = context.store.listAccounts();
  const relayToRestore = keepRelay && context.config.relay?.baseURL && context.config.relay?.token
    ? {
        baseURL: context.config.relay.baseURL,
        token: context.config.relay.token
      }
    : null;
  const accountSecretKeys = accountSecretKeysFor(accounts);
  const relayWasConfigured = relayStatusPayload(context).configured;

  await confirmReset(context, options, {
    dryRun,
    keepRelay,
    accountCount: accounts.length
  });

  if (!dryRun) {
    for (const key of accountSecretKeys) {
      context.secretStore.delete(key);
    }
    if (!keepRelay) {
      clearRelayConfig(context.store, context.secretStore);
    }
    context.store.resetAllData();
    if (relayToRestore) {
      storeRelayConfig(context.store, context.secretStore, relayToRestore);
    }
    refreshContextServerAccess(context);
  }

  const payload = {
    reset: {
      dryRun,
      databasePath: context.config.databasePath,
      accountsRemoved: accounts.length,
      accountSecretsRemoved: accountSecretKeys.length,
      relay: keepRelay
        ? relayToRestore ? "preserved" : "not configured"
        : relayWasConfigured ? "cleared" : "not configured",
      initialized: dryRun ? statusPayload(context).initialized : false
    }
  };
  writeJSONOrText(context.streams.stdout, options.json, payload, () => {
    const action = dryRun ? "Would reset" : "Reset";
    return [
      `${action} Carta CLI data.`,
      `Database: ${payload.reset.databasePath}`,
      `Accounts removed: ${payload.reset.accountsRemoved}`,
      `Account secrets removed: ${payload.reset.accountSecretsRemoved}`,
      `Relay: ${payload.reset.relay}`,
      dryRun ? "Run with --yes to apply." : "Run carta setup to start again."
    ].join("\n") + "\n";
  });
}

async function confirmReset(context, options, { dryRun, keepRelay, accountCount }) {
  if (dryRun) return;
  const confirmed = parseBoolean(options.yes ?? options.force ?? options.confirm, null);
  if (confirmed === true) return;
  if (confirmed === false) {
    throw cliError(78, "Carta CLI reset was not confirmed.");
  }
  const summary = [
    `This will reset Carta CLI data at ${context.config.databasePath}.`,
    `It removes ${accountCount} connected account${accountCount === 1 ? "" : "s"}, local emails, sync state, profile, and account secrets.`,
    keepRelay
      ? "The Carta relay configuration will be preserved so Gmail setup can still use the production relay."
      : "The Carta relay configuration and token will also be cleared."
  ].join(" ");
  if (!context.streams.stdin.isTTY) {
    throw cliError(78, `${summary} Re-run with --yes to confirm.`);
  }
  const prompts = createPrompts(context.streams);
  try {
    write(context.streams.stdout, `${summary}\n`);
    const answer = await prompts.confirm("Reset Carta CLI data?", false);
    if (!answer) {
      throw cliError(78, "Carta CLI reset was not confirmed.");
    }
  } finally {
    prompts.close();
  }
}

function resetKeepsRelay(options) {
  if (options.all === true || options["clear-relay"] === true || options["reset-relay"] === true) return false;
  return parseBoolean(options["keep-relay"], true);
}

function accountSecretKeysFor(accounts) {
  return accounts.flatMap(account => [
    accountSecretKey(account.id, "gmail.refresh_token"),
    accountSecretKey(account.id, "icloud.app_password"),
    accountSecretKey(account.id, "imap.password"),
    accountSecretKey(account.id, "imap.smtp_password")
  ]);
}

function accountSecretKey(accountId, name) {
  return `account:${accountId}:${name}`;
}

async function connectionCommand(context, options) {
  const payload = await connectionPayload(context, {
    check: options.check === true || options.health === true
  });
  writeJSONOrText(context.streams.stdout, options.json, payload, () => formatConnection(payload));
}

function statusPayload(context) {
  const profile = context.store.getProfile();
  const access = serverAccessFromStore(context.store);
  const accounts = context.store.listAccounts().map(account => ({
    ...account,
    stats: context.store.accountEmailStats(account.id),
    syncStatus: account.providerMetadata?.cartaSyncStatus ?? null
  }));
  return {
    initialized: context.store.getSetting(SETTING_INITIALIZED, "0") === "1",
    databasePath: context.config.databasePath,
    server: {
      host: context.config.host,
      port: context.config.port,
      publicBaseURL: context.config.publicBaseURL ?? null,
      baseURL: effectiveServerBaseURL(context.config),
      access
    },
    relay: relayStatusPayload(context),
    defaults: {
      history: context.store.getSetting(SETTING_SYNC_WINDOW, DEFAULT_HISTORY_WINDOW),
      attachments: context.store.getSetting(SETTING_SYNC_ATTACHMENTS, "1") === "1"
    },
    profile: {
      id: profile.id,
      displayName: profile.displayName,
      primaryEmail: profile.primaryEmail
    },
    accounts
  };
}

async function connectionPayload(context, { check = false } = {}) {
  const status = statusPayload(context);
  const baseURL = status.server.baseURL;
  const payload = {
    server: {
      baseURL,
      healthURL: `${baseURL}/api/health`,
      authSettingsURL: `${baseURL}/api/auth/settings`,
      host: status.server.host,
      port: status.server.port,
      access: status.server.access
    },
    security: connectionSecurity(status.server.access),
    databasePath: status.databasePath,
    command: "carta server start",
    backgroundCommand: process.platform === "darwin" ? "carta server install" : null,
    statusCommand: "carta server status --check",
    health: null
  };
  if (check) {
    payload.health = await checkServerHealth(payload.server.healthURL);
  }
  return payload;
}

function formatConnection(payload) {
  const lines = [
    `Server URL: ${payload.server.baseURL}`,
    `Health URL: ${payload.server.healthURL}`,
    `Access: ${formatAccessSummary(payload.server.access)}`,
    payload.security.warning ? `Security: ${payload.security.warning}` : `Security: ${payload.security.summary}`,
    `Database: ${payload.databasePath}`,
    `Start: ${payload.command}`,
    payload.backgroundCommand ? `Run in background: ${payload.backgroundCommand}` : null,
    `Check: ${payload.statusCommand}`
  ].filter(Boolean);
  if (payload.health) {
    lines.push(`Health: ${payload.health.ok ? "ok" : `unreachable (${payload.health.error ?? payload.health.status})`}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatProfileReady(context, profile, historyWindow, includeAttachments) {
  const profileText = `${profile.displayName}${profile.primaryEmail ? ` <${profile.primaryEmail}>` : ""}`;
  if (!prettyOutput(context)) {
    return [
      "Carta email profile ready.",
      `Profile: ${profileText}`,
      `Default sync: ${historyWindow.label}, attachments ${includeAttachments ? "on" : "off"}`,
      `Database: ${context.config.databasePath}`
    ].join("\n") + "\n";
  }
  return [
    "",
    style(context, "bold", "Carta profile ready"),
    `  ${style(context, "muted", "Profile")}    ${profileText}`,
    `  ${style(context, "muted", "Sync")}       ${historyWindow.label}, attachments ${includeAttachments ? "on" : "off"}`,
    `  ${style(context, "muted", "Database")}   ${context.config.databasePath}`,
    ""
  ].join("\n");
}

function formatGmailAuthURL(context, authorizationURL) {
  if (!prettyOutput(context)) {
    return [
      "Open this URL to connect Gmail:",
      authorizationURL,
      ""
    ].join("\n");
  }
  return [
    "",
    style(context, "bold", "Gmail sign-in"),
    `  ${style(context, "muted", "Browser")}    Opening Google sign-in...`,
    `  ${style(context, "muted", "Fallback")}   ${authorizationURL}`,
    ""
  ].join("\n");
}

function formatStatus(payload) {
  const lines = [
    `Carta email ${payload.initialized ? "initialized" : "not initialized"}`,
    `Profile: ${payload.profile.displayName}${payload.profile.primaryEmail ? ` <${payload.profile.primaryEmail}>` : ""}`,
    `Database: ${payload.databasePath}`,
    `Server: ${payload.server.baseURL}`,
    `Access: ${formatAccessSummary(payload.server.access)}`,
    `Relay: ${payload.relay.configured ? payload.relay.baseURL : "not configured"}`,
    `Default sync: ${payload.defaults.history}, attachments ${payload.defaults.attachments ? "on" : "off"}`,
    ""
  ];

  if (payload.accounts.length === 0) {
    lines.push("No accounts connected yet.");
  } else {
    lines.push("Accounts:");
    for (const account of payload.accounts) {
      const stats = account.stats ?? {};
      const sync = account.syncStatus;
      lines.push(`- ${account.email} (${account.provider}, ${account.status})`);
      lines.push(`  emails=${stats.totalCount ?? 0} unread=${stats.unreadCount ?? 0} oldest=${stats.oldestReceivedAt ?? "none"}`);
      if (sync) {
        lines.push(`  sync=${sync.status} imported=${sync.imported ?? 0} window=${sync.historyWindow ?? "unknown"} updated=${sync.updatedAt ?? "unknown"}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

async function accountsCommand(context, subcommand, rest, options) {
  switch (subcommand ?? "list") {
    case "providers":
    case "provider":
      listAccountProvidersCommand(context, options);
      return;
    case "list":
    case "ls":
      listAccountsCommand(context, options);
      return;
    case "add":
    case "connect":
      await addAccountCommand(context, rest[0], options);
      return;
    default:
      throw cliError(64, `Unknown accounts command: ${subcommand}. Try carta accounts list or carta accounts add gmail.`);
  }
}

function listAccountProvidersCommand(context, options) {
  const providers = accountProviderAvailability(context);
  writeJSONOrText(context.streams.stdout, options.json, { providers }, () => {
    return `${providers.map(provider => {
      const mode = provider.authType === "oauth" && provider.oauthMode ? ` (${provider.oauthMode})` : "";
      const status = provider.available ? `available${mode}` : `unavailable: ${provider.reason}`;
      return `${provider.id}  ${status}`;
    }).join("\n")}\n`;
  });
}

function listAccountsCommand(context, options) {
  const accounts = context.store.listAccounts().map(account => ({
    ...account,
    stats: context.store.accountEmailStats(account.id)
  }));
  writeJSONOrText(context.streams.stdout, options.json, { accounts }, () => {
    if (accounts.length === 0) return "No accounts connected yet.\n";
    return `${accounts.map(account => {
      const stats = account.stats ?? {};
      return `${account.id}  ${account.email}  ${account.provider}  ${account.status}  emails=${stats.totalCount ?? 0}`;
    }).join("\n")}\n`;
  });
}

async function addAccountCommand(context, provider, options) {
  const normalizedProvider = provider ?? options.provider;
  if (normalizedProvider === "gmail") {
    await addGmailCommand(context, options);
    return;
  }
  if (normalizedProvider === "icloud") {
    await addICloudCommand(context, options);
    return;
  }
  if (normalizedProvider === "imap") {
    await addIMAPCommand(context, options);
    return;
  }
  throw cliError(64, "Supported account providers today: gmail, icloud, imap.");
}

async function promptForAccountProvider(context, prompts) {
  const providers = accountProviderAvailability(context);
  const available = providers.filter(provider => provider.available);
  const gmail = providers.find(provider => provider.id === "gmail");
  if (gmail && !gmail.available) {
    write(context.streams.stdout, `Gmail is not enabled in this build yet: ${gmail.reason}.\n`);
  }
  const choices = available.map(provider => provider.id);
  if (choices.length === 0) {
    throw cliError(78, "No account providers are available in this build.");
  }
  const fallback = choices.includes("gmail") ? "gmail" : choices[0];
  return prompts.select("Which provider?", fallback, choices);
}

function accountProviderAvailability(context) {
  const settings = context.providers.getAuthSettings();
  const gmailReason = gmailOAuthUnavailableReason(settings);
  return [
    {
      id: "gmail",
      label: "Gmail",
      available: settings.gmailConfigured,
      reason: gmailReason,
      authType: "oauth",
      oauthMode: settings.gmailOAuthMode,
      oauthSource: settings.gmailOAuthSource,
      oauthSecretSource: settings.gmailOAuthSecretSource,
      relaySource: settings.gmailRelaySource,
      relayTokenSource: settings.gmailRelayTokenSource,
      relayConfigured: settings.gmailRelayConfigured
    },
    {
      id: "icloud",
      label: "iCloud",
      available: settings.icloudConfigured,
      reason: settings.icloudConfigured ? "" : "iCloud app-specific password support unavailable",
      authType: settings.icloudAuthType
    },
    {
      id: "imap",
      label: "IMAP/SMTP",
      available: settings.imapConfigured,
      reason: settings.imapConfigured ? "" : "IMAP/SMTP support unavailable",
      authType: settings.imapAuthType
    }
  ];
}

async function addGmailCommand(context, options) {
  const authSettings = context.providers.getAuthSettings();
  if (!authSettings.gmailConfigured) {
    throw gmailOAuthMissingError(authSettings);
  }

  const policy = syncPolicyFromOptions(context, options);
  const baseURL = gmailCallbackBaseURL(context.config, options);
  const listenHost = gmailCallbackListenHost(context.config, options);
  const callback = await startGmailCallbackServer(context, { baseURL, listenHost });
  try {
    const auth = await context.providers.startGmailAuth({
      displayName: options.name ?? options.displayName ?? "",
      syncHistory: policy.history.id !== "recent"
    }, { baseURL });

    write(context.streams.stdout, formatGmailAuthURL(context, auth.authorizationURL));
    if (options.open !== false && options["no-open"] !== true) {
      context.openBrowser(auth.authorizationURL).catch(() => {});
    }

    const result = await runWithProgress(context, "Waiting for Google sign-in to complete...", () => callback.wait(), options);
    writeSuccess(context, `Connected ${result.account.email}.`);
    await syncOneAccount(context, result.account, policy);
  } catch (error) {
    throw normalizeGmailOAuthError(error, {
      source: authSettings.gmailOAuthSource,
      redirectURI: `${baseURL.replace(/\/+$/u, "")}/api/auth/gmail/callback`
    });
  } finally {
    await callback.close();
  }
}

async function addICloudCommand(context, options) {
  const prompts = createPrompts(context.streams);
  try {
    const policy = syncPolicyFromOptions(context, options);
    const email = options.email ?? await prompts.text("iCloud email");
    const appPassword = options["app-password"] ?? options.password ?? await prompts.text("App-specific password");
    if (!options.username && !options["imap-username"] && context.streams.stdin.isTTY) {
      write(context.streams.stdout, "If this is an iCloud custom-domain address, use your actual Apple Account/iCloud email as the IMAP username.\n");
    }
    const username = options.username ?? options["imap-username"] ?? await prompts.text("IMAP username, if different", "");
    const displayName = options.name ?? options.displayName ?? await prompts.text("Display name", email);
    const result = await context.providers.connectICloud({
      email,
      appPassword,
      username,
      displayName,
      syncHistory: policy.history.id !== "recent"
    });
    writeSuccess(context, `Connected ${result.account.email}. Imported ${result.sync.imported} recent messages.`);
    await syncBackfill(context, result.account, policy);
  } finally {
    prompts.close();
  }
}

async function addIMAPCommand(context, options) {
  const prompts = createPrompts(context.streams);
  try {
    const policy = syncPolicyFromOptions(context, options);
    const email = options.email ?? await prompts.text("Email address");
    const password = options.password ?? options["imap-password"] ?? await prompts.text("IMAP password");
    const username = options.username ?? options["imap-username"] ?? await prompts.text("IMAP username", email);
    const imapHost = options["imap-host"] ?? await prompts.text("IMAP host");
    const imapPort = options["imap-port"] ?? await prompts.text("IMAP port", "993");
    const imapSecure = parseBoolean(options["imap-secure"], null)
      ?? await prompts.confirm("Use IMAP TLS?", String(imapPort) === "993");
    const smtpHost = options["smtp-host"] ?? await prompts.text("SMTP host");
    const smtpPort = options["smtp-port"] ?? await prompts.text("SMTP port", "587");
    const smtpSecure = parseBoolean(options["smtp-secure"], null)
      ?? await prompts.confirm("Use SMTP SSL?", String(smtpPort) === "465");
    const smtpUsername = options["smtp-username"] ?? await prompts.text("SMTP username", username);
    const smtpPassword = options["smtp-password"] ?? password;
    const displayName = options.name ?? options.displayName ?? await prompts.text("Display name", email);
    const result = await context.providers.connectIMAP({
      email,
      password,
      username,
      imapHost,
      imapPort,
      imapSecure,
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUsername,
      smtpPassword,
      displayName,
      archiveMailbox: options["archive-mailbox"],
      trashMailbox: options["trash-mailbox"],
      syncHistory: policy.history.id !== "recent"
    });
    writeSuccess(context, `Connected ${result.account.email}. Imported ${result.sync.imported} recent messages.`);
    await syncBackfill(context, result.account, policy);
  } finally {
    prompts.close();
  }
}

async function syncCommand(context, subcommand, rest, options) {
  const action = subcommand && subcommand !== "run" ? subcommand : "run";
  if (action === "status") {
    syncStatusCommand(context, options);
    return;
  }
  if (action !== "run") {
    throw cliError(64, `Unknown sync command: ${subcommand}. Try carta sync run or carta sync status.`);
  }
  if (rest.length > 0) {
    throw cliError(64, `Unexpected sync argument: ${rest[0]}`);
  }
  const accounts = resolveAccounts(context.store, options.account);
  const policy = syncPolicyFromOptions(context, options);
  const results = [];
  for (const account of accounts) {
    results.push(await syncOneAccount(context, account, policy, {
      quiet: options.json === true
    }));
  }
  if (options.json) {
    write(context.streams.stdout, `${JSON.stringify({ sync: results }, null, 2)}\n`);
  }
}

function syncStatusCommand(context, options) {
  const accounts = resolveAccounts(context.store, options.account).map(account => ({
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    status: account.status,
    syncHistory: account.syncHistory,
    lastSyncAt: account.lastSyncAt,
    stats: context.store.accountEmailStats(account.id),
    syncStatus: account.providerMetadata?.cartaSyncStatus ?? null
  }));
  writeJSONOrText(context.streams.stdout, options.json, { accounts }, () => {
    if (accounts.length === 0) return "No accounts connected yet.\n";
    return `${accounts.map(account => {
      const sync = account.syncStatus;
      const stats = account.stats ?? {};
      const syncLine = sync
        ? `sync=${sync.status} imported=${sync.imported ?? 0} oldest=${sync.oldestReceivedAt ?? stats.oldestReceivedAt ?? "none"}`
        : "sync=not-started";
      return `${account.email}  ${syncLine}  emails=${stats.totalCount ?? 0} unread=${stats.unreadCount ?? 0}`;
    }).join("\n")}\n`;
  });
}

async function syncOneAccount(context, account, policy, options = {}) {
  const current = context.store.getAccount(account.id);
  if (!current) throw cliError(404, `Account not found: ${account.id}`);
  if (current.status !== "connected") {
    throw cliError(400, `Account is not connected: ${current.email}`);
  }

  setAccountSyncStatus(context.store, current.id, {
    status: "running",
    historyWindow: policy.history.id,
    includeAttachments: policy.includeAttachments,
    imported: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  try {
    const sync = await runWithProgress(context, `Syncing recent mail for ${current.email} (up to ${policy.initialLimit} messages)...`, () => (
      context.providers.syncAccount(current.id, {
        limit: policy.initialLimit,
        quick: policy.quick
      })
    ), {
      ...options,
      progressText: () => accountSyncProgressText(context.store, current.id, "recent")
    });
    if (!options.quiet) {
      writeSuccess(context, `${current.email}: imported ${sync.imported} recent messages.`);
    }
    let backfill = null;
    if (!policy.quick) {
      backfill = await syncBackfill(context, current, policy, sync.imported ?? 0, options);
    }
    const totalImported = (sync.imported ?? 0) + (backfill?.imported ?? 0);
    const syncComplete = !backfill || backfill.complete !== false;
    setAccountSyncStatus(context.store, current.id, {
      status: syncComplete ? "complete" : "partial",
      imported: totalImported,
      error: null,
      completedAt: syncComplete ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    });
    return {
      accountId: current.id,
      email: current.email,
      provider: current.provider,
      imported: totalImported,
      recentImported: sync.imported ?? 0,
      backfill,
      status: syncComplete ? "complete" : "partial"
    };
  } catch (error) {
    setAccountSyncStatus(context.store, current.id, {
      status: "failed",
      error: error.message,
      updatedAt: new Date().toISOString()
    });
    throw error;
  }
}

async function syncBackfill(context, account, policy, alreadyImported = 0, options = {}) {
  if (policy.history.id === "recent") return null;
  let imported = 0;
  let complete = false;
  let batch = 0;
  let oldest = null;

  while (!complete) {
    batch += 1;
    const result = await runWithProgress(context, `${account.email}: backfill batch ${batch}, fetching up to ${policy.batchLimit} older messages...`, () => (
      context.providers.backfillAccountHistory(account.id, {
        limit: policy.batchLimit,
        includeAttachmentData: policy.includeAttachments
      })
    ), {
      ...options,
      progressText: () => accountSyncProgressText(context.store, account.id, `backfill ${batch}`)
    });
    imported += result.imported ?? 0;
    oldest = context.store.oldestEmailReceivedAt(account.id);
    const reachedWindow = policy.cutoffDate ? oldest && Date.parse(oldest) <= policy.cutoffDate.getTime() : false;
    complete = result.complete === true || reachedWindow || result.imported === 0;
    setAccountSyncStatus(context.store, account.id, {
      status: complete ? "complete" : "running",
      historyWindow: policy.history.id,
      includeAttachments: policy.includeAttachments,
      imported: alreadyImported + imported,
      backfilled: imported,
      oldestReceivedAt: oldest,
      updatedAt: new Date().toISOString()
    });
    if (!options.quiet) {
      writeSuccess(context, `${account.email}: backfill batch ${batch} imported=${result.imported ?? 0} oldest=${oldest ?? "none"}${reachedWindow ? " window-complete" : ""}`);
    }
    if (batch >= policy.maxBatches) {
      if (!options.quiet) {
        writeWarning(context, `${account.email}: stopped after ${policy.maxBatches} batches. Run carta sync again to continue.`);
      }
      break;
    }
  }

  return {
    imported,
    batches: batch,
    complete,
    oldestReceivedAt: oldest
  };
}

function searchCommand(context, terms, options) {
  const q = options.query ?? terms.join(" ").trim();
  const filters = emailQueryFilters(context, options, {
    q,
  });
  if (!filters.q && !hasNonPagingEmailFilter(filters)) {
    throw cliError(64, "Search query or at least one filter is required.");
  }
  const emails = context.store.listEmails(filters);
  writeJSONOrText(context.streams.stdout, options.json, { emails }, () => {
    if (emails.length === 0) return "No matching emails.\n";
    return `${emails.map(email => `${email.id}  ${email.receivedAt}  ${email.senderEmail}  ${email.subject}`).join("\n")}\n`;
  });
}

function listEmailsCommand(context, options) {
  const mailboxRole = normalizeMailboxRole(options.mailbox ?? options["mailbox-role"] ?? (options.all ? "all" : "inbox"));
  const emails = context.store.listEmails(emailQueryFilters(context, options, {
    mailboxRole: mailboxRole === "all" ? undefined : mailboxRole,
  }));
  writeJSONOrText(context.streams.stdout, options.json, { emails }, () => {
    if (emails.length === 0) return "No emails found.\n";
    return `${emails.map(email => {
      const readState = email.isRead ? "read" : "unread";
      return `${email.id}  ${email.receivedAt}  ${readState}  ${email.mailboxRole}  ${email.senderEmail}  ${email.subject}`;
    }).join("\n")}\n`;
  });
}

function fixturesCommand(context, subcommand, options) {
  if ((subcommand ?? "seed") !== "seed") {
    throw cliError(64, "Usage: carta fixtures seed [--preset agent-smoke] [--json]");
  }
  const result = context.store.seedFixtureData({
    preset: options.preset ?? "agent-smoke"
  });
  writeJSONOrText(context.streams.stdout, options.json, result, () => {
    return [
      `Seeded fixture preset ${result.preset}.`,
      `Accounts: ${result.accounts.map(account => `${account.email} (${account.provider})`).join(", ")}`,
      `Emails: ${result.emails.length}`
    ].join("\n") + "\n";
  });
}

function showCommand(context, id, options) {
  if (!id) throw cliError(64, "Email id is required.");
  const email = context.store.getEmail(id);
  if (!email) throw cliError(404, "Email not found.");
  writeJSONOrText(context.streams.stdout, options.json, { email }, () => {
    return [
      `From: ${email.senderName} <${email.senderEmail}>`,
      `To: ${(email.recipients ?? []).join(", ")}`,
      `Subject: ${email.subject}`,
      `Date: ${email.receivedAt}`,
      "",
      email.bodyText || email.snippet || ""
    ].join("\n") + "\n";
  });
}

async function emailActionCommand(context, action, id, options) {
  if (!id) throw cliError(64, `Email id is required. Usage: carta ${action} EMAIL_ID`);
  const current = context.store.getEmail(id);
  if (!current) throw cliError(404, "Email not found.");

  let email;
  let providerPromise;
  switch (action) {
    case "archive":
      email = context.store.archiveEmail(id);
      providerPromise = context.providers.archiveEmail(current);
      break;
    case "trash":
      email = context.store.trashEmail(id);
      providerPromise = context.providers.trashEmail(current);
      break;
    case "spam":
      email = context.store.markEmailSpam(id);
      providerPromise = context.providers.markEmailSpam(current);
      break;
    case "mark-read":
      email = context.store.updateEmail(id, { isRead: true });
      providerPromise = context.providers.updateEmailReadStatus(current, true);
      break;
    case "mark-unread":
      email = context.store.updateEmail(id, { isRead: false });
      providerPromise = context.providers.updateEmailReadStatus(current, false);
      break;
    default:
      throw cliError(64, `Unsupported email action: ${action}`);
  }

  let provider = null;
  try {
    provider = await providerPromise;
  } catch (error) {
    provider = {
      status: "failed",
      error: error.message
    };
  }

  const payload = { action, email, provider };
  writeJSONOrText(context.streams.stdout, options.json, payload, () => {
    const providerStatus = provider?.status ? ` provider=${provider.status}` : "";
    const providerError = provider?.error ? ` (${provider.error})` : "";
    return `${action} ${email.id} local=${email.mailboxRole}${providerStatus}${providerError}\n`;
  });
}

async function sendCommand(context, options) {
  const account = resolveSingleAccount(context.store, options.account, "sending mail");
  const input = {
    accountId: account.id,
    to: parseAddressListOption(options.to),
    cc: parseAddressListOption(options.cc),
    bcc: parseAddressListOption(options.bcc),
    subject: options.subject,
    bodyText: bodyTextFromOptions(options, context.cwd),
    bodyHTML: options.html ?? options["body-html"] ?? null,
    attachments: attachmentsFromOptions(options, context.cwd),
    replyToEmailID: options["reply-to"] ?? options.replyToEmailID ?? options.replyToEmailId,
    trackOpens: options["track-opens"] !== false && options.trackOpens !== false
  };
  if (input.to.length === 0 && !input.replyToEmailID) {
    throw cliError(64, "At least one recipient is required. Pass --to or use carta reply EMAIL_ID.");
  }
  await sendMessageFromCLI(context, input, options);
}

async function replyCommand(context, id, options) {
  if (!id) throw cliError(64, "Reply target email id is required. Usage: carta reply EMAIL_ID --body \"...\"");
  const target = context.store.getEmail(id);
  if (!target) throw cliError(404, "Reply target not found.");
  const input = {
    accountId: target.accountId,
    to: parseAddressListOption(options.to, [target.senderEmail]),
    cc: parseAddressListOption(options.cc),
    bcc: parseAddressListOption(options.bcc),
    subject: options.subject ?? replySubject(target.subject),
    bodyText: bodyTextFromOptions(options, context.cwd),
    bodyHTML: options.html ?? options["body-html"] ?? null,
    attachments: attachmentsFromOptions(options, context.cwd),
    replyToEmailID: target.id,
    trackOpens: options["track-opens"] !== false && options.trackOpens !== false
  };
  await sendMessageFromCLI(context, input, options);
}

async function forwardCommand(context, id, options) {
  if (!id) throw cliError(64, "Forward target email id is required. Usage: carta forward EMAIL_ID --to you@example.com --body \"...\"");
  const source = context.store.getEmail(id);
  if (!source) throw cliError(404, "Forward target not found.");
  const account = options.account
    ? resolveSingleAccount(context.store, options.account, "forwarding mail")
    : context.store.getAccount(source.accountId);
  const includeOriginalAttachments = options["include-attachments"] === true
    || options["include-original-attachments"] === true
    || options.attachments === "original";
  let originalAttachments = [];
  if (includeOriginalAttachments) {
    await context.providers.ensureEmailAttachments(source);
    originalAttachments = attachmentCopiesForEmail(context.store, source.id);
  }
  const input = {
    accountId: account.id,
    to: parseAddressListOption(options.to),
    cc: parseAddressListOption(options.cc),
    bcc: parseAddressListOption(options.bcc),
    subject: options.subject ?? forwardSubject(source.subject),
    bodyText: forwardBodyText(source, bodyTextFromOptions(options, context.cwd)),
    bodyHTML: options.html ?? options["body-html"] ?? null,
    attachments: [
      ...attachmentsFromOptions(options, context.cwd),
      ...originalAttachments
    ],
    trackOpens: options["track-opens"] !== false && options.trackOpens !== false
  };
  if (input.to.length === 0) {
    throw cliError(64, "At least one recipient is required. Pass --to when forwarding.");
  }
  await sendMessageFromCLI(context, input, options);
}

async function sendMessageFromCLI(context, input, options) {
  const email = context.store.sendMessage(input);
  let provider = null;
  try {
    provider = await context.providers.sendMessage(email, input);
    if (provider?.status === "sent") {
      context.store.markOutboundSent(email.outboundId, provider.providerUID);
    }
  } catch (error) {
    context.store.markOutboundFailed(email.outboundId, error);
    provider = {
      status: "failed",
      error: error.message
    };
  }
  const saved = context.store.getEmail(email.id);
  const payload = {
    email: {
      ...saved,
      outboundId: email.outboundId
    },
    provider
  };
  writeJSONOrText(context.streams.stdout, options.json, payload, () => {
    const providerStatus = provider?.status ? ` provider=${provider.status}` : "";
    const providerError = provider?.error ? ` (${provider.error})` : "";
    return `sent ${saved.id} local=queued${providerStatus}${providerError}\n`;
  });
}

async function serverCommand(context, subcommand, _rest = [], options = {}) {
  switch (subcommand) {
    case "start":
      context.start();
      await new Promise(resolve => {
        const shutdown = signal => {
          write(context.streams.stdout, `Received ${signal}, shutting down.\n`);
          context.close(resolve);
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      return;
    case "install":
      await installServerLaunchAgent(context, options);
      return;
    case "status":
      await serverLaunchAgentStatusCommand(context, options);
      return;
    case "restart":
      await restartServerLaunchAgent(context, options);
      return;
    case "uninstall":
      await uninstallServerLaunchAgent(context, options);
      return;
    default:
      throw cliError(64, "Usage: carta server start|install|status|restart|uninstall");
  }
}

async function installServerLaunchAgent(context, options) {
  const agent = await buildLaunchAgent(context, options);
  if (options["dry-run"]) {
    writeJSONOrText(context.streams.stdout, options.json, { launchAgent: agent }, () => formatLaunchAgentDryRun(agent));
    return;
  }
  assertLaunchAgentSupported();
  mkdirSync(dirname(agent.plistPath), { recursive: true });
  mkdirSync(agent.logDir, { recursive: true });
  writeFileSync(agent.plistPath, agent.plist, { mode: 0o644 });
  await launchctlBootout(context, agent).catch(() => {});
  const launchctlNotes = [];
  const bootstrapNote = await launchctlBootstrap(context, agent);
  if (bootstrapNote) launchctlNotes.push(bootstrapNote);
  const kickstartNote = await launchctlKickstart(context, agent);
  if (kickstartNote) launchctlNotes.push(kickstartNote);
  const status = await readLaunchAgentStatus(context, agent);
  const health = await waitForServerHealth(launchAgentHealthURL(context.config), { attempts: 8, delayMs: 500 });
  writeJSONOrText(context.streams.stdout, options.json, {
    launchAgent: {
      ...agent,
      loaded: status.loaded,
      status: status.status,
      launchctlNotes
    },
    health
  }, () => [
    `Installed Carta CLI server LaunchAgent: ${agent.plistPath}`,
    `Label: ${agent.label}`,
    `Logs: ${agent.logDir}`,
    `Server: ${effectiveServerBaseURL(context.config)}`,
    `Health: ${health.ok ? "ok" : `unreachable (${health.error ?? health.status})`}`,
    ...launchctlNotes.map(note => `Launchd note: ${note}`),
    ""
  ].join("\n"));
}

async function serverLaunchAgentStatusCommand(context, options) {
  const agent = await buildLaunchAgent(context, options);
  const status = await readLaunchAgentStatus(context, agent);
  const payload = {
    launchAgent: {
      ...agent,
      loaded: status.loaded,
      status: status.status,
      detail: status.detail
    },
    health: options.check ? await checkServerHealth(`${effectiveServerBaseURL(context.config)}/api/health`) : null
  };
  writeJSONOrText(context.streams.stdout, options.json, payload, () => formatLaunchAgentStatus(payload));
}

async function restartServerLaunchAgent(context, options) {
  const agent = await buildLaunchAgent(context, options);
  assertLaunchAgentSupported();
  if (!existsSync(agent.plistPath)) {
    throw cliError(78, `Carta CLI server LaunchAgent is not installed. Run carta server install first.`);
  }
  const status = await readLaunchAgentStatus(context, agent);
  if (!status.loaded) {
    await launchctlBootstrap(context, agent);
  }
  const launchctlNote = await launchctlKickstart(context, agent);
  const health = await waitForServerHealth(launchAgentHealthURL(context.config), { attempts: 8, delayMs: 500 });
  writeJSONOrText(context.streams.stdout, options.json, {
    launchAgent: {
      ...agent,
      restarted: true,
      launchctlNotes: launchctlNote ? [launchctlNote] : []
    },
    health
  }, () => [
    `Restarted Carta CLI server LaunchAgent: ${agent.label}`,
    `Health: ${health.ok ? "ok" : `unreachable (${health.error ?? health.status})`}`,
    launchctlNote ? `Launchd note: ${launchctlNote}` : null,
    ""
  ].filter(Boolean).join("\n"));
}

async function uninstallServerLaunchAgent(context, options) {
  const agent = await buildLaunchAgent(context, options);
  if (options["dry-run"]) {
    writeJSONOrText(context.streams.stdout, options.json, { launchAgent: agent, removed: false }, () => (
      `Would uninstall Carta CLI server LaunchAgent: ${agent.plistPath}\n`
    ));
    return;
  }
  assertLaunchAgentSupported();
  await launchctlBootout(context, agent).catch(() => {});
  if (existsSync(agent.plistPath)) {
    unlinkSync(agent.plistPath);
  }
  writeJSONOrText(context.streams.stdout, options.json, { launchAgent: agent, removed: true }, () => (
    `Uninstalled Carta CLI server LaunchAgent: ${agent.label}\n`
  ));
}

async function buildLaunchAgent(context, options = {}) {
  const paths = launchAgentPaths(context);
  const program = await resolveCartaExecutable(options);
  const domain = launchAgentDomain(context, options);
  const environmentVariables = launchAgentEnvironment(context);
  const programArguments = [program, "server", "start"];
  const agent = {
    label: CLI_LAUNCH_AGENT_LABEL,
    domain,
    serviceTarget: `${domain}/${CLI_LAUNCH_AGENT_LABEL}`,
    plistPath: paths.plistPath,
    logDir: paths.logDir,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    program,
    programArguments,
    environmentVariables
  };
  return {
    ...agent,
    plist: renderLaunchAgentPlist(agent)
  };
}

function launchAgentPaths(context) {
  const home = context.env.HOME || process.env.HOME;
  if (!home) {
    throw cliError(78, "Cannot install a LaunchAgent because HOME is not set.");
  }
  const logDir = join(home, "Library", "Logs", "CartaCLI");
  return {
    plistPath: join(home, "Library", "LaunchAgents", `${CLI_LAUNCH_AGENT_LABEL}.plist`),
    logDir,
    stdoutPath: join(logDir, "server.log"),
    stderrPath: join(logDir, "server.error.log")
  };
}

function launchAgentEnvironment(context) {
  const env = {
    PATH: context.env.CARTA_LAUNCH_AGENT_PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    CARTA_CLI: "1",
    CARTA_DATA_DIR: context.config.dataDir,
    CARTA_USE_STORED_SERVER_ACCESS: "1",
    EMAIL_AUTO_SYNC: context.env.EMAIL_AUTO_SYNC ?? "1",
    EMAIL_AUTO_HISTORY_BACKFILL: context.env.EMAIL_AUTO_HISTORY_BACKFILL ?? "1"
  };
  const defaultDatabasePath = join(context.config.dataDir, "mail.sqlite");
  if (context.config.databasePath !== defaultDatabasePath) {
    env.EMAIL_DATABASE_PATH = context.config.databasePath;
  }
  for (const key of [
    "CARTA_RELAY_BASE_URL",
    "CARTA_RELAY_TOKEN",
    "EMAIL_RELAY_BASE_URL",
    "EMAIL_RELAY_TOKEN",
    "CARTA_GOOGLE_OAUTH_CLIENT_ID",
    "CARTA_GOOGLE_OAUTH_CLIENT_SECRET",
    "CARTA_DEFAULT_GOOGLE_OAUTH_CLIENT_ID",
    "CARTA_DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET",
    "CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH"
  ]) {
    if (String(context.env[key] ?? "").trim()) {
      env[key] = context.env[key];
    }
  }
  return env;
}

async function resolveCartaExecutable(options = {}) {
  if (options.bin) return resolve(String(options.bin));
  if (process.env.CARTA_BIN) return resolve(process.env.CARTA_BIN);
  const current = process.argv[1] ? resolve(process.argv[1]) : "";
  if (current && existsSync(current) && ["carta", "carta.js"].includes(basename(current))) {
    return current;
  }
  for (const candidate of ["/opt/homebrew/bin/carta", "/usr/local/bin/carta"]) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileOutput("/usr/bin/which", ["carta"], { timeout: 1000 });
    const found = stdout.trim();
    if (found) return found;
  } catch {
    // Fall through to the PATH-based value below. The install command will still
    // show the generated plist in dry-run mode so the user can correct --bin.
  }
  return "carta";
}

function launchAgentDomain(context, options = {}) {
  const uid = options.uid ?? context.env.UID ?? process.getuid?.();
  if (uid === undefined || uid === null || uid === "") {
    throw cliError(78, "Cannot determine the launchd user id for this LaunchAgent.");
  }
  return `gui/${uid}`;
}

function renderLaunchAgentPlist(agent) {
  const environment = Object.entries(agent.environmentVariables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `    <key>${escapePlist(key)}</key>\n    <string>${escapePlist(value)}</string>`)
    .join("\n");
  const programArguments = agent.programArguments
    .map(value => `    <string>${escapePlist(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(agent.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(agent.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(agent.stderrPath)}</string>
</dict>
</plist>
`;
}

async function readLaunchAgentStatus(context, agent) {
  if (process.platform !== "darwin") {
    return { loaded: false, status: "unsupported", detail: "LaunchAgents are only available on macOS." };
  }
  try {
    const { stdout } = await context.launchctl(["print", agent.serviceTarget]);
    return { loaded: true, status: "loaded", detail: stdout.trim() };
  } catch (error) {
    return { loaded: false, status: existsSync(agent.plistPath) ? "installed-not-loaded" : "not-installed", detail: error.stderr || error.message };
  }
}

function formatLaunchAgentDryRun(agent) {
  return [
    `LaunchAgent: ${agent.label}`,
    `Plist: ${agent.plistPath}`,
    `Command: ${agent.programArguments.join(" ")}`,
    `Logs: ${agent.logDir}`,
    "",
    agent.plist
  ].join("\n");
}

function formatLaunchAgentStatus(payload) {
  const agent = payload.launchAgent;
  const lines = [
    `LaunchAgent: ${agent.label}`,
    `Status: ${agent.status}`,
    `Loaded: ${agent.loaded ? "yes" : "no"}`,
    `Plist: ${agent.plistPath}`,
    `Command: ${agent.programArguments.join(" ")}`
  ];
  if (payload.health) {
    lines.push(`Health: ${payload.health.ok ? "ok" : `unreachable (${payload.health.error ?? payload.health.status})`}`);
  }
  return `${lines.join("\n")}\n`;
}

async function launchctlBootout(context, agent) {
  await context.launchctl(["bootout", agent.domain, agent.plistPath]);
}

async function launchctlBootstrap(context, agent) {
  try {
    await context.launchctl(["bootstrap", agent.domain, agent.plistPath]);
    return null;
  } catch (error) {
    const status = await readLaunchAgentStatus(context, agent);
    if (status.loaded) {
      return `bootstrap reported ${launchctlErrorSummary(error)}, but ${agent.label} is already loaded.`;
    }
    throw error;
  }
}

async function launchctlKickstart(context, agent) {
  try {
    await context.launchctl(["kickstart", "-k", agent.serviceTarget]);
    return null;
  } catch (error) {
    const verification = await verifyLaunchAgentStarted(context, agent);
    if (verification.ok) {
      return `kickstart reported ${launchctlErrorSummary(error)}, but ${agent.label} is running.`;
    }
    throw error;
  }
}

async function verifyLaunchAgentStarted(context, agent) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const status = await readLaunchAgentStatus(context, agent);
    if (launchAgentStatusIsRunning(status)) {
      return { ok: true, status };
    }
    await delay(250);
  }
  const status = await readLaunchAgentStatus(context, agent);
  return { ok: launchAgentStatusIsRunning(status), status };
}

function launchAgentStatusIsRunning(status) {
  return Boolean(status?.loaded && /\bstate\s*=\s*running\b/u.test(status.detail ?? ""));
}

async function waitForServerHealth(url, { attempts = 3, delayMs = 300 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await checkServerHealth(url);
    if (last.ok) return last;
    if (attempt < attempts - 1) await delay(delayMs);
  }
  return last;
}

function launchAgentHealthURL(config) {
  return `http://${formatHealthHost(config.host)}:${config.port}/api/health`;
}

function formatHealthHost(host) {
  const value = String(host || "127.0.0.1").trim();
  if (!value || value === "0.0.0.0" || value === "::") return "127.0.0.1";
  if (value.includes(":") && !value.startsWith("[")) return `[${value}]`;
  return value;
}

function launchctlErrorSummary(error) {
  const detail = String(error?.stderr || error?.stdout || error?.message || "an error").trim();
  return detail.replace(/\s+/gu, " ");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertLaunchAgentSupported() {
  if (process.platform !== "darwin") {
    throw cliError(78, "LaunchAgent install is only available on macOS. Use carta server start on this platform.");
  }
}

function escapePlist(value) {
  return escapeHTML(String(value ?? ""));
}

async function doctorCommand(context, options) {
  const settings = context.providers.getAuthSettings();
  const access = serverAccessFromStore(context.store);
  const tailscale = await context.detectTailscale({ port: context.config.port }).catch(error => ({
    installed: false,
    available: false,
    state: "error",
    error: error.message
  }));
  const checks = {
    node: process.version,
    database: context.config.databasePath,
    server: effectiveServerBaseURL(context.config),
    serverAccess: formatAccessSummary(access),
    serverAccessSecurity: connectionSecurity(access).summary,
    serverAccessWarning: connectionSecurity(access).warning,
    tailscale: formatTailscaleSummary(tailscale),
    relay: relayStatus(settings),
    gmailOAuth: gmailOAuthStatus(settings),
    gmailOAuthAction: gmailOAuthAction(settings),
    iCloud: settings.icloudConfigured ? "available" : "unavailable"
  };
  writeJSONOrText(context.streams.stdout, options.json, { checks }, () => {
    const lines = [
      ["Node", checks.node],
      ["Database", checks.database],
      ["Server", checks.server],
      ["Server access", checks.serverAccess],
      ["Server access security", checks.serverAccessSecurity],
      ["Tailscale", checks.tailscale],
      ["Relay", checks.relay],
      ["Gmail OAuth", checks.gmailOAuth],
      ["iCloud", checks.iCloud]
    ].map(([name, value]) => `${name}: ${value}`);
    if (!settings.gmailConfigured) {
      lines.push(`Gmail OAuth action: ${checks.gmailOAuthAction}`);
    }
    if (checks.serverAccessWarning) {
      lines.push(`Server access warning: ${checks.serverAccessWarning}`);
    }
    return `${lines.join("\n")}\n`;
  });
}

async function startGmailCallbackServer(context, { baseURL, listenHost }) {
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolveCallback, rejectCallback) => {
    resolveResult = resolveCallback;
    rejectResult = rejectCallback;
  });
  const expectedPath = new URL(`${baseURL.replace(/\/+$/u, "")}/api/auth/gmail/callback`).pathname;
  const expectedRelayPath = new URL(`${baseURL.replace(/\/+$/u, "")}/api/auth/gmail/relay/callback`).pathname;
  const server = createHTTPServer(async (req, res) => {
    const url = new URL(req.url ?? "/", baseURL);
    if (url.pathname !== expectedPath && url.pathname !== expectedRelayPath) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    try {
      const result = url.pathname === expectedRelayPath
        ? req.method === "POST"
          ? await context.providers.completeGmailRelayAuth(await readCallbackBody(req))
          : await context.providers.completeGmailRelayCodeAuth(Object.fromEntries(url.searchParams.entries()))
        : await context.providers.completeGmailAuth(Object.fromEntries(url.searchParams.entries()));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      res.end("<!doctype html><title>Carta Email</title><h1>Gmail connected</h1><p>You can return to the terminal.</p>");
      resolveResult(result);
    } catch (error) {
      res.writeHead(error.status ?? 500, { "content-type": "text/html; charset=utf-8", connection: "close" });
      res.end(`<!doctype html><title>Carta Email</title><h1>Gmail connection failed</h1><p>${escapeHTML(error.message)}</p>`);
      rejectResult(error);
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", error => {
      if (error.code === "EADDRINUSE") {
        rejectListen(cliError(78, `Port ${context.config.port} is already in use. Stop the existing Carta process or run setup with --server-port PORT.`));
        return;
      }
      rejectListen(error);
    });
    server.listen(context.config.port, listenHost, resolveListen);
  });

  const timeout = setTimeout(() => {
    rejectResult(cliError(408, "Timed out waiting for Gmail authorization."));
  }, 10 * 60 * 1000);

  return {
    wait: async () => {
      try {
        return await resultPromise;
      } finally {
        clearTimeout(timeout);
      }
    },
    close: () => new Promise(resolveClose => {
      server.close(resolveClose);
      server.closeAllConnections?.();
    })
  };
}

function syncPolicyFromOptions(context, options) {
  const historySetting = context.store.getSetting(SETTING_SYNC_WINDOW, DEFAULT_HISTORY_WINDOW);
  const history = normalizeHistoryWindow(options.history ?? options.window ?? historySetting);
  const includeAttachments = parseBoolean(options.attachments, null)
    ?? (context.store.getSetting(SETTING_SYNC_ATTACHMENTS, "1") === "1");
  const initialLimit = clampInt(options["initial-limit"] ?? options.limit, 1, 5000, DEFAULT_INITIAL_LIMIT);
  const batchLimit = clampInt(options["batch-limit"], 1, 5000, DEFAULT_BATCH_LIMIT);
  const maxBatches = clampInt(options["max-batches"], 1, 10000, history.all ? 10000 : 100);
  const cutoffDate = history.all ? null : cutoffForHistory(history);
  return {
    history,
    includeAttachments,
    initialLimit,
    batchLimit,
    maxBatches,
    quick: options.quick === true,
    cutoffDate
  };
}

function gmailOAuthUnavailableReason(settings = {}) {
  if (settings.gmailConfigured) return "";
  if (settings.gmailClientIdConfigured && !settings.gmailClientSecretConfigured) {
    return "missing matching Google OAuth Desktop client secret";
  }
  return "missing Carta relay URL or Google OAuth Desktop credentials";
}

function relayStatus(settings = {}) {
  if (settings.gmailRelayConfigured) {
    return `configured (${settings.gmailRelaySource})`;
  }
  if (settings.gmailRelayBaseURLConfigured && !settings.gmailRelayTokenConfigured) {
    return `missing token (${settings.gmailRelaySource})`;
  }
  if (!settings.gmailRelayBaseURLConfigured && settings.gmailRelayTokenConfigured) {
    return `missing base URL (${settings.gmailRelayTokenSource})`;
  }
  return "not configured";
}

function gmailOAuthStatus(settings = {}) {
  if (settings.gmailRelayConfigured) {
    return `configured (relay via ${settings.gmailRelaySource})`;
  }
  if (settings.gmailConfigured) {
    return `configured (desktop via ${settings.gmailOAuthSource})`;
  }
  return gmailOAuthUnavailableReason(settings);
}

function gmailOAuthAction(settings = {}) {
  if (settings.gmailConfigured) return "ready";
  if (settings.gmailClientIdConfigured && !settings.gmailClientSecretConfigured) {
    return "set CARTA_RELAY_BASE_URL for relay OAuth, or set CARTA_GOOGLE_OAUTH_CLIENT_SECRET for direct local Desktop OAuth testing";
  }
  return "set CARTA_RELAY_BASE_URL for custom relay OAuth; developers may use CARTA_GOOGLE_OAUTH_CLIENT_ID and CARTA_GOOGLE_OAUTH_CLIENT_SECRET for direct local testing";
}

function gmailOAuthMissingError(settings = {}) {
  if (settings.gmailClientIdConfigured && !settings.gmailClientSecretConfigured) {
    return cliError(78, [
      "Gmail is missing the matching Google OAuth Desktop client secret.",
      "Google Desktop app OAuth clients include a client secret by design; it is embedded in installed apps and is not a confidential web-server secret.",
      "For production, use the bundled Carta relay so Google secrets stay on the relay. Set CARTA_GOOGLE_OAUTH_CLIENT_SECRET only for local direct-OAuth testing."
    ].join(" "));
  }
  return cliError(78, [
    "Gmail is not enabled in this Carta CLI build yet.",
    "Set CARTA_RELAY_BASE_URL to use a custom OAuth relay.",
    "Developers can also set CARTA_GOOGLE_OAUTH_CLIENT_ID and CARTA_GOOGLE_OAUTH_CLIENT_SECRET to test direct Desktop OAuth locally."
  ].join(" "));
}

function normalizeGmailOAuthError(error, { source, redirectURI }) {
  const message = String(error?.message ?? error ?? "");
  if (/client_secret.*missing/iu.test(message)) {
    return cliError(error.status ?? 78, [
      "Google says this OAuth client requires its Desktop client secret.",
      "That is normal for Google Desktop app OAuth clients; the companion secret is embedded in installed apps and is not a confidential web-server secret.",
      "Add the matching Desktop client secret from the downloaded OAuth JSON as CARTA_GOOGLE_OAUTH_CLIENT_SECRET for local testing.",
      "Do not use a Web application client secret."
    ].join(" "));
  }
  if (/redirect_uri_mismatch/iu.test(message)) {
    return cliError(error.status ?? 78, [
      "Google rejected the Gmail sign-in redirect URI for this OAuth client.",
      `Redirect URI used: ${redirectURI}.`,
      source === "bundled"
        ? "The bundled Carta Google OAuth client needs this loopback redirect added or the packaged client ID updated."
        : "For development, add this exact redirect URI to the Google OAuth client or use the packaged Carta client."
    ].join(" "));
  }
  if (/access_denied|unverified|app.*blocked/iu.test(message)) {
    return cliError(error.status ?? 78, [
      "Google rejected this Gmail sign-in because the OAuth app is not approved for the requested Gmail scopes.",
      "Carta needs a verified Google OAuth app before Gmail can be distributed broadly."
    ].join(" "));
  }
  return error;
}

function normalizeAccessMode(value, publicURL = null) {
  if (value === undefined || value === null || value === "") {
    return publicURL ? "open-port" : null;
  }
  if (value === false) return "local";
  const mode = String(value).trim().toLowerCase();
  if (["tailscale", "tailnet", "ts"].includes(mode)) return "tailscale";
  if (["local", "local-only", "localhost", "none", "off"].includes(mode)) return "local";
  if (["open-port", "public", "insecure", "wan", "0.0.0.0"].includes(mode)) return "open-port";
  throw cliError(64, `Unknown server access mode: ${value}. Use tailscale, local-only, or open-port.`);
}

function normalizePort(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(65535, Math.max(0, parsed));
}

function refreshContextServerAccess(context) {
  replaceContextConfig(context, applyStoredRelay(
    applyStoredServerAccess(context.config, context.store, context.env),
    context.store,
    context.secretStore
  ));
}

function refreshContextRelay(context) {
  replaceContextConfig(context, applyStoredRelay(context.config, context.store, context.secretStore));
}

function replaceContextConfig(context, config) {
  context.config = config;
  if (context.providers) context.providers.config = config;
  if (context.pushNotifications?.relay) context.pushNotifications.relay.config = config.relay ?? {};
}

async function tailscaleServerAccess(context, { explicitPublicURL, options, port, tailscale }) {
  if (explicitPublicURL) {
    const publicBaseURL = normalizeBaseURL(explicitPublicURL);
    const host = options["server-host"] ?? (tailscalePublicURLUsesHTTPS(publicBaseURL, tailscale) ? "127.0.0.1" : tailscale.ip ?? "0.0.0.0");
    return { host, publicBaseURL };
  }

  if (tailscale.serveURL) {
    return {
      host: options["server-host"] ?? "127.0.0.1",
      publicBaseURL: normalizeBaseURL(tailscale.serveURL),
      serveProxy: `${normalizeBaseURL(tailscale.serveURL)} -> http://127.0.0.1:${port}`
    };
  }

  if (options["no-tailscale-serve"] || options["no-serve"]) {
    return tailscaleDirectHTTPAccess(tailscale, port, options);
  }

  const httpsPort = normalizePort(options["tailscale-https-port"] ?? options["https-port"] ?? "8443", 8443);
  try {
    await context.configureTailscaleServe({
      port,
      httpsPort,
      targetHost: "127.0.0.1"
    });
    const updated = await context.detectTailscale({ port });
    if (updated?.serveURL) {
      return {
        host: options["server-host"] ?? "127.0.0.1",
        publicBaseURL: normalizeBaseURL(updated.serveURL),
        serveProxy: `${normalizeBaseURL(updated.serveURL)} -> http://127.0.0.1:${port}`
      };
    }
    const host = tailscale.dnsName || tailscale.ip;
    if (host) {
      const publicBaseURL = normalizeBaseURL(`https://${host}${httpsPort === 443 ? "" : `:${httpsPort}`}`);
      return {
        host: options["server-host"] ?? "127.0.0.1",
        publicBaseURL,
        serveProxy: `${publicBaseURL} -> http://127.0.0.1:${port}`
      };
    }
  } catch (error) {
    const fallback = tailscaleDirectHTTPAccess(tailscale, port, options);
    return {
      ...fallback,
      warning: `could not configure Tailscale Serve HTTPS (${launchctlErrorSummary(error)}); using direct tailnet HTTP.`
    };
  }

  return tailscaleDirectHTTPAccess(tailscale, port, options);
}

function tailscalePublicURLUsesHTTPS(publicBaseURL, tailscale) {
  try {
    const parsed = new URL(publicBaseURL);
    const tailscaleHost = String(tailscale.dnsName ?? "").toLowerCase();
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === tailscaleHost.toLowerCase();
  } catch {
    return false;
  }
}

function tailscaleDirectHTTPAccess(tailscale, port, options) {
  return {
    host: options["server-host"] ?? tailscale.ip ?? "0.0.0.0",
    publicBaseURL: normalizeBaseURL(tailscalePublicBaseURL(tailscale, port))
  };
}

function tailscalePublicBaseURL(tailscale, port) {
  if (tailscale.serveURL) return tailscale.serveURL;
  const host = tailscale.dnsName || tailscale.ip;
  if (!host) {
    throw cliError(69, "Tailscale is ready but no tailnet DNS name or IP address was found.");
  }
  return `http://${host}:${port}`;
}

function formatAccessSummary(access) {
  if (!access) return "local";
  if (access.mode === "tailscale") {
    const target = access.publicBaseURL || access.tailscaleDNSName || access.tailscaleIP || "configured";
    return `tailscale (${target})`;
  }
  if (access.mode === "open-port") {
    return access.publicBaseURL ? `open-port (${access.publicBaseURL})` : "open-port";
  }
  return "local only";
}

function connectionSecurity(access) {
  if (access?.mode === "open-port") {
    return {
      summary: "user-managed network security",
      warning: "open-port mode has no extra Carta API authentication; only use it behind your own firewall, VPN, or reverse proxy."
    };
  }
  if (access?.mode === "tailscale") {
    return {
      summary: "protected by Tailscale/private tailnet",
      warning: ""
    };
  }
  return {
    summary: "local-only loopback",
    warning: ""
  };
}

function formatTailscaleSummary(tailscale) {
  if (!tailscale?.installed) return "not installed";
  if (!tailscale.available) {
    return tailscale.state || tailscale.error ? `not ready (${tailscale.state || tailscale.error})` : "not ready";
  }
  const target = tailscale.serveURL || tailscale.dnsName || tailscale.ip || "available";
  return `available (${target})`;
}

async function checkServerHealth(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      url,
      body
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      url,
      error: error.name === "AbortError" ? "timeout" : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function setAccountSyncStatus(store, accountId, patch) {
  const account = store.getAccount(accountId);
  if (!account) return;
  store.updateAccountMetadata(accountId, {
    cartaSyncStatus: {
      ...(account.providerMetadata?.cartaSyncStatus ?? {}),
      ...patch
    }
  });
}

function accountSyncProgressText(store, accountId, phase = "") {
  const account = store.getAccount(accountId);
  if (!account) return phase || "";
  const stats = store.accountEmailStats(accountId);
  const sync = account.providerMetadata?.cartaSyncStatus ?? {};
  const parts = [];
  if (phase) parts.push(phase);
  if (Number.isFinite(Number(sync.imported)) && Number(sync.imported) > 0) {
    parts.push(`imported=${sync.imported}`);
  }
  parts.push(`emails=${stats.totalCount ?? 0}`);
  parts.push(`unread=${stats.unreadCount ?? 0}`);
  const oldest = sync.oldestReceivedAt ?? stats.oldestReceivedAt;
  if (oldest) parts.push(`oldest=${shortDate(oldest)}`);
  return parts.join(" ");
}

function resolveAccounts(store, identifier) {
  const accounts = store.listAccounts();
  if (!identifier || identifier === "all") return accounts;
  const account = accounts.find(item => item.id === identifier || item.email === identifier);
  if (!account) throw cliError(404, `Account not found: ${identifier}`);
  return [account];
}

function resolveAccountId(store, identifier) {
  if (!identifier) return null;
  return resolveAccounts(store, identifier)[0].id;
}

function emailQueryFilters(context, options, base = {}) {
  return {
    ...base,
    accountId: resolveAccountId(context.store, options.account),
    limit: Number.parseInt(options.limit ?? "20", 10),
    offset: Number.parseInt(options.offset ?? "0", 10),
    unread: options.unread === true ? true : undefined,
    sender: options.from ?? options.sender,
    since: parseDateOption(options.since ?? options.after),
    until: parseDateOption(options.until ?? options.before),
    hasAttachments: options["has-attachments"] ?? options.attachments,
    attachmentKind: options["attachment-kind"] ?? options.attachmentKind
  };
}

function hasNonPagingEmailFilter(filters) {
  return Boolean(
    filters.accountId
      || filters.mailboxRole
      || filters.unread
      || filters.sender
      || filters.since
      || filters.until
      || filters.hasAttachments !== undefined
      || filters.attachmentKind
  );
}

function resolveSingleAccount(store, identifier, purpose) {
  if (identifier) return resolveAccounts(store, identifier)[0];
  const accounts = store.listAccounts();
  if (accounts.length === 1) return accounts[0];
  if (accounts.length === 0) {
    throw cliError(404, `No accounts connected yet. Add an account before ${purpose}.`);
  }
  throw cliError(64, `Multiple accounts are connected. Pass --account EMAIL or --account ID before ${purpose}.`);
}

function normalizeMailboxRole(value) {
  const role = String(value ?? "inbox").toLowerCase();
  if (["all", "inbox", "sent", "drafts", "archive", "spam", "blocked", "trash"].includes(role)) {
    return role;
  }
  throw cliError(64, `Unknown mailbox: ${value}. Use inbox, sent, drafts, archive, spam, blocked, trash, or all.`);
}

function parseAddressListOption(value, fallback = []) {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value)) return value.flatMap(item => parseAddressListOption(item));
  return String(value)
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function bodyTextFromOptions(options, cwd = process.cwd()) {
  if (options["body-file"]) {
    if (options["body-file"] === "-") {
      throw cliError(64, "Reading message bodies from stdin is not supported yet. Pass --body or --body-file PATH.");
    }
    return readFileSync(resolve(cwd, String(options["body-file"])), "utf8");
  }
  return String(options.body ?? options.text ?? "");
}

function replySubject(subject) {
  const value = String(subject ?? "").trim();
  if (!value) return "Re: (No subject)";
  return /^re:/iu.test(value) ? value : `Re: ${value}`;
}

function forwardSubject(subject) {
  const value = String(subject ?? "").trim();
  if (!value) return "Fwd: (No subject)";
  return /^fwd?:/iu.test(value) ? value : `Fwd: ${value}`;
}

function forwardBodyText(source, intro = "") {
  return [
    intro,
    "",
    "---------- Forwarded message ---------",
    `From: ${source.senderName} <${source.senderEmail}>`,
    `Date: ${source.receivedAt}`,
    `Subject: ${source.subject}`,
    `To: ${(source.recipients ?? []).join(", ")}`,
    "",
    source.bodyText || source.snippet || ""
  ].join("\n").trimStart();
}

function attachmentsFromOptions(options, cwd = process.cwd()) {
  const paths = optionValues(options.attach ?? options.attachment).flatMap(value => {
    return String(value).split(",").map(item => item.trim()).filter(Boolean);
  });
  return paths.map(path => attachmentFromPath(path, cwd));
}

function attachmentCopiesForEmail(store, emailId) {
  const email = store.getEmail(emailId);
  const attachments = email?.attachments ?? [];
  return attachments.map(attachment => {
    const full = store.getAttachment(emailId, attachment.id);
    if (!full?.data) {
      throw cliError(409, `Attachment ${attachment.filename} is not downloaded locally.`);
    }
    return {
      filename: full.filename,
      mimeType: full.mimeType,
      disposition: full.disposition ?? "attachment",
      isInline: full.isInline,
      contentId: full.contentId,
      data: full.data
    };
  });
}

function attachmentFromPath(path, cwd = process.cwd()) {
  const absolute = resolve(cwd, path);
  const data = readFileSync(absolute);
  return {
    filename: basename(absolute),
    mimeType: mimeTypeForPath(absolute),
    disposition: "attachment",
    isInline: false,
    data
  };
}

function mimeTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}

function optionValues(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeHistoryWindow(value) {
  const key = String(value ?? DEFAULT_HISTORY_WINDOW).toLowerCase();
  const window = HISTORY_WINDOWS.get(key);
  if (!window) {
    throw cliError(64, `Unknown history window: ${value}. Use 6-months, last-year, 2-years, 5-years, or all.`);
  }
  return window;
}

function cutoffForHistory(history) {
  const date = new Date();
  if (history.months) {
    date.setMonth(date.getMonth() - history.months);
  }
  if (history.years) {
    date.setFullYear(date.getFullYear() - history.years);
  }
  return date;
}

function gmailCallbackBaseURL(config, options = {}) {
  if (options["callback-url"]) {
    return String(options["callback-url"]).replace(/\/+$/u, "");
  }
  if (options["use-public-callback"] && config.publicBaseURL) {
    return config.publicBaseURL.replace(/\/+$/u, "");
  }
  return `http://127.0.0.1:${config.port}`;
}

function gmailCallbackListenHost(config, options = {}) {
  if (!options["callback-url"] && !options["use-public-callback"]) {
    return "127.0.0.1";
  }
  return config.host === "0.0.0.0" ? "0.0.0.0" : config.host;
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--no-")) {
      options[arg.slice(5)] = false;
      options[`no-${arg.slice(5)}`] = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [rawKey, rawValue] = arg.slice(2).split("=", 2);
      if (rawValue !== undefined) {
        setOption(options, rawKey, rawValue);
      } else if (argv[index + 1] && !argv[index + 1].startsWith("-")) {
        setOption(options, rawKey, argv[index + 1]);
        index += 1;
      } else {
        setOption(options, rawKey, true);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { options, positionals };
}

function setOption(options, key, value) {
  if (options[key] === undefined) {
    options[key] = value;
  } else if (Array.isArray(options[key])) {
    options[key].push(value);
  } else {
    options[key] = [options[key], value];
  }
}

function createPrompts(streams) {
  const rl = createInterface({ input: streams.stdin, output: streams.stdout });
  return {
    text: async (label, fallback = "") => {
      if (!streams.stdin.isTTY) return fallback;
      const suffix = fallback ? ` [${fallback}]` : "";
      const answer = await rl.question(`${label}${suffix}: `);
      return answer.trim() || fallback;
    },
    confirm: async (label, fallback = true) => {
      if (!streams.stdin.isTTY) return fallback;
      const answer = await rl.question(`${label} [${fallback ? "Y/n" : "y/N"}]: `);
      if (!answer.trim()) return fallback;
      return ["y", "yes", "true", "1"].includes(answer.trim().toLowerCase());
    },
    select: async (label, fallback, choices) => {
      if (!streams.stdin.isTTY) return fallback;
      write(streams.stdout, `${label}\n`);
      choices.forEach((choice, index) => write(streams.stdout, `  ${index + 1}. ${choice}\n`));
      const answer = await rl.question(`Choose [${fallback}]: `);
      if (!answer.trim()) return fallback;
      const numeric = Number.parseInt(answer, 10);
      if (Number.isInteger(numeric) && choices[numeric - 1]) return choices[numeric - 1];
      return answer.trim();
    },
    close: () => rl.close()
  };
}

function prepareEnv(inputEnv, cwd) {
  const env = { ...inputEnv };
  if (!env.CARTA_CLI) env.CARTA_CLI = "1";
  if (env.CARTA_CLI === "1" && env.CARTA_PUBLIC_BASE_URL === undefined && env.EMAIL_PUBLIC_BASE_URL === undefined) {
    env.CARTA_PUBLIC_BASE_URL = "";
    env.EMAIL_PUBLIC_BASE_URL = "";
  }
  const envPath = resolve(cwd, ".env");
  const shouldLoadDotEnv = env.CARTA_CLI !== "1" || env.CARTA_LOAD_DOTENV === "1";
  if (shouldLoadDotEnv && existsSync(envPath)) {
    for (const [key, value] of Object.entries(readEnvFile(envPath))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  if (env.CARTA_DATA_DIR && !env.EMAIL_DATA_DIR) env.EMAIL_DATA_DIR = env.CARTA_DATA_DIR;
  if (env.CARTA_SERVER_HOST && !env.EMAIL_SERVER_HOST) env.EMAIL_SERVER_HOST = env.CARTA_SERVER_HOST;
  if (env.CARTA_SERVER_PORT && !env.EMAIL_SERVER_PORT) env.EMAIL_SERVER_PORT = env.CARTA_SERVER_PORT;
  if (env.CARTA_PUBLIC_BASE_URL && !env.EMAIL_PUBLIC_BASE_URL) env.EMAIL_PUBLIC_BASE_URL = env.CARTA_PUBLIC_BASE_URL;
  return env;
}

function readEnvFile(path) {
  const values = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([^=]+)=(.*)$/u);
    if (!match) continue;
    values[match[1].trim()] = unquote(match[2].trim());
  }
  return values;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function writeJSONOrText(stdout, json, payload, textFactory) {
  if (json) {
    write(stdout, `${JSON.stringify(payload, null, 2)}\n`);
  } else {
    write(stdout, textFactory());
  }
}

function write(stdout, text) {
  stdout.write(text);
}

async function runWithProgress(context, message, task, options = {}) {
  if (options.quiet) {
    return task();
  }
  writeProgress(context, message);
  if (!prettyOutput(context)) {
    return task();
  }
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const seconds = Math.max(3, Math.round((Date.now() - startedAt) / 1000));
    write(context.streams.stdout, `  ${style(context, "muted", progressHeartbeatText(options, seconds))}\n`);
  }, 3000);
  interval.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(interval);
  }
}

function progressHeartbeatText(options, seconds) {
  if (typeof options.progressText === "function") {
    const detail = String(options.progressText(seconds) ?? "").trim();
    if (detail) return `Still working... ${seconds}s (${detail})`;
  }
  return `Still working... ${seconds}s`;
}

function writeProgress(context, text) {
  write(context.streams.stdout, `${statusPrefix(context, "sync")}${text}\n`);
}

function writeSuccess(context, text) {
  write(context.streams.stdout, `${statusPrefix(context, "ok")}${text}\n`);
}

function writeWarning(context, text) {
  write(context.streams.stdout, `${statusPrefix(context, "warn")}${text}\n`);
}

function statusPrefix(context, kind) {
  if (!prettyOutput(context)) return "";
  const color = kind === "ok" ? "green" : kind === "warn" ? "yellow" : "cyan";
  return `${style(context, color, `[${kind}]`)} `;
}

function prettyOutput(context) {
  return Boolean(context?.streams?.stdout?.isTTY)
    && context.env?.NO_COLOR === undefined
    && process.env.NO_COLOR === undefined
    && context.env?.TERM !== "dumb";
}

function style(context, name, text) {
  if (!prettyOutput(context)) return String(text);
  const codes = {
    bold: ["\x1b[1m", "\x1b[22m"],
    muted: ["\x1b[2m", "\x1b[22m"],
    green: ["\x1b[32m", "\x1b[39m"],
    cyan: ["\x1b[36m", "\x1b[39m"],
    yellow: ["\x1b[33m", "\x1b[39m"],
    red: ["\x1b[31m", "\x1b[39m"]
  };
  const [open = "", close = ""] = codes[name] ?? [];
  return `${open}${text}${close}`;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseDateOption(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const relative = text.match(/^(\d+)\s*(d|day|days|h|hour|hours)$/iu);
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const date = new Date();
    if (unit.startsWith("h")) {
      date.setHours(date.getHours() - amount);
    } else {
      date.setDate(date.getDate() - amount);
    }
    return date.toISOString();
  }
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf())) {
    throw cliError(64, `Invalid date: ${value}. Use an ISO date or relative value like 7d.`);
  }
  return date.toISOString();
}

function shortDate(value) {
  const text = String(value ?? "");
  return text.includes("T") ? text.slice(0, 10) : text;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function detectTailscale({ port = null } = {}) {
  let stdout = "";
  try {
    ({ stdout } = await execFileOutput("tailscale", ["status", "--json"], { timeout: 3000 }));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        installed: false,
        available: false,
        state: "not-installed",
        error: "tailscale command not found"
      };
    }
    return {
      installed: true,
      available: false,
      state: "unavailable",
      error: error.stderr || error.message
    };
  }

  let status;
  try {
    status = JSON.parse(stdout);
  } catch (error) {
    return {
      installed: true,
      available: false,
      state: "invalid-status",
      error: error.message
    };
  }

  const self = status.Self ?? {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter(Boolean) : [];
  const ip = ips.find(value => /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) ?? ips[0] ?? "";
  const dnsName = String(self.DNSName ?? "").replace(/\.+$/u, "");
  const state = status.BackendState ?? (self.Online === false ? "offline" : "Running");
  const available = Boolean(ip || dnsName)
    && self.Online !== false
    && !["NeedsLogin", "Stopped", "NoState"].includes(String(state));

  const serveURL = Number.isFinite(Number(port))
    ? await detectTailscaleServeURL(Number(port)).catch(() => "")
    : "";

  return {
    installed: true,
    available,
    state,
    hostName: self.HostName ?? "",
    dnsName,
    ip,
    ips,
    serveURL
  };
}

async function detectTailscaleServeURL(port) {
  const { stdout } = await execFileOutput("tailscale", ["serve", "status", "--json"], { timeout: 3000 });
  const status = JSON.parse(stdout);
  const web = status.Web && typeof status.Web === "object" ? status.Web : {};
  for (const [hostPort, site] of Object.entries(web)) {
    const handlers = site?.Handlers && typeof site.Handlers === "object" ? site.Handlers : {};
    for (const handler of Object.values(handlers)) {
      if (handler?.Proxy && proxyTargetsPort(handler.Proxy, port)) {
        return tailscaleServeURL(hostPort, status);
      }
    }
  }
  return "";
}

async function configureTailscaleServe({ port, httpsPort = 8443, targetHost = "127.0.0.1" }) {
  await execFileOutput("tailscale", [
    "serve",
    "--bg",
    `--https=${httpsPort}`,
    `http://${targetHost}:${port}`
  ], { timeout: 10000 });
}

function proxyTargetsPort(proxy, port) {
  try {
    const parsed = new URL(proxy);
    const proxyPort = Number.parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80"), 10);
    return proxyPort === port;
  } catch {
    return String(proxy).includes(`:${port}`);
  }
}

function tailscaleServeURL(hostPort, status) {
  const [host, rawPort = "443"] = String(hostPort).split(":");
  const https = status.TCP?.[rawPort]?.HTTPS === true;
  const scheme = https ? "https" : "http";
  const suffix = https && rawPort === "443" ? "" : `:${rawPort}`;
  return `${scheme}://${host}${suffix}`;
}

function execFileOutput(file, args, options = {}) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(file, args, {
      timeout: options.timeout ?? 5000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectExec(error);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });
}

function launchctl(args) {
  return execFileOutput("launchctl", args, { timeout: 5000, maxBuffer: 1024 * 1024 });
}

function openBrowser(url) {
  return new Promise((resolveOpen, rejectOpen) => {
    execFile("open", [url], error => {
      if (error) rejectOpen(error);
      else resolveOpen();
    });
  });
}

function quietLogger() {
  return {
    log() {},
    warn() {},
    error() {}
  };
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function readCallbackBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  return JSON.parse(text);
}

function cliError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function helpText() {
  return `Carta email CLI

Usage:
  carta init [--name NAME] [--email EMAIL] [--history last-year] [--attachments true]
  carta setup [--expose tailscale|local-only|open-port] [--public-url URL] [--install-server] [--allow-insecure-open-port]
  carta status [--json]
  carta reset [--yes] [--all|--keep-relay false] [--dry-run] [--json]
  carta connection [--check] [--json]
  carta relay status [--json]
  carta relay configure --url https://relay.example.com --token TOKEN [--json]
  carta relay clear [--json]
  carta profile [--name NAME] [--email EMAIL] [--json]
  carta accounts providers [--json]
  carta accounts list [--json]
  carta accounts add gmail [--history last-year] [--attachments true]
  carta accounts add icloud --email you@icloud.com --app-password xxxx-xxxx-xxxx-xxxx [--imap-username apple-id@icloud.com]
  carta accounts add imap --email you@example.com --imap-host imap.example.com --smtp-host smtp.example.com
  carta sync run [--account all|EMAIL|ID] [--history last-year|all] [--quick] [--json]
  carta sync status [--account all|EMAIL|ID] [--json]
  carta list [--mailbox inbox|sent|archive|trash|all] [--from NAME] [--since 7d] [--unread] [--json]
  carta search "invoice from stripe" [--from NAME] [--since 7d] [--has-attachments] [--attachment-kind invoice] [--json]
  carta show EMAIL_ID [--json]
  carta send --account EMAIL --to you@example.com --subject "Hi" --body "..." [--attach file.pdf] [--json]
  carta reply EMAIL_ID --body "..." [--attach file.pdf] [--json]
  carta forward EMAIL_ID --to you@example.com --body "..." [--include-attachments] [--json]
  carta archive EMAIL_ID [--json]
  carta trash EMAIL_ID [--json]
  carta spam EMAIL_ID [--json]
  carta mark-read EMAIL_ID [--json]
  carta mark-unread EMAIL_ID [--json]
  carta fixtures seed [--preset agent-smoke] [--json]
  carta server start
  carta server install [--dry-run] [--json]
  carta server status [--check] [--json]
  carta server restart
  carta server uninstall
  carta doctor [--json]

History windows: 6-months, last-year, 2-years, 5-years, all.
`;
}
