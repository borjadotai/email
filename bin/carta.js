#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { runCLI } from "../server/src/cli.js";

process.env.CARTA_CLI = "1";

if (!process.env.CARTA_DATA_DIR && !process.env.EMAIL_DATA_DIR && !process.env.EMAIL_DATABASE_PATH) {
  process.env.CARTA_DATA_DIR = defaultCartaDataDir();
}
if (!process.env.CARTA_SERVER_PORT && !process.env.EMAIL_SERVER_PORT) {
  process.env.CARTA_SERVER_PORT = "7332";
  process.env.CARTA_SERVER_PORT_DEFAULT = "1";
}
if (!process.env.CARTA_PUBLIC_BASE_URL && !process.env.EMAIL_PUBLIC_BASE_URL) {
  process.env.CARTA_PUBLIC_BASE_URL = "";
  process.env.EMAIL_PUBLIC_BASE_URL = "";
}
process.env.GOOGLE_OAUTH_CLIENT_ID = "";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "";

function defaultCartaDataDir() {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "CartaCLI");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (process.platform === "linux") {
    return join(xdgDataHome || join(home, ".local", "share"), "CartaCLI");
  }
  return join(home, ".carta");
}

const emitWarning = process.emitWarning;
process.emitWarning = function emitCartaWarning(warning, ...args) {
  const message = typeof warning === "string" ? warning : warning?.message ?? "";
  const type = typeof args[0] === "string" ? args[0] : warning?.name;
  if (type === "ExperimentalWarning" && message.includes("SQLite")) {
    return;
  }
  return emitWarning.call(process, warning, ...args);
};

try {
  const code = await runCLI(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  console.error(error.message);
  process.exitCode = error.status && error.status >= 64 && error.status < 80 ? error.status : 1;
}
