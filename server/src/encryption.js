import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export class SecretCipher {
  constructor({ key, keyId = "primary" } = {}) {
    this.key = normalizeKey(key);
    this.keyId = keyId;
  }

  encrypt(value, aad = "") {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce);
    if (aad) {
      cipher.setAAD(Buffer.from(aad, "utf8"));
    }

    const ciphertext = Buffer.concat([
      cipher.update(String(value), "utf8"),
      cipher.final()
    ]);

    return JSON.stringify({
      v: 1,
      alg: ALGORITHM,
      kid: this.keyId,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url")
    });
  }

  decrypt(payload, aad = "") {
    const parsed = parsePayload(payload);
    if (parsed.alg !== ALGORITHM) {
      throw new Error(`Unsupported secret encryption algorithm: ${parsed.alg}`);
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(parsed.nonce, "base64url")
    );
    if (aad) {
      decipher.setAAD(Buffer.from(aad, "utf8"));
    }
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }
}

export class EncryptedSecretStore {
  constructor({ store, cipher }) {
    this.store = store;
    this.cipher = cipher;
  }

  async get(key) {
    const encrypted = await this.store.get(key);
    if (!encrypted) return null;
    return this.cipher.decrypt(encrypted, key);
  }

  async set(key, value) {
    await this.store.set(key, this.cipher.encrypt(value, key));
  }

  async delete(key) {
    await this.store.delete(key);
  }

  async close() {
    await this.store.close?.();
  }
}

export function maybeEncryptedSecretStore(store, config = {}) {
  if (!config.secretEncryptionKey) return store;
  return new EncryptedSecretStore({
    store,
    cipher: new SecretCipher({
      key: config.secretEncryptionKey,
      keyId: config.secretEncryptionKeyId ?? "primary"
    })
  });
}

export function generateSecretEncryptionKey() {
  return randomBytes(KEY_BYTES).toString("base64url");
}

function normalizeKey(value) {
  if (Buffer.isBuffer(value) && value.length === KEY_BYTES) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("EMAIL_SECRET_ENCRYPTION_KEY is required to encrypt provider secrets.");
  }

  const trimmed = value.trim();
  const candidates = [
    () => Buffer.from(trimmed, "base64url"),
    () => Buffer.from(trimmed, "base64"),
    () => /^[0-9a-f]{64}$/iu.test(trimmed) ? Buffer.from(trimmed, "hex") : null
  ];

  for (const candidate of candidates) {
    const key = candidate();
    if (key?.length === KEY_BYTES) return key;
  }

  const derived = createHash("sha256").update(trimmed).digest();
  if (trimmed.length >= 32) return derived;
  throw new Error("EMAIL_SECRET_ENCRYPTION_KEY must be 32 random bytes encoded as base64url, base64, or hex.");
}

function parsePayload(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || parsed.v !== 1 || !parsed.nonce || !parsed.tag || !parsed.ciphertext) {
      throw new Error("Invalid encrypted secret payload.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid encrypted secret payload: ${error.message}`);
  }
}
