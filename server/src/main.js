import { resolveConfig, validateRuntimeConfig } from "./config.js";
import { RequestAuthenticator } from "./auth.js";
import { BackgroundSyncService } from "./backgroundSync.js";
import { createServer } from "./http.js";
import { maybeEncryptedSecretStore } from "./encryption.js";
import { ProviderService } from "./providerAdapters.js";
import { PushNotificationService } from "./pushNotifications.js";
import { FileSecretStore, KeychainSecretStore, PostgresSecretStore } from "./secretStore.js";
import { PostgresMailStore } from "./postgresStore.js";
import { MailStore } from "./store.js";

const config = resolveConfig();
validateRuntimeConfig(config);
const store = storeForRuntime(config);
const baseURL = config.publicBaseURL ?? `http://${config.host}:${config.port}`;
const secretStore = maybeEncryptedSecretStore(secretStoreForRuntime(config), config);
const providers = new ProviderService({
  store,
  config,
  baseURL,
  secretStore
});
const pushNotifications = new PushNotificationService({ store, config });
const authenticator = new RequestAuthenticator(config);
const { server, events } = createServer({
  store,
  providers,
  pushNotifications,
  authenticator,
  host: config.host,
  port: config.port,
  publicBaseURL: config.publicBaseURL
});
const backgroundSync = new BackgroundSyncService({
  store,
  providers,
  pushNotifications,
  events,
  intervalMs: config.backgroundSyncIntervalMs,
  limit: config.backgroundSyncLimit
});

server.listen(config.port, config.host, () => {
  console.log(`Email server listening at http://${config.host}:${config.port}`);
  console.log(`Storage: ${store.storageName ?? "sqlite"} ${store.databasePath}`);
  backgroundSync.start();
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  backgroundSync.stop();
  server.close(async () => {
    store.close();
    await secretStore.close?.();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function secretStoreForRuntime(config) {
  const requested = config.secretStore || (process.platform === "darwin" ? "keychain" : "file");
  if (requested === "file") {
    return new FileSecretStore({ path: config.secretStorePath });
  }
  if (requested === "postgres") {
    if (!config.secretEncryptionKey) {
      throw new Error("EMAIL_SECRET_ENCRYPTION_KEY is required when EMAIL_SECRET_STORE=postgres.");
    }
    return new PostgresSecretStore({ connectionString: config.postgresURL });
  }
  if (requested === "keychain") {
    return new KeychainSecretStore();
  }
  throw new Error(`Unsupported EMAIL_SECRET_STORE: ${requested}`);
}

function storeForRuntime(config) {
  if (config.storage === "postgres") {
    return new PostgresMailStore({
      connectionString: config.postgresURL,
      supabaseURL: config.supabaseURL,
      supabaseServiceRoleKey: config.supabaseServiceRoleKey,
      attachmentBucket: config.attachmentBucket
    });
  }
  if (config.storage === "sqlite") {
    return new MailStore({
      databasePath: config.databasePath,
      seedDemo: config.seedDemo
    });
  }
  throw new Error(`Unsupported EMAIL_STORAGE: ${config.storage}`);
}
