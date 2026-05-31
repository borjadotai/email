import { createPrivateKey, createSign } from "node:crypto";
import { connect } from "node:http2";

const APNS_DEVELOPMENT_ORIGIN = "https://api.sandbox.push.apple.com";
const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com";

let cachedJWT = null;
let cachedJWTAt = 0;
let cachedPrivateKey = null;

export async function sendAPNSNotification({ config, token, topic, environment, payload }) {
  if (!config.keyId || !config.teamId || !config.privateKey) {
    throw Object.assign(new Error("APNs is not configured on the relay."), { status: 503 });
  }
  const origin = environment === "production" ? APNS_PRODUCTION_ORIGIN : APNS_DEVELOPMENT_ORIGIN;
  const client = connect(origin);
  try {
    await onceConnect(client);
    const body = JSON.stringify(payload);
    const response = await request(client, {
      ":method": "POST",
      ":path": `/3/device/${token}`,
      "authorization": `bearer ${jwt(config)}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    }, body);
    if (response.status < 200 || response.status >= 300) {
      const reason = response.body ? JSON.parse(response.body).reason : `HTTP ${response.status}`;
      throw Object.assign(new Error(reason), { status: response.status, reason });
    }
    return response;
  } finally {
    client.close();
  }
}

function jwt(config) {
  const now = Date.now();
  if (cachedJWT && now - cachedJWTAt < 45 * 60 * 1000) return cachedJWT;
  const issuedAt = Math.floor(now / 1000);
  const header = base64urlJSON({ alg: "ES256", kid: config.keyId });
  const claims = base64urlJSON({ iss: config.teamId, iat: issuedAt });
  const signingInput = `${header}.${claims}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: privateKey(config), dsaEncoding: "ieee-p1363" });
  cachedJWT = `${signingInput}.${base64url(signature)}`;
  cachedJWTAt = now;
  return cachedJWT;
}

function privateKey(config) {
  if (!cachedPrivateKey) {
    cachedPrivateKey = createPrivateKey(config.privateKey.replaceAll("\\n", "\n"));
  }
  return cachedPrivateKey;
}

function request(client, headers, body) {
  return new Promise((resolve, reject) => {
    const req = client.request(headers);
    const chunks = [];
    let status = 0;
    req.setEncoding("utf8");
    req.on("response", responseHeaders => {
      status = Number(responseHeaders[":status"] || 0);
    });
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve({ status, body: chunks.join("") }));
    req.on("error", reject);
    req.end(body);
  });
}

function onceConnect(client) {
  return new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
}

function base64urlJSON(value) {
  return base64url(Buffer.from(JSON.stringify(value)));
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}
