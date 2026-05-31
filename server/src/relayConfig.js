import { normalizeBaseURL } from "./serverAccess.js";

export const RELAY_SETTINGS = {
  baseURL: "carta.relay.baseURL"
};

export const RELAY_SECRET_KEYS = {
  token: "carta.relay.token"
};

export function relayConfigFromStore(store, secretStore) {
  const baseURL = normalizeBaseURL(store.getSetting(RELAY_SETTINGS.baseURL, ""));
  return {
    baseURL,
    token: baseURL ? secretStore?.get(relayTokenSecretKey(baseURL)) ?? secretStore?.get(RELAY_SECRET_KEYS.token) ?? "" : ""
  };
}

export function applyStoredRelay(config, store, secretStore) {
  const stored = relayConfigFromStore(store, secretStore);
  const relay = config.relay ?? {};
  const envBaseURL = relay.source && !["stored", "missing", "bundled"].includes(relay.source)
    ? relay.baseURL
    : "";
  const envToken = relay.tokenSource && !["keychain", "missing", "bundled"].includes(relay.tokenSource)
    ? relay.token
    : "";
  const defaultBaseURL = relay.source === "bundled" ? relay.baseURL : "";
  const defaultToken = relay.tokenSource === "bundled" ? relay.token : "";
  const baseURL = envBaseURL || stored.baseURL || defaultBaseURL;
  const token = envToken || stored.token || defaultToken;
  return {
    ...config,
    relay: {
      ...relay,
      baseURL,
      token,
      source: envBaseURL ? relay.source : (stored.baseURL ? "stored" : (defaultBaseURL ? "bundled" : "missing")),
      tokenSource: envToken ? relay.tokenSource : (stored.token ? "keychain" : (defaultToken ? "bundled" : "missing"))
    }
  };
}

export function storeRelayConfig(store, secretStore, input) {
  const baseURL = normalizeBaseURL(input.baseURL);
  const token = String(input.token ?? "").trim();
  if (!baseURL) throw new Error("Relay URL is required.");
  if (!token) throw new Error("Relay token is required.");
  store.setSetting(RELAY_SETTINGS.baseURL, baseURL);
  secretStore.set(relayTokenSecretKey(baseURL), token);
  secretStore.delete(RELAY_SECRET_KEYS.token);
  return {
    baseURL,
    tokenConfigured: true
  };
}

export function clearRelayConfig(store, secretStore) {
  const currentBaseURL = normalizeBaseURL(store.getSetting(RELAY_SETTINGS.baseURL, ""));
  store.deleteSetting(RELAY_SETTINGS.baseURL);
  if (currentBaseURL) secretStore?.delete(relayTokenSecretKey(currentBaseURL));
  secretStore?.delete(RELAY_SECRET_KEYS.token);
}

export function relayConfigStatus(config) {
  const relay = config.relay ?? {};
  return {
    configured: Boolean(relay.baseURL),
    baseURL: relay.baseURL || "",
    source: relay.source || "missing",
    tokenConfigured: Boolean(relay.token),
    tokenSource: relay.tokenSource || "missing"
  };
}

export function relayTokenSecretKey(baseURL) {
  return `${RELAY_SECRET_KEYS.token}:${normalizeBaseURL(baseURL)}`;
}
