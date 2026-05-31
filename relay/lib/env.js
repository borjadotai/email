export function relayEnv(env = process.env) {
  return {
    publicURL: trimURL(env.CARTA_RELAY_PUBLIC_URL || vercelPublicURL(env)),
    apiToken: env.CARTA_RELAY_TOKEN || "",
    stateSecret: env.CARTA_RELAY_STATE_SECRET || "",
    allowedCallbackHosts: splitList(env.CARTA_RELAY_ALLOWED_CALLBACK_HOSTS || "127.0.0.1,localhost,.ts.net"),
    googleClientId: env.GOOGLE_OAUTH_CLIENT_ID || "",
    googleClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    apns: {
      keyId: env.APNS_KEY_ID || "",
      teamId: env.APNS_TEAM_ID || "",
      privateKey: env.APNS_PRIVATE_KEY || "",
      environment: env.APNS_ENVIRONMENT === "production" ? "production" : "development"
    }
  };
}

export function requireRelayEnv(config, key, message = `${key} is required`) {
  if (!config[key]) {
    throw Object.assign(new Error(message), { status: 500 });
  }
  return config[key];
}

function trimURL(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function vercelPublicURL(env) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || "";
  return host ? `https://${host}` : "";
}
