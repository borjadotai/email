import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class KeychainSecretStore {
  constructor({ service = "CartaCLI", fallbackServices = [] } = {}) {
    this.service = service;
    this.fallbackServices = fallbackServices.filter(candidate => candidate && candidate !== service);
  }

  get(key) {
    const primary = this.getFromService(this.service, key);
    if (primary !== null) return primary;

    for (const fallbackService of this.fallbackServices) {
      const fallback = this.getFromService(fallbackService, key);
      if (fallback === null) continue;
      try {
        this.set(key, fallback);
      } catch {
        // A failed migration should not hide an otherwise readable secret.
      }
      return fallback;
    }

    return null;
  }

  getFromService(service, key) {
    try {
      return execFileSync("security", ["find-generic-password", "-w", "-s", service, "-a", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      return null;
    }
  }

  set(key, value) {
    execFileSync("security", [
      "add-generic-password",
      "-U",
      "-s",
      this.service,
      "-a",
      key,
      "-w",
      value
    ]);
  }

  delete(key) {
    try {
      execFileSync("security", ["delete-generic-password", "-s", this.service, "-a", key], {
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
      // Missing secrets are already deleted from the caller's perspective.
    }
  }
}

export class MemorySecretStore {
  constructor() {
    this.secrets = new Map();
  }

  get(key) {
    return this.secrets.get(key) ?? null;
  }

  set(key, value) {
    this.secrets.set(key, value);
  }

  delete(key) {
    this.secrets.delete(key);
  }
}

export class FileSecretStore {
  constructor({ filePath }) {
    if (!filePath) {
      throw new Error("FileSecretStore requires a filePath.");
    }
    this.filePath = filePath;
  }

  get(key) {
    return this.read()[key] ?? null;
  }

  set(key, value) {
    const secrets = this.read();
    secrets[key] = String(value);
    this.write(secrets);
  }

  delete(key) {
    const secrets = this.read();
    if (!Object.prototype.hasOwnProperty.call(secrets, key)) return;
    delete secrets[key];
    this.write(secrets);
  }

  read() {
    if (!existsSync(this.filePath)) return {};
    const text = readFileSync(this.filePath, "utf8");
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Secret store is invalid: ${this.filePath}`);
    }
    return parsed;
  }

  write(secrets) {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}

export function createDefaultSecretStore({
  env = process.env,
  dataDir = "",
  platform = process.platform
} = {}) {
  const mode = String(env.CARTA_SECRET_STORE ?? "").trim().toLowerCase();
  if (mode === "memory") return new MemorySecretStore();

  if (platform === "darwin" && mode !== "file") {
    const service = env.CARTA_KEYCHAIN_SERVICE || "CartaCLI";
    const fallbackService = env.CARTA_LEGACY_KEYCHAIN_SERVICE === "0"
      ? ""
      : env.CARTA_LEGACY_KEYCHAIN_SERVICE || "EmailApp";
    return new KeychainSecretStore({
      service,
      fallbackServices: [fallbackService]
    });
  }

  const filePath = env.CARTA_SECRETS_PATH
    || env.EMAIL_SECRETS_PATH
    || join(dataDir, "secrets.json");
  return new FileSecretStore({ filePath });
}
