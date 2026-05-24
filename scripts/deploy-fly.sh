#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Deploy the hosted Email API to Fly.io.

Usage:
  scripts/deploy-fly.sh [options]

Options:
  --app NAME       Fly app name. Defaults to FLY_APP_NAME or dearly-email.
  --config PATH    Fly config path. Defaults to FLY_CONFIG or fly.toml.
  --org ORG        Fly organization slug for first app creation.
  --skip-create    Do not create the Fly app before deploying.
  --skip-secrets   Do not stage runtime secrets.
  --stage-only     Stage secrets but do not deploy.
  --no-deploy      Same as --stage-only.
  --no-smoke       Skip the post-deploy /api/health check.
  -h, --help       Show this help.

Required secret environment variables unless --skip-secrets is used:
  EMAIL_POSTGRES_URL
  EMAIL_SECRET_ENCRYPTION_KEY
  GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET
  SUPABASE_SERVICE_ROLE_KEY

Optional secret environment variables are staged when present:
  EMAIL_SECRET_ENCRYPTION_KEY_ID
  APNS_KEY_ID
  APNS_TEAM_ID
  APNS_PRIVATE_KEY
  APNS_ENVIRONMENT
  APNS_IOS_TOPIC
  APNS_MACOS_TOPIC
USAGE
}

die() {
  echo "deploy-fly: $*" >&2
  exit 1
}

APP_NAME="${FLY_APP_NAME:-dearly-email}"
CONFIG="${FLY_CONFIG:-fly.toml}"
CREATE_APP=1
SET_SECRETS=1
DEPLOY=1
SMOKE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -ge 2 && -n "$2" ]] || die "--app requires a value"
      APP_NAME="$2"
      shift 2
      ;;
    --config)
      [[ $# -ge 2 && -n "$2" ]] || die "--config requires a value"
      CONFIG="$2"
      shift 2
      ;;
    --org)
      [[ $# -ge 2 && -n "$2" ]] || die "--org requires a value"
      FLY_ORG="$2"
      shift 2
      ;;
    --skip-create)
      CREATE_APP=0
      shift
      ;;
    --skip-secrets)
      SET_SECRETS=0
      shift
      ;;
    --stage-only|--no-deploy)
      DEPLOY=0
      SMOKE=0
      shift
      ;;
    --no-smoke)
      SMOKE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -f "$CONFIG" ]] || die "Fly config not found: $CONFIG"

if [[ -n "${FLY_BIN:-}" ]]; then
  fly_bin="$FLY_BIN"
elif command -v fly >/dev/null 2>&1; then
  fly_bin="$(command -v fly)"
elif command -v flyctl >/dev/null 2>&1; then
  fly_bin="$(command -v flyctl)"
else
  die "flyctl is not installed. Install it from https://fly.io/docs/flyctl/install/."
fi

fly_cmd=("$fly_bin")
if [[ -n "${FLY_API_TOKEN:-}" ]]; then
  fly_cmd+=("--access-token" "$FLY_API_TOKEN")
fi

if ! "${fly_cmd[@]}" auth whoami >/dev/null 2>&1; then
  die "Fly auth is not configured. Run 'fly auth login' locally or export FLY_API_TOKEN."
fi

echo "Using Fly app: $APP_NAME"
echo "Using Fly config: $CONFIG"

if [[ "$CREATE_APP" -eq 1 ]]; then
  list_args=(apps list --quiet)
  if [[ -n "${FLY_ORG:-}" ]]; then
    list_args+=(--org "$FLY_ORG")
  fi

  apps_output="$("${fly_cmd[@]}" "${list_args[@]}")"
  if printf '%s\n' "$apps_output" | grep -Fxq "$APP_NAME"; then
    echo "Fly app '$APP_NAME' already exists."
  else
    create_args=(apps create "$APP_NAME" --yes)
    if [[ -n "${FLY_ORG:-}" ]]; then
      create_args+=(--org "$FLY_ORG")
    fi
    echo "Creating Fly app '$APP_NAME'..."
    "${fly_cmd[@]}" "${create_args[@]}"
  fi
else
  echo "Skipping Fly app creation."
fi

if [[ "$SET_SECRETS" -eq 1 ]]; then
  required_secret_names=(
    EMAIL_POSTGRES_URL
    EMAIL_SECRET_ENCRYPTION_KEY
    GOOGLE_OAUTH_CLIENT_ID
    GOOGLE_OAUTH_CLIENT_SECRET
    SUPABASE_SERVICE_ROLE_KEY
  )
  optional_secret_names=(
    EMAIL_SECRET_ENCRYPTION_KEY_ID
    APNS_KEY_ID
    APNS_TEAM_ID
    APNS_PRIVATE_KEY
    APNS_ENVIRONMENT
    APNS_IOS_TOPIC
    APNS_MACOS_TOPIC
  )

  missing_secret_names=()
  secret_args=()
  for name in "${required_secret_names[@]}"; do
    if [[ -z "${!name:-}" ]]; then
      missing_secret_names+=("$name")
    else
      secret_args+=("$name=${!name}")
    fi
  done

  if [[ "${#missing_secret_names[@]}" -gt 0 ]]; then
    echo "Missing required secret environment variables:" >&2
    printf '  %s\n' "${missing_secret_names[@]}" >&2
    echo "Set them in your shell, or rerun with --skip-secrets if they are already configured in Fly." >&2
    exit 2
  fi

  for name in "${optional_secret_names[@]}"; do
    if [[ -n "${!name:-}" ]]; then
      secret_args+=("$name=${!name}")
    fi
  done

  echo "Staging ${#secret_args[@]} Fly secrets..."
  "${fly_cmd[@]}" secrets set -a "$APP_NAME" -c "$CONFIG" --stage "${secret_args[@]}"
else
  echo "Skipping Fly secret staging."
fi

if [[ "$DEPLOY" -eq 1 ]]; then
  echo "Deploying '$APP_NAME'..."
  "${fly_cmd[@]}" deploy . -a "$APP_NAME" -c "$CONFIG" --now

  if [[ "$SMOKE" -eq 1 ]]; then
    health_url="${EMAIL_HEALTH_URL:-https://${APP_NAME}.fly.dev/api/health}"
    echo "Checking $health_url..."
    curl -fsS "$health_url" >/dev/null
    echo "Health check passed."
  fi
else
  echo "Skipping deploy."
fi
