#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DEFAULT_HOST="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo email-server)"
DEFAULT_PUBLIC_URL="http://$DEFAULT_HOST.local:7331"

quote_env() {
  node -e '
const value = process.argv[1] ?? "";
if (!value || /^[A-Za-z0-9_./:@-]+$/u.test(value)) {
  process.stdout.write(value);
} else {
  process.stdout.write(JSON.stringify(value));
}
' "$1"
}

upsert_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"

  if [[ -f "$ENV_FILE" ]]; then
    grep -v -E "^${key}=" "$ENV_FILE" > "$tmp" || true
  fi

  printf '%s=%s\n' "$key" "$(quote_env "$value")" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

cd "$ROOT_DIR"

echo "Email server setup"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer is required. Install it from https://nodejs.org/ and rerun this script." >&2
  exit 127
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 24 )); then
  echo "Node.js 24 or newer is required. Found $(node -v)." >&2
  exit 1
fi

echo "Installing server dependencies..."
npm install

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  echo "Created .env"
else
  echo "Using existing .env"
fi

echo
echo "Enter the server URL that your Mac/iPhone clients can reach."
echo "For a Mac mini on the same network, this is often something like $DEFAULT_PUBLIC_URL."
read -r -p "Server URL [$DEFAULT_PUBLIC_URL]: " public_url
public_url="${public_url:-$DEFAULT_PUBLIC_URL}"
public_url="${public_url%/}"

upsert_env "EMAIL_SERVER_HOST" "0.0.0.0"
upsert_env "EMAIL_SERVER_PORT" "7331"
upsert_env "EMAIL_PUBLIC_BASE_URL" "$public_url"

echo
echo "Updated .env with:"
echo "  EMAIL_SERVER_HOST=0.0.0.0"
echo "  EMAIL_SERVER_PORT=7331"
echo "  EMAIL_PUBLIC_BASE_URL=$public_url"

echo
read -r -p "Install the always-on macOS LaunchAgent now? [Y/n]: " install_agent
case "${install_agent:-Y}" in
  y|Y|yes|YES)
    "$ROOT_DIR/scripts/install-launch-agent.sh"
    sleep 1
    if curl -fsS "http://127.0.0.1:7331/api/health" >/dev/null 2>&1; then
      echo "Server is running locally."
    else
      echo "LaunchAgent installed, but the local health check did not answer yet."
      echo "Check logs in ~/Library/Logs/EmailApp/server.error.log"
    fi
    ;;
  *)
    echo "Skipped LaunchAgent install. Start the server manually with: npm run server"
    ;;
esac

echo
echo "Next steps:"
echo "1. In Google Cloud, add this authorized redirect URI:"
echo "   $public_url/api/auth/gmail/callback"
echo "2. Download the Google OAuth JSON and import it on this server:"
echo "   node scripts/import-google-oauth.mjs ~/Downloads/client_secret_*.json"
echo "3. Restart the server after importing Google credentials:"
echo "   launchctl kickstart -k \"gui/\$(id -u)/com.borjadotai.email.server\""
echo "4. Install the macOS or iOS client and set its Server URL to:"
echo "   $public_url"
