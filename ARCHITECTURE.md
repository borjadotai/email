# Architecture

## Goals

- Keep the user-facing apps native, fast, and simple.
- Keep provider sync and indexing out of the apps.
- Store enough indexed history to make search fast without forcing every device
  to download full mail history and attachments.
- Support multiple accounts with a global inbox as the default view.
- Make Gmail and iCloud provider support pluggable.

## Shape

```text
Apps/Email.xcodeproj          Native macOS and iOS targets
Apps/Email/Shared             Shared SwiftUI UI, models, API client, store
server/src                    HTTP/SSE server, provider adapters, storage
supabase/migrations           Hosted Postgres/Auth/Storage schema
scripts                       Server install/build helpers
script/build_and_run.sh       Codex/macOS build and launch entrypoint
```

## Server

The server owns account connection state, mail history, indexing, sending, and tracking. Apps communicate with it over HTTP and listen for live updates over Server-Sent Events.

Personal/local storage uses SQLite with WAL mode and an FTS5 table. Metadata stays normalized in relational tables while message text is indexed into `email_fts`.

Hosted storage targets Supabase Postgres with a direct `user_id` tenant column
on user-owned rows, RLS policies based on `auth.uid()`, GIN full-text search
indexes, a private provider-secret schema, and private object storage for raw
messages or attachments.

Provider integration is split behind adapters:

- Gmail: server-owned OAuth 2.0 loopback flow with PKCE, Gmail API sync, Gmail API send, and local label import.
- iCloud: app-specific password verification, IMAP INBOX sync, and SMTP send. Sign in with Apple is not a mail-access grant.
- Secrets: Google OAuth client credentials live only in the server runtime
  environment. Gmail refresh tokens and iCloud app-specific passwords are stored
  by the server in the macOS Keychain for local macOS runs, or an encrypted
  file/private database store for hosted runs. The native apps receive no
  provider secrets.
- Outbound: queued in `outbound_messages`, then provider adapters send and update status.
- Open tracking: tracked messages receive a tracking id and can embed `/api/track/open/:id.gif`.

## Apps

The macOS and iOS apps share:

- API client
- Observable app store
- Codable models
- Inbox, preview, compose, add-account, label, and settings views

The macOS target uses the same split-view foundation but gets desktop affordances through toolbars, sidebar layout, keyboard-friendly controls, and a native Settings scene. iOS uses the same `NavigationSplitView`, which collapses naturally on iPhone.

## Search

Search requests go to the server so every platform uses the same indexed history. FTS queries are normalized into prefix terms, joined against the email table, and sorted by `bm25(email_fts)` plus recent received date.
