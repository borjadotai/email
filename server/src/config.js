import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GOOGLE_OAUTH_CLIENT_ID, DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET } from "./oauthDefaults.js";

const DEFAULT_RELAY_BASE_URL = "https://carta-email-relay.vercel.app";

export function resolveConfig(env = process.env) {
  const port = Number.parseInt(env.EMAIL_SERVER_PORT ?? "7331", 10);
  const dataDir = env.EMAIL_DATA_DIR ?? join(homedir(), "Library", "Application Support", "EmailApp");
  const googleOAuth = resolveGoogleOAuth(env);
  const relay = resolveRelay(env);
  mkdirSync(dataDir, { recursive: true });

  return {
    host: env.EMAIL_SERVER_HOST ?? "127.0.0.1",
    port: Number.isFinite(port) ? port : 7331,
    dataDir,
    databasePath: env.EMAIL_DATABASE_PATH ?? join(dataDir, "mail.sqlite"),
    googleOAuthClientId: googleOAuth.clientId,
    googleOAuthClientSecret: googleOAuth.clientSecret,
    googleOAuthClientSource: googleOAuth.source,
    googleOAuthClientSecretSource: googleOAuth.secretSource,
    relay,
    initialSyncLimit: Number.parseInt(env.EMAIL_INITIAL_SYNC_LIMIT ?? "500", 10),
    historyBackfillLimit: Number.parseInt(env.EMAIL_HISTORY_BACKFILL_LIMIT ?? "500", 10),
    historyBackfillIntervalMs: Number.parseInt(env.EMAIL_HISTORY_BACKFILL_INTERVAL_MS ?? "60000", 10),
    autoHistoryBackfill: env.EMAIL_AUTO_HISTORY_BACKFILL !== "0",
    autoSync: env.EMAIL_AUTO_SYNC === "1",
    autoSyncIntervalMs: Number.parseInt(env.EMAIL_AUTO_SYNC_INTERVAL_MS ?? "60000", 10),
    autoSyncLimit: Number.parseInt(env.EMAIL_AUTO_SYNC_LIMIT ?? "50", 10),
    seedDemo: env.EMAIL_SEED_DEMO === "1",
    publicBaseURL: env.EMAIL_PUBLIC_BASE_URL?.trim() || undefined,
    apns: {
      keyId: env.APNS_KEY_ID ?? "",
      teamId: env.APNS_TEAM_ID ?? "",
      privateKey: env.APNS_PRIVATE_KEY ?? "",
      privateKeyPath: env.APNS_PRIVATE_KEY_PATH ?? "",
      environment: env.APNS_ENVIRONMENT === "production" ? "production" : "development",
      iosTopic: env.APNS_IOS_TOPIC ?? "com.borjadotai.email.ios",
      macosTopic: env.APNS_MACOS_TOPIC ?? "com.borjadotai.email.mac"
    }
  };
}

function resolveRelay(env) {
  const bundledBaseURL = env.CARTA_DISABLE_BUNDLED_RELAY === "1" ? "" : DEFAULT_RELAY_BASE_URL;
  const baseURL = firstNonEmpty(
    ["CARTA_RELAY_BASE_URL", env.CARTA_RELAY_BASE_URL],
    ["CARTA_RELAY_PUBLIC_URL", env.CARTA_RELAY_PUBLIC_URL],
    ["EMAIL_RELAY_BASE_URL", env.EMAIL_RELAY_BASE_URL],
    ["CARTA_DEFAULT_RELAY_BASE_URL", env.CARTA_DEFAULT_RELAY_BASE_URL],
    ["bundled", bundledBaseURL]
  );
  const token = firstNonEmpty(
    ["CARTA_RELAY_TOKEN", env.CARTA_RELAY_TOKEN],
    ["EMAIL_RELAY_TOKEN", env.EMAIL_RELAY_TOKEN],
    ["CARTA_DEFAULT_RELAY_TOKEN", env.CARTA_DEFAULT_RELAY_TOKEN]
  );
  return {
    baseURL: baseURL.value.replace(/\/+$/u, ""),
    token: token.value,
    source: baseURL.key || "missing",
    tokenSource: token.key || "missing"
  };
}

function resolveGoogleOAuth(env) {
  const bundledClientId = env.CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH === "1"
    ? ""
    : DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
  const bundledClientSecret = env.CARTA_DISABLE_BUNDLED_GOOGLE_OAUTH === "1"
    ? ""
    : DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET;
  const clientId = firstNonEmpty(
    ["CARTA_GOOGLE_OAUTH_CLIENT_ID", env.CARTA_GOOGLE_OAUTH_CLIENT_ID],
    ["GOOGLE_OAUTH_CLIENT_ID", env.GOOGLE_OAUTH_CLIENT_ID],
    ["CARTA_DEFAULT_GOOGLE_OAUTH_CLIENT_ID", env.CARTA_DEFAULT_GOOGLE_OAUTH_CLIENT_ID],
    ["bundled", bundledClientId]
  );
  const clientSecret = firstNonEmpty(
    ["CARTA_GOOGLE_OAUTH_CLIENT_SECRET", env.CARTA_GOOGLE_OAUTH_CLIENT_SECRET],
    ["GOOGLE_OAUTH_CLIENT_SECRET", env.GOOGLE_OAUTH_CLIENT_SECRET],
    ["CARTA_DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET", env.CARTA_DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET],
    ["bundled", bundledClientSecret]
  );
  return {
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    source: clientId.key || "missing",
    secretSource: clientSecret.key || "missing"
  };
}

function firstNonEmpty(...entries) {
  for (const [key, value] of entries) {
    if (String(value ?? "").trim()) {
      return { key, value: String(value).trim() };
    }
  }
  return { key: "", value: "" };
}
