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
    seedDemo: env.EMAIL_SEED_DEMO === "1",
    publicBaseURL: env.EMAIL_PUBLIC_BASE_URL
  };
}

