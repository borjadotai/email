# Architecture

## Goals

- Keep the user-facing apps native, fast, and simple.
- Keep provider sync and indexing out of the apps.
- Store enough local history to make search instant and available offline.
- Support multiple accounts with a global inbox as the default view.
- Make Gmail and iCloud provider support pluggable.

## Shape

```text
Apps/Email.xcodeproj          Native macOS and iOS targets
Apps/Email/Shared             Shared SwiftUI UI, models, API client, store
server/src                    Local HTTP/SSE server and SQLite storage
scripts                       Server install/build helpers
script/build_and_run.sh       Codex/macOS build and launch entrypoint
```

## Server

The server owns account connection state, mail history, indexing, sending, and tracking. Apps communicate with it over HTTP and listen for live updates over Server-Sent Events.

Storage uses SQLite with WAL mode and an FTS5 table. Metadata stays normalized in relational tables while message text is indexed into `email_fts`.

Provider integration is split behind adapters:

- Gmail: OAuth 2.0 loopback flow, Gmail API sync, Gmail API send, and local label import.
- iCloud: app-specific password verification, IMAP INBOX sync, and SMTP send.
- Secrets: OAuth client secrets, Gmail refresh tokens, and iCloud app-specific passwords are stored in the macOS Keychain.
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
