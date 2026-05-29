import { resolveConfig } from "./config.js";
import { createServer } from "./http.js";
import { ProviderService } from "./providerAdapters.js";
import { PushNotificationService } from "./pushNotifications.js";
import { KeychainSecretStore } from "./secretStore.js";
import { MailStore } from "./store.js";

const config = resolveConfig();
const store = new MailStore({
  databasePath: config.databasePath,
  seedDemo: config.seedDemo
});
const baseURL = config.publicBaseURL ?? `http://${config.host}:${config.port}`;
const providers = new ProviderService({
  store,
  config,
  baseURL,
  secretStore: new KeychainSecretStore()
});
const pushNotifications = new PushNotificationService({ store, config });
const { server, events } = createServer({
  store,
  providers,
  pushNotifications,
  host: config.host,
  port: config.port,
  publicBaseURL: config.publicBaseURL
});

server.listen(config.port, config.host, () => {
  console.log(`Email server listening at http://${config.host}:${config.port}`);
  console.log(`SQLite database: ${config.databasePath}`);
});

let historyBackfillRunning = false;
let historyBackfillTimer = null;

if (config.autoHistoryBackfill) {
  const intervalMs = Number.isFinite(config.historyBackfillIntervalMs)
    ? Math.max(10_000, config.historyBackfillIntervalMs)
    : 60_000;
  historyBackfillTimer = setInterval(runHistoryBackfillPass, intervalMs);
  setTimeout(runHistoryBackfillPass, 5_000);
}

async function runHistoryBackfillPass() {
  if (historyBackfillRunning) return;
  historyBackfillRunning = true;
  try {
    for (const account of store.listAccounts()) {
      const current = store.getAccount(account.id);
      if (!current?.syncHistory || historyBackfillComplete(current)) continue;
      try {
        console.log(`${new Date().toISOString()} history backfill started account=${current.id}`);
        const result = await providers.backfillAccountHistory(current.id, {
          limit: config.historyBackfillLimit
        });
        console.log(`${new Date().toISOString()} history backfill completed account=${current.id} imported=${result.imported} complete=${result.complete}`);
        events.emit("accounts.changed", { accountId: current.id, backfilled: true });
        if (result.imported > 0) {
          events.emit("emails.changed", { accountId: current.id, backfilled: true });
        }
      } catch (error) {
        console.warn(`${new Date().toISOString()} history backfill failed account=${current.id}: ${error.message}`);
      }
    }
  } finally {
    historyBackfillRunning = false;
  }
}

function historyBackfillComplete(account) {
  if (account.provider === "gmail") {
    return account.providerMetadata.gmailBackfillComplete === true
      && account.providerMetadata.gmailSystemBackfillComplete === true;
  }
  if (account.provider === "icloud") {
    return account.providerMetadata.icloudBackfillComplete === true
      && account.providerMetadata.icloudSystemBackfillComplete === true;
  }
  return true;
}

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  if (historyBackfillTimer) {
    clearInterval(historyBackfillTimer);
  }
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
