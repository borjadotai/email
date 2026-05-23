# Email

A private native email app foundation with:

- A local always-on server for account sync, message storage, outbound mail, open tracking, and search.
- SQLite + FTS5 storage for fast full-history search.
- Native SwiftUI macOS and iOS app targets sharing one UI/client layer.
- Multi-account inbox views, folders, labels, compose/send flow, settings, and system/light/dark theming.

## Run the Server

```sh
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

## Current Scope

This first commit is the product foundation. Gmail and iCloud are modeled as account providers and the server has adapter boundaries for OAuth, IMAP/SMTP, and full-history sync. Real provider credential flows are intentionally isolated from the UI and storage layer so they can be added without reshaping the app.

