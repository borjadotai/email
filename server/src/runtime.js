import { resolveConfig } from "./config.js";
import { createServer } from "./http.js";
import { InboxTriageService } from "./inboxTriage.js";
import { ProviderService } from "./providerAdapters.js";
import { PushNotificationService, summarizePushNotificationResult } from "./pushNotifications.js";
import { applyStoredRelay } from "./relayConfig.js";
import { createDefaultSecretStore } from "./secretStore.js";
import { applyStoredServerAccess, effectiveServerBaseURL } from "./serverAccess.js";
import { MailStore } from "./store.js";

const SETTING_SYNC_WINDOW = "carta.sync.window";

export function createMailRuntime({
  env = process.env,
  config = resolveConfig(env),
  store = null,
  secretStore = null,
  logger = console,
  platform = process.platform
} = {}) {
  const mailStore = store ?? new MailStore({
    databasePath: config.databasePath,
    seedDemo: config.seedDemo
  });
  const runtimeSecretStore = secretStore ?? createDefaultSecretStore({
    env,
    dataDir: config.dataDir,
    platform
  });
  const accessConfig = env.CARTA_CLI === "1" || env.CARTA_USE_STORED_SERVER_ACCESS === "1"
    ? applyStoredServerAccess(config, mailStore, env)
    : config;
  const runtimeConfig = applyStoredRelay(accessConfig, mailStore, runtimeSecretStore);
  const baseURL = effectiveServerBaseURL(runtimeConfig);
  const providers = new ProviderService({
    store: mailStore,
    config: runtimeConfig,
    baseURL,
    secretStore: runtimeSecretStore
  });
  const pushNotifications = new PushNotificationService({ store: mailStore, config: runtimeConfig });
  const inboxTriage = new InboxTriageService({ store: mailStore });
  const { server, events, providerMutations } = createServer({
    store: mailStore,
    providers,
    pushNotifications,
    inboxTriage,
    host: runtimeConfig.host,
    port: runtimeConfig.port,
    publicBaseURL: runtimeConfig.publicBaseURL
  });

  let historyBackfillRunning = false;
  let historyBackfillTimer = null;
  let historyBackfillStartupTimer = null;
  let autoSyncRunning = false;
  let autoSyncTimer = null;
  let autoSyncStartupTimer = null;
  let started = false;
  let closing = false;
  let closed = false;

  async function runHistoryBackfillPass() {
    if (closing || historyBackfillRunning) return;
    historyBackfillRunning = true;
    try {
      for (const account of mailStore.listAccounts()) {
        if (closing) break;
        const current = mailStore.getAccount(account.id);
        if (!current?.syncHistory || historyBackfillComplete(current)) continue;
        try {
          logger.log(`${new Date().toISOString()} history backfill started account=${current.id}`);
          updateHistoryBackfillStatus(mailStore, current.id, {
            status: "running",
            historyWindow: mailStore.getSetting?.(SETTING_SYNC_WINDOW, "all") ?? "all",
            includeAttachments: false,
            startedAt: current.providerMetadata?.cartaSyncStatus?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          events.emit("accounts.changed", { accountId: current.id, backfilled: true });
          const result = await providers.backfillAccountHistory(current.id, {
            limit: runtimeConfig.historyBackfillLimit
          });
          providerMutations.wake();
          if (closing) break;
          logger.log(`${new Date().toISOString()} history backfill completed account=${current.id} imported=${result.imported} complete=${result.complete}`);
          const latest = mailStore.getAccount(current.id);
          const previousStatus = latest?.providerMetadata?.cartaSyncStatus ?? {};
          const imported = Number(previousStatus.imported ?? 0) + Number(result.imported ?? 0);
          const backfilled = Number(previousStatus.backfilled ?? 0) + Number(result.imported ?? 0);
          const complete = result.complete === true || (latest ? historyBackfillComplete(latest) : false);
          updateHistoryBackfillStatus(mailStore, current.id, {
            status: complete ? "complete" : "running",
            historyWindow: previousStatus.historyWindow ?? mailStore.getSetting?.(SETTING_SYNC_WINDOW, "all") ?? "all",
            includeAttachments: previousStatus.includeAttachments ?? false,
            imported,
            backfilled,
            oldestReceivedAt: mailStore.oldestEmailReceivedAt(current.id),
            error: null,
            completedAt: complete ? new Date().toISOString() : null,
            updatedAt: new Date().toISOString()
          });
          events.emit("accounts.changed", { accountId: current.id, backfilled: true });
          if (result.imported > 0) {
            events.emit("emails.changed", { accountId: current.id, backfilled: true });
          }
        } catch (error) {
          updateHistoryBackfillStatus(mailStore, current.id, {
            status: "failed",
            error: error.message,
            updatedAt: new Date().toISOString()
          });
          events.emit("accounts.changed", { accountId: current.id, backfilled: true });
          logger.warn(`${new Date().toISOString()} history backfill failed account=${current.id}: ${error.message}`);
        }
      }
    } finally {
      historyBackfillRunning = false;
    }
  }

  async function runAutoSyncPass() {
    if (closing || autoSyncRunning) return;
    autoSyncRunning = true;
    try {
      for (const account of mailStore.listAccounts()) {
        if (closing) break;
        const current = mailStore.getAccount(account.id);
        if (!current || current.status !== "connected") continue;

        try {
          const sync = await providers.syncAccount(current.id, {
            limit: runtimeConfig.autoSyncLimit,
            quick: true
          });
          providerMutations.wake();
          if (closing) break;
          const newEmailCount = Array.isArray(sync.newEmails)
            ? sync.newEmails.length
            : Array.isArray(sync.newEmailIds)
              ? sync.newEmailIds.length
              : 0;
          if ((sync.imported ?? 0) > 0 || newEmailCount > 0) {
            logger.log(`${new Date().toISOString()} auto sync account=${current.id} provider=${sync.provider} imported=${sync.imported ?? 0} new=${newEmailCount}`);
          }
          if (sync.imported > 0) {
            events.emit("emails.changed", { accountId: current.id, autoSync: true });
          }
          await sendPushNotifications(sync.newEmails);
          prefetchInboxTriage();
        } catch (error) {
          logger.warn(`${new Date().toISOString()} auto sync failed account=${current.id}: ${error.message}`);
        }
      }
    } finally {
      autoSyncRunning = false;
    }
  }

  async function sendPushNotifications(newEmails = []) {
    if (!Array.isArray(newEmails) || newEmails.length === 0) return;
    try {
      const result = await pushNotifications.sendNewEmailNotifications(newEmails);
      if (result.sent > 0 || result.skipped > 0) {
        logger.log(`${new Date().toISOString()} push notifications ${summarizePushNotificationResult(result)}`);
      }
    } catch (error) {
      logger.warn(`${new Date().toISOString()} push notifications failed: ${error.message}`);
    }
  }

  function prefetchInboxTriage() {
    try {
      inboxTriage.prefetchIfUseful();
    } catch (error) {
      logger.warn(`${new Date().toISOString()} inbox triage prefetch failed: ${error.message}`);
    }
  }

  function start() {
    if (started || closing) return;
    started = true;
    server.listen(runtimeConfig.port, runtimeConfig.host, () => {
      logger.log(`Email server listening at http://${runtimeConfig.host}:${runtimeConfig.port}`);
      if (runtimeConfig.publicBaseURL) {
        logger.log(`Public server URL: ${runtimeConfig.publicBaseURL}`);
      }
      logger.log(`SQLite database: ${runtimeConfig.databasePath}`);
      const contactIndex = mailStore.startDeferredContactIndexRebuild({
        logger: message => logger.log(`${new Date().toISOString()} ${message}`)
      });
      if (contactIndex.started) {
        logger.log(`${new Date().toISOString()} contact index rebuild scheduled total=${contactIndex.total}`);
      }
    });

    if (runtimeConfig.autoHistoryBackfill) {
      const intervalMs = Number.isFinite(runtimeConfig.historyBackfillIntervalMs)
        ? Math.max(10_000, runtimeConfig.historyBackfillIntervalMs)
        : 60_000;
      historyBackfillTimer = setInterval(runHistoryBackfillPass, intervalMs);
      historyBackfillStartupTimer = setTimeout(runHistoryBackfillPass, 5_000);
    }

    if (runtimeConfig.autoSync) {
      const intervalMs = Number.isFinite(runtimeConfig.autoSyncIntervalMs)
        ? Math.max(15_000, runtimeConfig.autoSyncIntervalMs)
        : 60_000;
      autoSyncTimer = setInterval(runAutoSyncPass, intervalMs);
      autoSyncStartupTimer = setTimeout(runAutoSyncPass, 10_000);
    }

    providerMutations.start();
  }

  function close(callback = null) {
    closing = true;
    providerMutations.stop();
    if (historyBackfillTimer) {
      clearInterval(historyBackfillTimer);
      historyBackfillTimer = null;
    }
    if (historyBackfillStartupTimer) {
      clearTimeout(historyBackfillStartupTimer);
      historyBackfillStartupTimer = null;
    }
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }
    if (autoSyncStartupTimer) {
      clearTimeout(autoSyncStartupTimer);
      autoSyncStartupTimer = null;
    }
    const finish = async () => {
      await waitForBackgroundWorkToStop({
        isBusy: () => historyBackfillRunning || autoSyncRunning || providerMutations.isRunning()
      });
      if (!closed) {
        mailStore.close();
        closed = true;
      }
      callback?.();
    };
    if (started) {
      server.close(() => {
        finish().catch(error => {
          logger.warn(`Failed to stop Carta runtime cleanly: ${error.message}`);
          callback?.();
        });
      });
      started = false;
      return;
    }
    finish().catch(error => {
      logger.warn(`Failed to stop Carta runtime cleanly: ${error.message}`);
      callback?.();
    });
  }

  return {
    config: runtimeConfig,
    store: mailStore,
    secretStore: runtimeSecretStore,
    providers,
    pushNotifications,
    inboxTriage,
    providerMutations,
    server,
    events,
    start,
    close,
    runHistoryBackfillPass,
    runAutoSyncPass
  };
}

async function waitForBackgroundWorkToStop({
  isBusy,
  timeoutMs = 4500,
  intervalMs = 50
}) {
  const startedAt = Date.now();
  while (isBusy()) {
    if (Date.now() - startedAt >= timeoutMs) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function updateHistoryBackfillStatus(store, accountId, patch) {
  const account = store.getAccount(accountId);
  if (!account) return;
  store.updateAccountMetadata(accountId, {
    cartaSyncStatus: {
      ...(account.providerMetadata?.cartaSyncStatus ?? {}),
      ...patch
    }
  });
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
  if (account.provider === "imap") {
    return account.providerMetadata.imapBackfillComplete === true
      && account.providerMetadata.imapSystemBackfillComplete === true;
  }
  return true;
}
