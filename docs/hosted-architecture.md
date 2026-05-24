# Hosted Multi-Tenant Architecture

This app is moving from a personal "Mac mini as the server" model to a hosted
backend that can serve multiple users and multiple client devices.

## Current Local Model

- The native macOS/iOS apps talk to one Node server.
- The Node server owns provider credentials and talks to Gmail/iCloud.
- SQLite stores normalized account, mailbox, label, message, attachment, and
  search data.
- macOS uses the Keychain for provider refresh tokens and app-specific
  passwords.
- This works for one owner, but the Mac mini is the availability, storage, and
  sync boundary.

## Hosted Target

- Native apps authenticate with Supabase Auth and send a bearer token to the
  hosted Email API.
- The hosted Email API verifies the Supabase token and scopes every request to
  the authenticated app user.
- Provider credentials stay server-side and are encrypted before storage.
- Supabase Postgres is the shared source of truth for users, accounts, message
  metadata, search text, labels, push tokens, and sync state.
- Supabase Storage stores raw MIME and attachment blobs under paths prefixed by
  the user's Supabase Auth id.
- Fly.io runs the long-lived Node API and sync worker process because IMAP,
  provider polling, OAuth callbacks, APNs, and background sync are a better fit
  for a durable process than short serverless invocations.

## Device Storage Strategy

Client devices should not download all historical mail bodies and attachments.
The practical split is:

- Local client cache: recent message summaries, selected message detail, UI
  state, and small thumbnails needed for fast navigation.
- Hosted database: normalized records, searchable body text, labels, mailbox
  state, sync cursors, and provider mapping ids.
- Provider or object storage on demand: full raw MIME, large HTML bodies, and
  attachments.

Search should query the hosted backend. The backend can return matching message
summaries immediately from Postgres full-text search; the app fetches full body
or attachments only when the user opens a message.

## Security Boundary

- Public native apps only receive Supabase publishable configuration and the
  Email API URL.
- Provider secrets never ship in app bundles.
- Supabase service-role credentials, Google OAuth client secrets, APNs keys, and
  `EMAIL_SECRET_ENCRYPTION_KEY` live only in hosted runtime secrets.
- RLS is enabled for all public Supabase tables. Policies use `auth.uid()` and a
  direct `user_id` column on tenant-owned rows.
- Provider secrets live in the private `email_private` schema and are encrypted
  with AES-256-GCM before storage.

## Deployment Shape

Phase 1 deploys the API to Fly.io with:

- `Dockerfile`
- `fly.toml.example`
- persistent `/data` volume for SQLite and encrypted file-backed provider
  secrets
- Supabase Auth token verification
- tenant-scoped server APIs

Phase 2 switches the runtime store from SQLite-on-volume to Supabase Postgres:

- apply `supabase/migrations/*`
- add a Postgres-backed `MailStore` implementation
- set `EMAIL_SECRET_STORE=postgres` so encrypted provider secrets are stored in
  `email_private.provider_secrets`
- store raw MIME and attachments in the private `email-attachments` bucket
- run Supabase advisors before production rollout

The Phase 1 shape is enough to remove the Mac mini requirement for a small
private test. The Phase 2 store migration is the real scalable shared-database
architecture.
