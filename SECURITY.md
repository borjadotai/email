# Security Model

This repository is intended to be public-safe.

## What can be public

- SwiftUI app source code.
- Server source code.
- Build and packaging scripts.
- Sparkle public key (`SUPublicEDKey`).
- Release artifacts, including the macOS app, DMG, zip, `appcast.xml`, and checksums.
- Backend URL defaults embedded into release builds. These are app configuration, not credentials.

## What must stay private

- `.env` files with real values.
- Google OAuth client secrets.
- Apple app-specific passwords.
- Gmail refresh tokens.
- Sparkle private signing key.
- Developer ID certificate exports and notarization credentials.
- SQLite mail databases and derived server state.

## Runtime Layout

The macOS/iOS apps talk to the configured server endpoint. Debug builds default
to a local server, while Release builds can default to the shared hosted API.
Provider credentials stay on the machine or service running the server, such as
a private Mac mini, a tailnet host, or the Fly.io runtime.

The server reads provider configuration from its runtime environment and stores
per-account secrets in the configured server-side secret store: macOS Keychain
for local self-hosting, or encrypted Postgres rows for the hosted runtime.
Release packaging must not copy `.env` or other secret files into the app
bundle.

## Public Release Checklist

Before making releases public:

- Keep `.env` ignored and untracked.
- Confirm release artifacts do not contain `.env` files.
- Keep provider credentials in GitHub Actions secrets or on the server, never in repository variables.
- Use repository variables only for non-secret app configuration such as `EMAIL_RELEASE_SERVER_URL`.
- Rotate any provider secret that was ever distributed in a test artifact.
