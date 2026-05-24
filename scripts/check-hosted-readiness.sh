#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Check whether the hosted Email API is ready for a production deploy.

Usage:
  scripts/check-hosted-readiness.sh [options]

Options:
  --app NAME       Fly app name. Defaults to FLY_APP_NAME or dearly-email.
  --config PATH    Fly config path. Defaults to FLY_CONFIG or fly.toml.
  --env-file PATH  Load deployment secrets from a dotenv-style file.
  --base-url URL   Hosted API URL for smoke guidance.
  -h, --help       Show this help.

This command never creates Fly apps, stages secrets, or deploys.
USAGE
}

APP_NAME="${FLY_APP_NAME:-dearly-email}"
CONFIG="${FLY_CONFIG:-fly.toml}"
BASE_URL="${EMAIL_API_BASE_URL:-https://${APP_NAME}.fly.dev}"
ENV_FILES=()
FAILURES=0
WARNINGS=0

fail() {
  FAILURES=$((FAILURES + 1))
  echo "FAIL $*"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  echo "WARN $*"
}

pass() {
  echo "OK   $*"
}

load_env_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    fail "env file not found: $path"
    return
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export }"
    fi
    if [[ "$line" != *=* ]]; then
      fail "invalid env line in $path: $line"
      continue
    fi

    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      fail "invalid env key in $path: $key"
      continue
    fi

    if [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]] || [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < "$path"
}

app_list_contains() {
  local app_name="$1"
  awk '{$1=$1}; NF > 0 { print }' | grep -Fxq "$app_name"
}

is_placeholder_value() {
  case "$1" in
    *YOUR_*|*your-*|*paste-the-*|*run-npm-run-*|*example*|*'...'*) return 0 ;;
    *) return 1 ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -ge 2 && -n "$2" ]] || { echo "check-hosted-readiness: --app requires a value" >&2; exit 1; }
      APP_NAME="$2"
      BASE_URL="${EMAIL_API_BASE_URL:-https://${APP_NAME}.fly.dev}"
      shift 2
      ;;
    --config)
      [[ $# -ge 2 && -n "$2" ]] || { echo "check-hosted-readiness: --config requires a value" >&2; exit 1; }
      CONFIG="$2"
      shift 2
      ;;
    --env-file)
      [[ $# -ge 2 && -n "$2" ]] || { echo "check-hosted-readiness: --env-file requires a value" >&2; exit 1; }
      ENV_FILES+=("$2")
      shift 2
      ;;
    --base-url)
      [[ $# -ge 2 && -n "$2" ]] || { echo "check-hosted-readiness: --base-url requires a value" >&2; exit 1; }
      BASE_URL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "check-hosted-readiness: unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "${#ENV_FILES[@]}" -gt 0 ]]; then
  for env_file in "${ENV_FILES[@]}"; do
    load_env_file "$env_file"
  done
fi

echo "Hosted readiness for Fly app '$APP_NAME'"

if [[ -f "$CONFIG" ]]; then
  pass "Fly config exists: $CONFIG"
else
  fail "Fly config is missing: $CONFIG"
fi

if [[ -f Dockerfile ]]; then
  pass "Dockerfile exists"
else
  fail "Dockerfile is missing"
fi

if [[ -f "$CONFIG" ]]; then
  for forbidden in EMAIL_POSTGRES_URL EMAIL_SECRET_ENCRYPTION_KEY GOOGLE_OAUTH_CLIENT_SECRET SUPABASE_SERVICE_ROLE_KEY; do
    if grep -q "$forbidden" "$CONFIG"; then
      fail "$forbidden must be a Fly secret, not public fly.toml config"
    fi
  done
fi

fly_bin=""
if [[ -n "${FLY_BIN:-}" ]]; then
  fly_bin="$FLY_BIN"
elif command -v fly >/dev/null 2>&1; then
  fly_bin="$(command -v fly)"
elif command -v flyctl >/dev/null 2>&1; then
  fly_bin="$(command -v flyctl)"
fi

if [[ -z "$fly_bin" ]]; then
  fail "flyctl is not installed"
else
  pass "flyctl is installed"
  fly_cmd=("$fly_bin")
  if [[ -n "${FLY_API_TOKEN:-}" ]]; then
    fly_cmd+=("--access-token" "$FLY_API_TOKEN")
  fi

  if "${fly_cmd[@]}" auth whoami >/dev/null 2>&1; then
    pass "Fly auth is configured"
    if apps_output="$("${fly_cmd[@]}" apps list --quiet 2>&1)"; then
      if printf '%s\n' "$apps_output" | app_list_contains "$APP_NAME"; then
        pass "Fly app '$APP_NAME' exists"
      else
        warn "Fly app '$APP_NAME' is not created yet; deploy will create it after the Fly account is unlocked"
      fi
    else
      warn "Could not list Fly apps: $(printf '%s' "$apps_output" | tail -n 1)"
    fi
  else
    fail "Fly auth is not configured; run 'fly auth login' or export FLY_API_TOKEN"
  fi
fi

required_secret_names=(
  EMAIL_POSTGRES_URL
  EMAIL_SECRET_ENCRYPTION_KEY
  GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET
  SUPABASE_SERVICE_ROLE_KEY
)

for name in "${required_secret_names[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    if is_placeholder_value "${!name}"; then
      fail "$name still contains a placeholder value"
    else
      pass "$name is set"
    fi
  else
    fail "$name is missing"
  fi
done

if [[ -n "${EMAIL_SECRET_ENCRYPTION_KEY:-}" ]] && ! is_placeholder_value "$EMAIL_SECRET_ENCRYPTION_KEY"; then
  if node --input-type=module <<'NODE' >/dev/null 2>&1
import { SecretCipher } from "./server/src/encryption.js";
new SecretCipher({ key: process.env.EMAIL_SECRET_ENCRYPTION_KEY });
NODE
  then
    pass "EMAIL_SECRET_ENCRYPTION_KEY is valid"
  else
    fail "EMAIL_SECRET_ENCRYPTION_KEY is not a valid 32-byte key; run 'npm run --silent generate:secret-key'"
  fi
fi

if [[ -n "${EMAIL_POSTGRES_URL:-}" ]] && ! is_placeholder_value "$EMAIL_POSTGRES_URL"; then
  if node --input-type=module <<'NODE' >/dev/null 2>&1
const value = process.env.EMAIL_POSTGRES_URL ?? "";
const url = new URL(value);
if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.password) {
  throw new Error("invalid postgres url");
}
NODE
  then
    pass "EMAIL_POSTGRES_URL is a valid postgres URL shape"
  else
    fail "EMAIL_POSTGRES_URL must be a full postgres URL with host, user, password, and database"
  fi
fi

if [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] && ! is_placeholder_value "$SUPABASE_SERVICE_ROLE_KEY"; then
  if [[ "$SUPABASE_SERVICE_ROLE_KEY" == sb_publishable_* ]]; then
    fail "SUPABASE_SERVICE_ROLE_KEY is a publishable key, not a service-role key"
  else
    pass "SUPABASE_SERVICE_ROLE_KEY is not a publishable key"
  fi
fi

echo
echo "Google OAuth redirect URI to register:"
echo "  ${BASE_URL%/}/api/auth/gmail/callback"
echo "  Add this exact value to the Web application OAuth client's Authorized redirect URIs."
echo
echo "Next commands:"
echo "  npm run deploy:fly -- --env-file .env.fly"
echo "  npm run smoke:hosted -- --base-url $BASE_URL"

if [[ "$FAILURES" -gt 0 ]]; then
  echo
  echo "Hosted readiness failed with $FAILURES failure(s) and $WARNINGS warning(s)."
  exit 1
fi

echo
echo "Hosted readiness passed with $WARNINGS warning(s)."
