import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const STATE_VERSION = "v1";
const DELIVERY_VERSION = "dv1";

export function sealOAuthState(payload, secret) {
  if (!secret) throw Object.assign(new Error("CARTA_RELAY_STATE_SECRET is required."), { status: 500 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const plaintext = Buffer.from(JSON.stringify({ ...payload, version: STATE_VERSION }), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [STATE_VERSION, base64url(iv), base64url(tag), base64url(encrypted)].join(".");
}

export function openOAuthState(value, secret) {
  if (!secret) throw Object.assign(new Error("CARTA_RELAY_STATE_SECRET is required."), { status: 500 });
  const [version, ivText, tagText, encryptedText] = String(value || "").split(".");
  if (version !== STATE_VERSION || !ivText || !tagText || !encryptedText) {
    throw Object.assign(new Error("Invalid OAuth state."), { status: 400 });
  }
  const decipher = createDecipheriv("aes-256-gcm", key(secret), unbase64url(ivText));
  decipher.setAuthTag(unbase64url(tagText));
  const decrypted = Buffer.concat([decipher.update(unbase64url(encryptedText)), decipher.final()]);
  const payload = JSON.parse(decrypted.toString("utf8"));
  if (payload.expiresAt && Date.now() > Number(payload.expiresAt)) {
    throw Object.assign(new Error("OAuth state expired."), { status: 400 });
  }
  return payload;
}

export function sealDeliveryPayload(payload, secret) {
  if (!secret) throw Object.assign(new Error("deliveryToken is required."), { status: 400 });
  return sealVersionedPayload(DELIVERY_VERSION, {
    ...payload,
    version: DELIVERY_VERSION,
    expiresAt: payload.expiresAt ?? Date.now() + 2 * 60 * 1000
  }, secret);
}

export function openDeliveryPayload(value, secret) {
  const payload = openVersionedPayload(value, secret, DELIVERY_VERSION);
  if (payload.expiresAt && Date.now() > Number(payload.expiresAt)) {
    throw Object.assign(new Error("Delivery payload expired."), { status: 400 });
  }
  return payload;
}

export function assertAllowedCallbackURL(callbackURL, hosts) {
  let parsed;
  try {
    parsed = new URL(callbackURL);
  } catch {
    throw Object.assign(new Error("callbackURL must be a valid URL."), { status: 400 });
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowed = hosts.some(host => host === hostname || (host.startsWith(".") && hostname.endsWith(host)));
  if (!allowed) {
    throw Object.assign(new Error(`callbackURL host is not allowed: ${hostname}`), { status: 400 });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw Object.assign(new Error("callbackURL must use http or https."), { status: 400 });
  }
  return parsed.toString();
}

function sealVersionedPayload(version, payload, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, base64url(iv), base64url(tag), base64url(encrypted)].join(".");
}

function openVersionedPayload(value, secret, expectedVersion) {
  if (!secret) throw Object.assign(new Error("Secret is required."), { status: 500 });
  const [version, ivText, tagText, encryptedText] = String(value || "").split(".");
  if (version !== expectedVersion || !ivText || !tagText || !encryptedText) {
    throw Object.assign(new Error("Invalid encrypted payload."), { status: 400 });
  }
  const decipher = createDecipheriv("aes-256-gcm", key(secret), unbase64url(ivText));
  decipher.setAuthTag(unbase64url(tagText));
  const decrypted = Buffer.concat([decipher.update(unbase64url(encryptedText)), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

function key(secret) {
  return createHash("sha256").update(secret).digest();
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function unbase64url(value) {
  return Buffer.from(value, "base64url");
}
