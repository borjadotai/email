import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveConfig(env = process.env) {
  const port = Number.parseInt(env.EMAIL_SERVER_PORT ?? "7331", 10);
  const dataDir = env.EMAIL_DATA_DIR ?? join(homedir(), "Library", "Application Support", "EmailApp");
  mkdirSync(dataDir, { recursive: true });
  const backgroundSyncIntervalMs = Number.parseInt(env.EMAIL_BACKGROUND_SYNC_INTERVAL_MS ?? "0", 10);
  const backgroundSyncLimit = Number.parseInt(env.EMAIL_BACKGROUND_SYNC_LIMIT ?? "50", 10);
  const backgroundSyncLeaseTtlMs = Number.parseInt(env.EMAIL_SYNC_LEASE_TTL_MS ?? "300000", 10);
  const rateLimits = resolveRateLimits(env);

  return {
    host: env.EMAIL_SERVER_HOST ?? "127.0.0.1",
    port: Number.isFinite(port) ? port : 7331,
    dataDir,
    databasePath: env.EMAIL_DATABASE_PATH ?? join(dataDir, "mail.sqlite"),
    googleOAuthClientId: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    googleOAuthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    requireAuth: env.EMAIL_REQUIRE_AUTH === "1",
    supabaseURL: env.SUPABASE_URL ?? "",
    supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? "",
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? "",
    secretEncryptionKey: env.EMAIL_SECRET_ENCRYPTION_KEY ?? "",
    secretEncryptionKeyId: env.EMAIL_SECRET_ENCRYPTION_KEY_ID ?? "primary",
    secretStore: env.EMAIL_SECRET_STORE ?? "",
    secretStorePath: env.EMAIL_SECRET_STORE_PATH ?? join(dataDir, "secrets.json"),
    postgresURL: env.EMAIL_POSTGRES_URL ?? env.DATABASE_URL ?? "",
    attachmentBucket: env.EMAIL_ATTACHMENT_BUCKET ?? "email-attachments",
    initialSyncLimit: Number.parseInt(env.EMAIL_INITIAL_SYNC_LIMIT ?? "500", 10),
    backgroundSyncIntervalMs: Number.isFinite(backgroundSyncIntervalMs) ? backgroundSyncIntervalMs : 0,
    backgroundSyncLimit: Number.isFinite(backgroundSyncLimit) ? backgroundSyncLimit : 50,
    backgroundSyncLeaseTtlMs: Number.isFinite(backgroundSyncLeaseTtlMs) ? backgroundSyncLeaseTtlMs : 300_000,
    rateLimits,
    seedDemo: env.EMAIL_SEED_DEMO === "1",
    publicBaseURL: env.EMAIL_PUBLIC_BASE_URL,
    storage: env.EMAIL_STORAGE ?? "sqlite",
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

function resolveRateLimits(env) {
  return {
    enabled: env.EMAIL_RATE_LIMIT_ENABLED !== "0",
    gmailStart: rateLimitRule(env, "GMAIL_START", 10, 15 * 60 * 1000),
    gmailCallback: rateLimitRule(env, "GMAIL_CALLBACK", 60, 15 * 60 * 1000),
    icloudConnect: rateLimitRule(env, "ICLOUD_CONNECT", 5, 60 * 60 * 1000),
    manualSync: rateLimitRule(env, "MANUAL_SYNC", 20, 15 * 60 * 1000),
    sendMessage: rateLimitRule(env, "SEND_MESSAGE", 120, 60 * 60 * 1000),
    attachmentDownload: rateLimitRule(env, "ATTACHMENT_DOWNLOAD", 300, 15 * 60 * 1000)
  };
}

function rateLimitRule(env, name, defaultLimit, defaultWindowMs) {
  const limit = Number.parseInt(env[`EMAIL_RATE_LIMIT_${name}_LIMIT`] ?? String(defaultLimit), 10);
  const windowMs = Number.parseInt(env[`EMAIL_RATE_LIMIT_${name}_WINDOW_MS`] ?? String(defaultWindowMs), 10);
  return {
    limit: Number.isFinite(limit) ? Math.max(1, limit) : defaultLimit,
    windowMs: Number.isFinite(windowMs) ? Math.max(1_000, windowMs) : defaultWindowMs
  };
}

export function validateRuntimeConfig(config) {
  const errors = [];

  if (config.requireAuth) {
    requireValue(errors, config.supabaseURL, "SUPABASE_URL is required when EMAIL_REQUIRE_AUTH=1.");
    requireValue(
      errors,
      config.supabasePublishableKey,
      "SUPABASE_PUBLISHABLE_KEY is required when EMAIL_REQUIRE_AUTH=1."
    );
  }

  if (config.storage === "postgres") {
    requireValue(errors, config.postgresURL, "EMAIL_POSTGRES_URL is required when EMAIL_STORAGE=postgres.");
    requireValue(errors, config.supabaseURL, "SUPABASE_URL is required when EMAIL_STORAGE=postgres.");
    requireValue(
      errors,
      config.supabaseServiceRoleKey,
      "SUPABASE_SERVICE_ROLE_KEY is required when EMAIL_STORAGE=postgres."
    );
    if (config.secretStore !== "postgres") {
      errors.push("EMAIL_SECRET_STORE=postgres is required when EMAIL_STORAGE=postgres.");
    }
  }

  if (config.secretStore === "postgres") {
    requireValue(errors, config.postgresURL, "EMAIL_POSTGRES_URL is required when EMAIL_SECRET_STORE=postgres.");
    requireValue(
      errors,
      config.secretEncryptionKey,
      "EMAIL_SECRET_ENCRYPTION_KEY is required when EMAIL_SECRET_STORE=postgres."
    );
  }

  if (errors.length > 0) {
    throw new Error(`Invalid runtime configuration:\n- ${errors.join("\n- ")}`);
  }
}

function requireValue(errors, value, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(message);
  }
}
