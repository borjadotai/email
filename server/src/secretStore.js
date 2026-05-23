import { execFileSync } from "node:child_process";

export class KeychainSecretStore {
  constructor({ service = "EmailApp" } = {}) {
    this.service = service;
  }

  get(key) {
    try {
      return execFileSync("security", ["find-generic-password", "-w", "-s", this.service, "-a", key], {
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

