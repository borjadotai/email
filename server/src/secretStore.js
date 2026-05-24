import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

const { Pool } = pg;

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

export class FileSecretStore {
  constructor({ path }) {
    if (!path) {
      throw new Error("FileSecretStore requires a path.");
    }
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
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
    delete secrets[key];
    this.write(secrets);
  }

  read() {
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return {};
    }
  }

  write(secrets) {
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}

export class PostgresSecretStore {
  constructor({ connectionString, pool } = {}) {
    if (!pool && !connectionString) {
      throw new Error("PostgresSecretStore requires a database connection string.");
    }
    this.pool = pool ?? new Pool({ connectionString });
    this.ownsPool = !pool;
  }

  async get(key) {
    const { accountId, name } = parseAccountSecretKey(key);
    const result = await this.pool.query(`
      SELECT algorithm, ciphertext, nonce, auth_tag AS "authTag", key_id AS "keyId"
      FROM email_private.provider_secrets
      WHERE account_id = $1 AND secret_name = $2
      LIMIT 1
    `, [accountId, name]);
    const row = result.rows[0];
    if (!row) return null;

    return JSON.stringify({
      v: 1,
      alg: row.algorithm,
      kid: row.keyId,
      nonce: row.nonce,
      tag: row.authTag,
      ciphertext: row.ciphertext
    });
  }

  async set(key, value) {
    const { accountId, name } = parseAccountSecretKey(key);
    const payload = parseEncryptedSecretPayload(value);
    const result = await this.pool.query(`
      INSERT INTO email_private.provider_secrets (
        account_id, user_id, secret_name, algorithm, ciphertext, nonce, auth_tag, key_id
      )
      SELECT id, user_id, $2, $3, $4, $5, $6, $7
      FROM public.accounts
      WHERE id = $1
      ON CONFLICT(account_id, secret_name) DO UPDATE SET
        algorithm = excluded.algorithm,
        ciphertext = excluded.ciphertext,
        nonce = excluded.nonce,
        auth_tag = excluded.auth_tag,
        key_id = excluded.key_id,
        updated_at = timezone('utc', now())
      RETURNING id
    `, [
      accountId,
      name,
      payload.alg,
      payload.ciphertext,
      payload.nonce,
      payload.tag,
      payload.kid
    ]);
    if (result.rowCount !== 1) {
      throw new Error("Cannot store provider secret for an unknown account.");
    }
  }

  async delete(key) {
    const { accountId, name } = parseAccountSecretKey(key);
    await this.pool.query(`
      DELETE FROM email_private.provider_secrets
      WHERE account_id = $1 AND secret_name = $2
    `, [accountId, name]);
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

export function parseAccountSecretKey(key) {
  const match = String(key).match(/^account:([^:]+):(.+)$/u);
  if (!match) {
    throw new Error(`Unsupported provider secret key: ${key}`);
  }
  return { accountId: match[1], name: match[2] };
}

function parseEncryptedSecretPayload(value) {
  let payload;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error("PostgresSecretStore only accepts encrypted secret payloads.");
  }
  if (
    payload?.v !== 1 ||
    payload.alg !== "aes-256-gcm" ||
    !payload.ciphertext ||
    !payload.nonce ||
    !payload.tag ||
    !payload.kid
  ) {
    throw new Error("PostgresSecretStore only accepts AES-256-GCM encrypted secret payloads.");
  }
  return payload;
}
