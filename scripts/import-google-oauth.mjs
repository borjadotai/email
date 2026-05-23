#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/import-google-oauth.mjs /path/to/client_secret.json");
  process.exit(1);
}

const credentials = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
const client = credentials.installed ?? credentials.web;
if (!client?.client_id) {
  console.error("OAuth JSON must contain an installed or web client with client_id.");
  process.exit(1);
}

const envPath = resolve(".env");
const env = existsSync(envPath) ? readEnv(readFileSync(envPath, "utf8")) : new Map();
env.set("GOOGLE_OAUTH_CLIENT_ID", client.client_id);
env.set("GOOGLE_OAUTH_CLIENT_SECRET", client.client_secret ?? "");

writeFileSync(envPath, serializeEnv(env));
console.log(`Updated ${envPath}`);
console.log(`Google OAuth client: ${client.client_id}`);

function readEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([^=]+)=(.*)$/u);
    if (match) values.set(match[1].trim(), unquote(match[2].trim()));
  }
  return values;
}

function serializeEnv(values) {
  return `${Array.from(values.entries())
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join("\n")}\n`;
}

function quote(value) {
  if (!value) return "";
  return /[\s"'#$`\\]/u.test(value) ? JSON.stringify(value) : value;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
