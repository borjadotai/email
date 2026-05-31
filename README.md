# Email

Self-hosted native email clients for macOS and iOS.

The important idea is simple: the private part runs on a machine you control, and
the apps are just clients. The macOS and iOS apps should not contain Google
secrets, account passwords, refresh tokens, or a private `.env` file. They talk
to your server over HTTPS when accessed from other devices, and your server
stores mail, syncs accounts, sends messages, and keeps provider credentials
private.

## Start Here

The easiest personal setup is:

1. Pick one always-on machine as the email server. A Mac mini, desktop Mac, or a
   MacBook that usually stays on works well.
2. Run the guided `carta setup` flow on that machine.
3. Connect Gmail, iCloud, or IMAP accounts during setup.
4. Install the macOS app, and optionally the iOS app.

For access away from home, put all of your devices on the same private network
with Tailscale. `carta setup` configures Tailscale Serve by default so the apps
use an HTTPS tailnet URL while the local server stays bound to loopback.

## What Runs Where

- Server machine: stores SQLite mail data, talks to Gmail/iCloud, sends mail,
  keeps OAuth secrets and account tokens in the server environment and macOS
  Keychain.
- macOS app: native email client, no provider secrets, updates from GitHub
  Releases with Sparkle.
- iOS app: native email client, no provider secrets, distributed through
  TestFlight/internal builds while public App Store distribution is not set up.
- GitHub repo/releases: safe to be public. Release artifacts can contain public
  configuration like a default server URL, but not private provider secrets.

## Server Setup

The recommended path is the standalone Carta CLI:

```sh
npm install -g github:borjadotai/email#main
carta setup
```

Interactive setup creates the local Carta profile, configures the private mail
database, helps connect Gmail/iCloud/IMAP accounts, and can install the macOS
LaunchAgent so the server keeps running after restarts. When Tailscale is
available, setup defaults to an HTTPS Tailscale URL such as:

```text
https://email.marlin-barbel.ts.net
```

That URL is the default baked into the macOS and iOS app builds in this repo.
CLI data is stored at:

```text
~/Library/Application Support/CartaCLI/mail.sqlite
```

To test onboarding again from scratch:

```sh
carta reset --yes
carta setup
```

### Carta CLI

The local server is also packaged as the `carta` CLI for agent access and
headless installs. From a checkout:

```sh
carta setup --expose tailscale
carta accounts add gmail
carta accounts add imap --email you@example.com --imap-host imap.example.com --smtp-host smtp.example.com
carta sync run --account all
carta list --mailbox inbox --unread
carta server install
```

To test onboarding again from scratch, use `carta reset --yes` before rerunning
`carta setup`. Reset preserves the bundled Carta relay by default so Gmail setup
can still use the production relay; pass `--all` to clear custom relay config
too.

Interactive `carta setup` asks whether it should install the macOS background
server. For scripts, pass `--install-server` to do that as part of setup, or
`--no-install-server` to skip it explicitly.

To test the installable package:

```sh
npm run package:cli
npm install -g ./dist/carta-email-*.tgz
carta status
```

See `docs/carta-cli.md` for the full command surface.

For distributed CLI builds, Gmail sign-in and APNs delivery should use the Carta
relay instead of shipping Google OAuth or Apple push secrets in the CLI. Gmail
uses the bundled production relay URL automatically; user refresh tokens remain
in the local Keychain.

For local CLI testing without real accounts:

```sh
carta fixtures seed
carta search --from Taylor --since 7d
carta search invoice --has-attachments --attachment-kind invoice
carta send --account alex.fixture@gmail.test --to pat@example.test --subject "Hello" --body "See attached" --attach ./example.pdf
carta reply fixture-gmail-taylor-roadmap --body "Okay, got it"
carta forward fixture-gmail-stripe-invoice --to finance@example.test --body "Please process" --include-attachments
```

Server logs are written to:

```text
~/Library/Logs/CartaCLI/server.log
~/Library/Logs/CartaCLI/server.error.log
```

### Background Polling

The apps poll the server every five minutes while they are running. On iOS, the
app also schedules a `BGAppRefreshTask` when it goes into the background; iOS
chooses the actual wake time, so this is best-effort rather than exact. When a
background poll imports new unread inbox mail, the app shows a local
notification that opens the message.

### Push Notifications

Remote APNs notifications require both Apple-side capabilities and an always-on
server that discovers new mail. The apps register with APNs on launch, post
their device token to `POST /api/push/tokens`, and the server sends a push when
a sync imports new unread inbox mail. For production, send pushes through the
Carta relay so APNs private keys stay off user machines.

Required server settings:

```sh
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_PRIVATE_KEY_PATH=/absolute/path/AuthKey_XXXXXXXXXX.p8
APNS_ENVIRONMENT=development
APNS_IOS_TOPIC=com.borjadotai.email.ios
APNS_MACOS_TOPIC=com.borjadotai.email.mac
EMAIL_AUTO_SYNC=1
EMAIL_AUTO_SYNC_INTERVAL_MS=60000
EMAIL_AUTO_SYNC_LIMIT=50
```

Relay mode replaces the local APNs key settings with:

```sh
carta relay configure --url https://relay.example.com --token shared-relay-token
EMAIL_AUTO_SYNC=1
```

Apple setup:

1. In Certificates, Identifiers & Profiles, use explicit App IDs for
   `com.borjadotai.email.ios` and `com.borjadotai.email.mac`.
2. Enable Push Notifications on both App IDs.
3. Regenerate/download provisioning profiles after enabling the capability.
4. Create an APNs Auth Key with Push Notifications enabled, then put its Key ID,
   Team ID, and `.p8` path in the server environment. Keep the `.p8` out of git.

For iOS, Xcode automatic signing should refresh the provisioning profile once the
capability is enabled. For direct macOS distribution, package with a Developer ID
provisioning profile that includes the macOS APNs entitlement:

```sh
EMAIL_MAC_PROVISIONING_PROFILE=/absolute/path/EmailMac.provisionprofile \
DEVELOPER_ID_APPLICATION="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE=email-notary \
npm run package:mac
```

After launching a signed app once so it can register its device token, send a
test notification:

```sh
curl -X POST http://127.0.0.1:7332/api/push/test
```

## Add Accounts

### Gmail

Gmail sign-in goes through the Carta relay. The relay owns the Google OAuth
client secret, while the local Carta server receives the callback code, asks the
relay to exchange it, and stores the user's refresh token locally. Normal users
do not create Google OAuth clients or import Google secrets.

For private testing across your own devices, proxy the local CLI server through
the Carta Tailscale Service:

```sh
tailscale serve --yes --service=svc:email --https=443 http://127.0.0.1:7332
```

This repo's checked-in macOS and iOS defaults use this Mac's current private
Tailscale endpoint:

```text
https://email.marlin-barbel.ts.net
```

Client devices must be signed into the same tailnet and use that Tailscale URL
as the app's server URL.

Broad public Gmail distribution requires Google OAuth consent screen
configuration and, because this app requests Gmail mail access scopes, Google
verification before broad external use.

### iCloud

iCloud does not use Sign in with Apple for mail access. Generate an app-specific
password at `https://account.apple.com`, then add the account from the app with
your iCloud Mail address and that app-specific password. The server verifies
IMAP/SMTP and stores the password in the server Mac's Keychain.

### Generic IMAP/SMTP

For other providers, connect through the CLI with the provider's IMAP and SMTP
settings:

```sh
carta accounts add imap \
  --email you@example.com \
  --password "app-or-mail-password" \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com
```

Pass `--username`, `--smtp-username`, `--smtp-password`, `--imap-port`,
`--imap-secure`, `--smtp-port`, and `--smtp-secure` when the provider needs
non-default settings.

## Install the Clients

### macOS

Download the latest `Email-mac.dmg` from:

```text
https://github.com/borjadotai/email/releases/latest
```

Drag `Email.app` to Applications and open it. Current builds default to this
tailnet URL:

```text
https://email.marlin-barbel.ts.net
```

You can still override the Server URL in Settings when testing another server.

The app includes Sparkle updates. It checks automatically, and you can also use
Email -> Check for Updates... or Settings -> General -> Updates.

Current public test builds are not Developer ID notarized yet. For smooth
one-click public distribution, the release workflow still needs Apple Developer
ID signing and notarization configured.

### iOS

Install the current TestFlight build when available, or install from Xcode:

1. Open `Apps/Email.xcodeproj`.
2. Select the `EmailiOS` scheme.
3. Select your iPhone.
4. Set your signing team if Xcode asks.
5. Press Run.

Open the app on the phone. Current builds default to the same HTTPS Tailscale
server URL as the macOS app.

## Keep It Updated

To update the server on the always-on Mac:

```sh
npm install -g github:borjadotai/email#main
carta server restart
```

To update the macOS app, use Sparkle's automatic updates or Email -> Check for
Updates.... The app update does not need provider secrets because it only talks
to your server.

To update iOS for now, pull the latest repo in Xcode and run the app again on
the device.

## Troubleshooting

- If the app cannot connect, open `https://email.marlin-barbel.ts.net/api/health` from the
  same device or network.
- If that works locally but not from another device, confirm the device is
  signed into the same tailnet and that `tailscale serve status` points
  `svc:email` at `http://127.0.0.1:7332`.
- If Gmail setup fails, run `carta doctor` and confirm Gmail OAuth reports relay
  mode.
- If the server does not start, check
  `~/Library/Logs/CartaCLI/server.error.log`.

## Developer Commands

Run the Carta server manually:

```sh
npm install
npm run carta -- server start
```

Build the apps:

```sh
npm run build:mac
npm run build:ios
```

The Codex run action uses:

```sh
./script/build_and_run.sh --install
```

That script requires a healthy Carta CLI server, builds the macOS app, copies the fresh build to:

```text
~/Applications/Email.app
```

and launches it. Re-run the command after app changes to update the installed local app. To install somewhere else, set `EMAIL_MAC_INSTALL_DIR`:

```sh
EMAIL_MAC_INSTALL_DIR=/Applications ./script/build_and_run.sh --install
```

## Package the macOS App

For a shareable macOS build:

```sh
npm run package:mac
```

This creates:

```text
dist/Email.app
dist/Email-mac.zip
dist/Email-mac.dmg
```

The packaged app is a client only. Provider secrets, mail data, Node, and the
Carta server are not bundled into the app. For builds that should use a shared
or personal Carta server by default, bake only that server URL into the app:

```sh
EMAIL_RELEASE_SERVER_URL=https://email.marlin-barbel.ts.net npm run package:mac
```

Run the Carta CLI server separately on the machine that owns the mail data.
Public direct-download distribution requires Developer ID signing and
notarization:

```sh
DEVELOPER_ID_APPLICATION="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE=email-notary \
npm run package:mac
```

If the macOS build should receive APNs pushes, also pass a Developer ID
provisioning profile for `com.borjadotai.email.mac` that includes Push
Notifications:

```sh
EMAIL_MAC_PROVISIONING_PROFILE=/absolute/path/EmailMac.provisionprofile \
DEVELOPER_ID_APPLICATION="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE=email-notary \
npm run package:mac
```

Create the notary profile once with:

```sh
xcrun notarytool store-credentials email-notary \
  --apple-id "you@example.com" \
  --team-id TEAMID \
  --password "app-specific-password"
```

Without `DEVELOPER_ID_APPLICATION`, the script still creates unsigned artifacts for local inspection, but those are not suitable for public downloads because Gatekeeper will warn or block them on other Macs.

## GitHub Downloads

GitHub Actions builds a downloadable macOS artifact on every push to `main` and when run manually:

1. Open the repository on GitHub.
2. Go to Actions -> macOS App.
3. Open the latest successful run.
4. Download the `Email-macOS-...` artifact.

Artifacts from normal workflow runs expire after 14 days. For durable downloads, push a version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Tags starting with `v` create or update a GitHub Release and attach:

```text
Email-mac.dmg
Email-mac.zip
appcast.xml
checksums.txt
```

The macOS app uses Sparkle 2 for updates. Its feed URL is:

```text
https://github.com/borjadotai/email/releases/latest/download/appcast.xml
```

Sparkle automatic checks and automatic installs are enabled by default. The app also adds update controls at Email -> Check for Updates... and Settings -> General -> Updates. The feed and update zip must be publicly reachable by the installed app; private GitHub release assets cannot be fetched by Sparkle.

Unsigned artifacts are useful for private testing, but public downloads should be signed and notarized. Configure these GitHub repository secrets to enable that in the workflow:

```text
MACOS_DEVELOPER_ID_CERTIFICATE_BASE64
MACOS_DEVELOPER_ID_CERTIFICATE_PASSWORD
DEVELOPER_ID_APPLICATION
APPLE_ID
APPLE_TEAM_ID
APPLE_APP_SPECIFIC_PASSWORD
SPARKLE_PRIVATE_KEY
```

`MACOS_DEVELOPER_ID_CERTIFICATE_BASE64` is a base64-encoded `.p12` export of the Developer ID Application certificate. `DEVELOPER_ID_APPLICATION` should match the identity name, for example:

```text
Developer ID Application: Your Name (TEAMID)
```

Optionally set the GitHub repository variable `EMAIL_RELEASE_SERVER_URL` to the backend endpoint that release builds should use by default. Do not store provider secrets in release build variables or bundle them into the app. This URL is embedded in public app artifacts, so treat it as public configuration.

`SPARKLE_PRIVATE_KEY` is the exported private EdDSA key from Sparkle's `generate_keys` tool. The matching public key is embedded in the app as `SUPublicEDKey`.

## Server API

Core endpoints live under `/api`:

- `GET /api/health`
- `GET /api/accounts`
- `POST /api/accounts`
- `GET /api/auth/settings`
- `POST /api/auth/gmail/start`
- `GET /api/auth/gmail/callback`
- `POST /api/auth/icloud/connect`
- `POST /api/accounts/:id/sync`
- `GET /api/mailboxes`
- `GET /api/labels`
- `POST /api/labels`
- `GET /api/emails?q=&accountId=&mailboxId=&labelId=`
- `GET /api/emails/:id`
- `PATCH /api/emails/:id`
- `POST /api/emails/:id/labels`
- `POST /api/messages/send`
- `GET /api/events`
- `GET /api/track/open/:trackingId.gif`

## Runtime Notes

- `EMAIL_INITIAL_SYNC_LIMIT` controls how many messages are imported per sync pass. The default is `500`.
- `EMAIL_HISTORY_BACKFILL_LIMIT` controls how many older messages are imported per historical backfill pass. The default is `500`.
- `EMAIL_HISTORY_BACKFILL_INTERVAL_MS` controls how often the server runs an automatic history backfill pass. The default is `60000`.
- `EMAIL_AUTO_HISTORY_BACKFILL=0` disables automatic historical backfill.
- `EMAIL_AUTO_SYNC=1` enables the always-on server to poll connected accounts for new recent mail and send APNs pushes for new unread inbox messages.
- `EMAIL_AUTO_SYNC_INTERVAL_MS` controls that poll interval. The default is `60000`; values below `15000` are clamped.
- `EMAIL_AUTO_SYNC_LIMIT` controls how many recent messages each automatic sync pass checks. The default is `50`.
- `EMAIL_PUBLIC_BASE_URL` must point at a reachable server URL for Gmail OAuth callbacks and outbound open tracking pixels to work outside the local machine.
- Normal sync keeps recent mail current. Historical backfill pages older Gmail and iCloud mailbox history into the local SQLite/FTS index so search and saved filters can cover the full account over time.
