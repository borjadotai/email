import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveConfig(env = process.env) {
  const port = Number.parseInt(env.EMAIL_SERVER_PORT ?? "7331", 10);
  const dataDir = env.EMAIL_DATA_DIR ?? join(homedir(), "Library", "Application Support", "EmailApp");
  mkdirSync(dataDir, { recursive: true });

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
    secretEncryptionKey: env.EMAIL_SECRET_ENCRYPTION_KEY ?? "",
    secretEncryptionKeyId: env.EMAIL_SECRET_ENCRYPTION_KEY_ID ?? "primary",
    secretStore: env.EMAIL_SECRET_STORE ?? "",
    secretStorePath: env.EMAIL_SECRET_STORE_PATH ?? join(dataDir, "secrets.json"),
    postgresURL: env.EMAIL_POSTGRES_URL ?? env.DATABASE_URL ?? "",
    initialSyncLimit: Number.parseInt(env.EMAIL_INITIAL_SYNC_LIMIT ?? "500", 10),
    seedDemo: env.EMAIL_SEED_DEMO === "1",
    publicBaseURL: env.EMAIL_PUBLIC_BASE_URL,
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
