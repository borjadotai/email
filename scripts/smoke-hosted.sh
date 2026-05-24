#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Smoke-test the hosted Email API.

Usage:
  scripts/smoke-hosted.sh [options]

Options:
  --base-url URL   Hosted API URL. Defaults to EMAIL_API_BASE_URL or https://$FLY_APP_NAME.fly.dev.
  -h, --help       Show this help.

Optional authenticated smoke:
  Set EMAIL_SMOKE_EMAIL and EMAIL_SMOKE_PASSWORD to sign in through Supabase Auth
  and verify /api/profile with the returned bearer token.
USAGE
}

BASE_URL="${EMAIL_API_BASE_URL:-https://${FLY_APP_NAME:-dearly-email}.fly.dev}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      [[ $# -ge 2 && -n "$2" ]] || { echo "smoke-hosted: --base-url requires a value" >&2; exit 1; }
      BASE_URL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "smoke-hosted: unknown option: $1" >&2
      exit 1
      ;;
  esac
done

BASE_URL="${BASE_URL%/}"
health_file="$(mktemp)"
settings_file="$(mktemp)"
trap 'rm -f "$health_file" "$settings_file"' EXIT

echo "Checking $BASE_URL/api/health..."
curl -fsS "$BASE_URL/api/health" > "$health_file"

echo "Checking $BASE_URL/api/auth/settings..."
curl -fsS "$BASE_URL/api/auth/settings" > "$settings_file"

node --input-type=module - "$health_file" "$settings_file" <<'NODE'
import { readFileSync } from "node:fs";

const [healthPath, settingsPath] = process.argv.slice(2);
const health = JSON.parse(readFileSync(healthPath, "utf8"));
const settingsEnvelope = JSON.parse(readFileSync(settingsPath, "utf8"));
const settings = settingsEnvelope.settings;

if (health.status !== "ok") {
  throw new Error(`Expected health.status=ok, got ${health.status}`);
}
if (!settings || settings.requireUserAuth !== true) {
  throw new Error("Expected hosted auth settings with requireUserAuth=true.");
}
if (!settings.supabaseURL || !settings.supabasePublishableKey) {
  throw new Error("Hosted auth settings are missing Supabase public config.");
}

console.log(`Health OK: storage=${health.storage ?? "unknown"}`);
console.log(`Auth OK: gmailConfigured=${Boolean(settings.gmailConfigured)}`);
NODE

if [[ -n "${EMAIL_SMOKE_EMAIL:-}" || -n "${EMAIL_SMOKE_PASSWORD:-}" ]]; then
  [[ -n "${EMAIL_SMOKE_EMAIL:-}" && -n "${EMAIL_SMOKE_PASSWORD:-}" ]] || {
    echo "smoke-hosted: set both EMAIL_SMOKE_EMAIL and EMAIL_SMOKE_PASSWORD for authenticated smoke" >&2
    exit 1
  }

  echo "Checking authenticated /api/profile..."
  EMAIL_API_BASE_URL="$BASE_URL" node --input-type=module - "$settings_file" <<'NODE'
import { readFileSync } from "node:fs";

const [settingsPath] = process.argv.slice(2);
const settings = JSON.parse(readFileSync(settingsPath, "utf8")).settings;
const email = process.env.EMAIL_SMOKE_EMAIL;
const password = process.env.EMAIL_SMOKE_PASSWORD;
const baseURL = process.env.EMAIL_API_BASE_URL;

const tokenResponse = await fetch(`${settings.supabaseURL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: {
    apikey: settings.supabasePublishableKey,
    "content-type": "application/json"
  },
  body: JSON.stringify({ email, password })
});
if (!tokenResponse.ok) {
  throw new Error(`Supabase sign-in failed: ${tokenResponse.status}`);
}
const tokenBody = await tokenResponse.json();
if (!tokenBody.access_token) {
  throw new Error("Supabase sign-in did not return an access token.");
}

const profileResponse = await fetch(`${baseURL}/api/profile`, {
  headers: { authorization: `Bearer ${tokenBody.access_token}` }
});
if (!profileResponse.ok) {
  throw new Error(`Authenticated profile request failed: ${profileResponse.status}`);
}
const profileBody = await profileResponse.json();
if (!profileBody.profile?.id) {
  throw new Error("Authenticated profile response is missing a profile id.");
}
console.log(`Authenticated profile OK: ${profileBody.profile.primaryEmail ?? profileBody.profile.id}`);
NODE
fi

echo "Hosted smoke passed."
