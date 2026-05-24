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
- Provider OAuth PKCE sessions are persisted server-side so callbacks survive
  deploys and process restarts.
- Supabase Storage stores raw MIME and attachment blobs under paths prefixed by
  the user's Supabase Auth id.
- Fly.io runs the long-lived Node API and sync worker process because IMAP,
  provider polling, OAuth callbacks, APNs, and background sync are a better fit
  for a durable process than short serverless invocations.
- Hosted background sync is controlled by `EMAIL_BACKGROUND_SYNC_INTERVAL_MS`
  and syncs connected accounts under their owning Supabase user context.

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

The hosted runtime target is:

- Fly.io runs the Node API as an always-on process.
- Supabase Auth owns user signup and JWT issuance.
- Supabase Postgres is selected with `EMAIL_STORAGE=postgres`.
- Provider tokens are encrypted with `EMAIL_SECRET_ENCRYPTION_KEY` and stored in
  `email_private.provider_secrets` with `EMAIL_SECRET_STORE=postgres`.
- In-progress provider OAuth sessions are stored in
  `email_private.provider_auth_sessions`, not process memory.
- Attachments are uploaded to the private `email-attachments` Supabase Storage
  bucket; Postgres stores only metadata and object paths.
- Hosted clients do not run periodic provider sync from each device. The server
  scheduler owns background provider polling; clients can still trigger explicit
  user refreshes and otherwise poll cached API state.

Required hosted secrets:

- `EMAIL_POSTGRES_URL`
- `EMAIL_SECRET_ENCRYPTION_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- APNs secrets if remote push notifications are enabled

Required non-secret hosted config:

- `EMAIL_PUBLIC_BASE_URL`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `EMAIL_ATTACHMENT_BUCKET=email-attachments`
- `EMAIL_BACKGROUND_SYNC_INTERVAL_MS=300000`
- `EMAIL_BACKGROUND_SYNC_LIMIT=50`

`fly.toml` is configured for the hosted Postgres/Storage path and does not need
a persistent Fly volume. `fly.toml.example` remains as a template for alternate
app names or projects. The SQLite/file-secret path remains available for
personal self-hosting. The rollout checklist is in
[hosted-deployment.md](hosted-deployment.md).
