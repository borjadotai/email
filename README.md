# Email

A private native email app foundation with:

- A local always-on server for account sync, message storage, outbound mail, open tracking, and search.
- SQLite + FTS5 storage for fast full-history search.
- Native SwiftUI macOS and iOS app targets sharing one UI/client layer.
- Multi-account inbox views, folders, labels, compose/send flow, settings, and system/light/dark theming.

## Run the Server

```sh
npm install
npm run server:dev
```

The server listens on `http://127.0.0.1:7331` by default and stores data in:

```text
~/Library/Application Support/EmailApp/mail.sqlite
```

For an always-running local daemon:

```sh
./scripts/install-launch-agent.sh
```

Copy `.env.example` to `.env` for local app-owned provider credentials. The launch agent reads `.env` through `scripts/start-server.sh`.

## Build the Apps

```sh
npm run build:mac
npm run build:ios
```

The Codex run action uses:

```sh
./script/build_and_run.sh
```

That script starts the server if needed, builds the macOS app, and launches it.

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

## Real Account Setup

### Gmail

1. In Google Cloud Console, enable the Gmail API for the project.
2. Create an OAuth client for a web application.
3. Add this authorized redirect URI:

```text
http://127.0.0.1:7331/api/auth/gmail/callback
```

4. Configure the app/server with `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
5. Use Add Account -> Gmail. The app opens the system browser for Google OAuth and receives the callback at:

```text
http://127.0.0.1:7331/api/auth/gmail/callback
```

Users do not enter Google OAuth client credentials. Those credentials belong to the app build or server environment. Per-account refresh tokens are stored in the macOS Keychain under the `EmailApp` service. Gmail sync currently imports recent messages into local SQLite/FTS and maps Gmail user labels into local labels.

After creating the OAuth client, download its JSON file and import it locally:

```sh
node scripts/import-google-oauth.mjs ~/Downloads/client_secret_*.json
launchctl kickstart -k "gui/$(id -u)/com.borjadotai.email.server"
```

### iCloud

1. Generate an app-specific password at `https://account.apple.com`.
2. Use Add Account -> iCloud with your iCloud Mail address and the generated password.

Sign in with Apple identifies a user to an app, but it does not provide iCloud Mail IMAP/SMTP access. The server verifies IMAP and SMTP before saving the account. It stores the app-specific password in the macOS Keychain, imports INBOX messages over IMAP, and sends via iCloud SMTP.

Public Gmail distribution will require Google OAuth consent screen configuration and, because this app requests Gmail mail access scopes, Google verification before broad external use.

## Runtime Notes

- `EMAIL_INITIAL_SYNC_LIMIT` controls how many messages are imported per sync pass. The default is `500`.
- `EMAIL_PUBLIC_BASE_URL` must point at a reachable server URL for outbound open tracking pixels to work outside the local machine.
- The current iCloud importer focuses on INBOX. Gmail imports all non-spam/trash messages returned by the Gmail API and places them into Inbox, Sent, Drafts, Trash, or Archive based on Gmail system labels.
