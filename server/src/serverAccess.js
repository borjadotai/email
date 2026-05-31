export const SERVER_ACCESS_SETTINGS = {
  mode: "carta.server.access.mode",
  host: "carta.server.host",
  port: "carta.server.port",
  publicBaseURL: "carta.server.publicBaseURL",
  tailscaleDNSName: "carta.server.tailscale.dnsName",
  tailscaleIP: "carta.server.tailscale.ip"
};

export function serverAccessFromStore(store) {
  const portText = store.getSetting(SERVER_ACCESS_SETTINGS.port, "");
  const port = Number.parseInt(portText, 10);
  return {
    mode: store.getSetting(SERVER_ACCESS_SETTINGS.mode, "local"),
    host: store.getSetting(SERVER_ACCESS_SETTINGS.host, ""),
    port: Number.isFinite(port) ? port : null,
    publicBaseURL: normalizeBaseURL(store.getSetting(SERVER_ACCESS_SETTINGS.publicBaseURL, "")),
    tailscaleDNSName: store.getSetting(SERVER_ACCESS_SETTINGS.tailscaleDNSName, ""),
    tailscaleIP: store.getSetting(SERVER_ACCESS_SETTINGS.tailscaleIP, "")
  };
}

export function applyStoredServerAccess(config, store, env = process.env) {
  const settings = serverAccessFromStore(store);
  const hostExplicit = Boolean(firstNonEmpty(env.CARTA_SERVER_HOST, env.EMAIL_SERVER_HOST))
    && env.CARTA_SERVER_HOST_DEFAULT !== "1"
    && env.EMAIL_SERVER_HOST_DEFAULT !== "1";
  const portExplicit = Boolean(firstNonEmpty(env.CARTA_SERVER_PORT, env.EMAIL_SERVER_PORT))
    && env.CARTA_SERVER_PORT_DEFAULT !== "1"
    && env.EMAIL_SERVER_PORT_DEFAULT !== "1";
  const publicExplicit = Boolean(firstNonEmpty(env.CARTA_PUBLIC_BASE_URL, env.EMAIL_PUBLIC_BASE_URL));

  return {
    ...config,
    host: hostExplicit || !settings.host ? config.host : settings.host,
    port: portExplicit || !settings.port ? config.port : settings.port,
    publicBaseURL: publicExplicit ? config.publicBaseURL : (settings.publicBaseURL || undefined)
  };
}

export function effectiveServerBaseURL(config) {
  if (config.publicBaseURL) return config.publicBaseURL.replace(/\/+$/u, "");
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}`;
}

export function storeServerAccess(store, access) {
  setOrDelete(store, SERVER_ACCESS_SETTINGS.mode, access.mode);
  setOrDelete(store, SERVER_ACCESS_SETTINGS.host, access.host);
  setOrDelete(store, SERVER_ACCESS_SETTINGS.port, access.port === undefined || access.port === null ? "" : String(access.port));
  setOrDelete(store, SERVER_ACCESS_SETTINGS.publicBaseURL, normalizeBaseURL(access.publicBaseURL));
  setOrDelete(store, SERVER_ACCESS_SETTINGS.tailscaleDNSName, access.tailscaleDNSName);
  setOrDelete(store, SERVER_ACCESS_SETTINGS.tailscaleIP, access.tailscaleIP);
}

export function normalizeBaseURL(value) {
  const text = String(value ?? "").trim().replace(/\/+$/u, "");
  if (!text) return "";
  return text;
}

function setOrDelete(store, key, value) {
  const text = String(value ?? "").trim();
  if (text) {
    store.setSetting(key, text);
  } else {
    store.deleteSetting(key);
  }
}

function firstNonEmpty(...values) {
  return values.find(value => String(value ?? "").trim()) ?? "";
}
