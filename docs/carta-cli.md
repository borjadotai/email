# Carta CLI

The Carta CLI packages the local email server as an agent-friendly command line
tool. It uses the same SQLite mail store and provider adapters as the macOS and
iOS apps.

## Installable Package

The package exposes the `carta` binary and can be packed or installed globally:

```sh
npm pack --dry-run
npm run package:cli
npm run smoke:package
npm run verify:cli
npm install -g ./dist/carta-email-0.1.25.tgz
carta help
```

`npm run smoke:package` packs the CLI into a temporary tarball, installs it into
a temporary npm prefix, and runs the installed `carta` binary against an isolated
database. It covers setup, fixture search, send/reply commands, and LaunchAgent
rendering. It also starts the installed HTTP server and checks the health,
accounts, emails, auth settings, email detail, mark-read, and archive endpoints
without touching your real `~/Library/Application Support/CartaCLI` data. It
also verifies `carta reset` against that temporary install.

`npm run verify:cli` runs the full local CLI readiness gate: unit tests, relay
tests, package smoke, relay first-run smoke, tarball packaging, whitespace
checks, and a secret scan over the current git diff. The relay smoke uses the
bundled Carta relay URL and does not need a local relay token for Gmail OAuth.

## Quick Start

```sh
carta setup
carta status
carta reset --yes
carta connection
carta doctor
```

For non-interactive setup:

```sh
carta setup \
  --name "Alex Carter" \
  --email alex@example.com \
  --history last-month \
  --attachments true \
  --no-account \
  --install-server
```

The installed `carta` binary defaults to its own local data directory at
`~/Library/Application Support/CartaCLI` on macOS, `$XDG_DATA_HOME/CartaCLI` or
`~/.local/share/CartaCLI` on Linux, and port `7332`. macOS stores account
secrets in Keychain; Linux stores them in `secrets.json` inside the Carta CLI
data directory with `0600` permissions.

The standalone CLI does not read an ambient project `.env` by default. Pass
settings as `CARTA_*` environment variables, or set `CARTA_LOAD_DOTENV=1` when
you intentionally want local development values from the current directory.

To test onboarding again from a clean local profile, run:

```sh
carta reset --yes
carta setup
```

`carta reset` clears the Carta CLI profile, connected accounts, local mail,
sync state, and account secrets. It preserves the stored Carta relay by default
so Gmail setup can still use the production relay. Pass `--all` or
`--keep-relay false` to clear stored custom relay configuration; the bundled
production relay URL remains available. Use `--dry-run` to see what would be
removed.

On macOS, interactive setup asks whether it should install the background server
LaunchAgent. Non-interactive setup does not install it unless you pass
`--install-server`; use `--no-install-server` to skip the prompt.

## Server Access

`carta setup` asks how client apps should reach the local server. Tailscale is
the recommended mode for personal installs because it keeps the server reachable
inside your private tailnet without opening it to the public internet.

If Tailscale is installed and signed in, setup detects the tailnet DNS name/IP,
configures Tailscale Serve HTTPS on port `8443`, stores that HTTPS URL in the
CLI database, and configures `carta server start` to bind locally on
`127.0.0.1`:

```sh
carta setup --expose tailscale
carta status
```

The default proxy is:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:7332
```

If a matching `tailscale serve` proxy already points at the Carta CLI port, setup
uses that HTTPS Serve URL. If Serve cannot be configured, setup falls back to the
private direct tailnet URL and prints a warning; pass `--no-tailscale-serve` when
you deliberately want that direct HTTP mode.

For local-only or explicit open-port testing:

```sh
carta setup --expose local-only
carta setup --expose open-port --public-url http://your-host.example:7332 --allow-insecure-open-port
```

Open-port mode does not add Carta API authentication. It is only for machines
already protected by your own firewall, VPN, reverse proxy, or equivalent
network control. Non-interactive setup refuses open-port mode unless
`--allow-insecure-open-port` is present.

## Connect Accounts

Production Gmail auth goes through the bundled Carta relay so the CLI does not
ship Google OAuth client secrets, and normal users do not choose a relay during
setup. To inspect the effective relay:

```sh
carta relay status
```

For custom relay testing, configure it explicitly:

```sh
carta relay configure --url https://relay.example.com --token relay-token
```

The relay owns the Google OAuth client secret, exchanges authorization codes,
and refreshes short-lived access tokens for the local server. User refresh
tokens remain in the local Keychain. `carta doctor` reports Gmail as `relay`
when this is active.

For local development only, the CLI still supports direct Desktop OAuth with:

```sh
CARTA_GOOGLE_OAUTH_CLIENT_ID=... \
CARTA_GOOGLE_OAUTH_CLIENT_SECRET=... carta accounts add gmail
```

Do not ship that Desktop client secret in the CLI package.

By default, Gmail CLI auth sends Google back to the fixed local callback and
uses the relay only for the secret-bearing code exchange. That keeps the Google
client secret off the user's machine while leaving refresh tokens in the local
Keychain. Pass `--callback-url` or `--use-public-callback` only when
intentionally testing a different local callback.

```sh
carta accounts add gmail --history last-year --attachments true
carta accounts add gmail --history last-week --attachments false
```

iCloud uses an app-specific password:

```sh
carta accounts add icloud \
  --email alex@icloud.com \
  --app-password xxxx-xxxx-xxxx-xxxx \
  --history last-year \
  --attachments true
```

Generic IMAP/SMTP accounts use the provider's mail server settings:

```sh
carta accounts add imap \
  --email alex@example.com \
  --password "app-or-mail-password" \
  --imap-host imap.example.com \
  --imap-port 993 \
  --imap-secure true \
  --smtp-host smtp.example.com \
  --smtp-port 587 \
  --smtp-secure false \
  --history last-year \
  --attachments true
```

Use `--username`, `--smtp-username`, and `--smtp-password` when the provider's
login differs from the email address or IMAP password.

## Sync And Inspect

```sh
carta accounts providers
carta accounts list
carta connection --check
carta sync run --account all --history last-year
carta sync run --account all --history last-month
carta sync status
carta status
carta list --mailbox inbox --unread
carta search "invoice from stripe"
carta show EMAIL_ID
carta archive EMAIL_ID
carta mark-read EMAIL_ID
```

`carta sync run` prints each recent-sync and backfill step before it starts. In
interactive terminals it also prints a periodic heartbeat with the current local
email count, unread count, and oldest imported date, so slow provider calls do
not look frozen while network calls are in flight. If a run stops because of a
batch limit, `carta sync status` reports `partial`; run the sync command again
to continue.

For agent integrations, add `--json` to commands that return data:

```sh
carta status --json
carta sync run --account all --json
carta sync status --json
carta list --mailbox inbox --unread --json
carta search "from:alex roadmap" --json
carta show EMAIL_ID --json
carta archive EMAIL_ID --json
```

## Send And Reply

The CLI can create outbound sent-mail records and then attempt provider delivery.
If delivery fails, the provider error is returned and the local outbound row is
marked failed.

```sh
carta send \
  --account alex@example.com \
  --to friend@example.com \
  --subject "Hello" \
  --body "Sent from Carta CLI" \
  --attach ./invoice.pdf

carta reply EMAIL_ID --body "Thanks, will do."
carta forward EMAIL_ID --to finance@example.com --body "FYI" --include-attachments
```

## Local Fixtures

For agent and CLI smoke tests, seed deterministic fake Gmail/iCloud accounts and
messages:

```sh
carta fixtures seed
```

Useful fixture queries:

```sh
carta search --from Taylor --since 7d --json
carta search newsletter --limit 10 --json
carta search invoice --has-attachments --attachment-kind invoice --json
```

## Server Mode

```sh
carta server start
carta server install
carta server status --check
carta server restart
carta server uninstall
```

This starts the same local HTTP API used by the macOS and iOS clients.
`carta server install` creates a separate background service for the current
platform. On macOS it installs a LaunchAgent named
`com.carta.email.cli.server`, with logs under `~/Library/Logs/CartaCLI`. On
Linux it installs a systemd service named `carta-email-cli.service`; non-root
users get a user service under `~/.config/systemd/user`, while root gets a
system service under `/etc/systemd/system`. `carta setup --install-server` uses
the same installer after profile, access, relay, and account setup finish.

For a VPS test run over SSH, a typical first pass is:

```sh
npm install -g carta-email
carta setup --history last-week --attachments false
carta server install
carta server status --check
```

If you install a user systemd service and want it to keep running after SSH
logout, enable lingering once:

```sh
loginctl enable-linger "$USER"
```

For Gmail OAuth on a headless VPS, run `carta setup` in the SSH session, copy the
printed Google URL into a browser on your laptop, complete Google sign-in, and
let the browser redirect to `127.0.0.1:7332`. If the browser is not on the VPS,
keep a temporary SSH tunnel open while connecting the account:

```sh
ssh -L 7332:127.0.0.1:7332 root@your-vps
carta setup --history last-week --attachments false
```

## Current Scope

This first CLI slice supports local Carta profiles, Gmail, iCloud, sync status,
generic IMAP/SMTP, sync status, backfill windows, attachment download policy,
search, read/show, send/reply, local mailbox actions, and server startup.
Hosted Carta/Supabase identity is the next packaging layer, not required for
the local brain to work.
