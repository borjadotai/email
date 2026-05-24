# Hosted Deployment Runbook

This is the production path for sharing the app with another user without a
personal Mac mini server.

## 1. Supabase

1. Create a dedicated Supabase project for Email.
2. Apply `supabase/migrations/*`.
3. Confirm the private `email-attachments` bucket exists.
4. Enable the Supabase Auth providers you want public users to sign in with.
5. Run the optional local integration test before touching production:
   `npm run test:postgres` with `EMAIL_TEST_POSTGRES_URL`,
   `EMAIL_TEST_SUPABASE_URL`, `EMAIL_TEST_SUPABASE_PUBLISHABLE_KEY`, and
   `EMAIL_TEST_SUPABASE_SERVICE_ROLE_KEY`.
6. Copy these values for the API runtime:
   - project URL
   - publishable key
   - service-role key
   - direct Postgres connection string

Do not point the native apps directly at the mail tables. They authenticate with
Supabase Auth, then call the Email API with the Supabase bearer token. The API is
the tenant boundary for provider sync, sending, attachments, and push side
effects.

## 2. Fly.io API

Use `fly.toml.example` as the app config. Keep public config in `[env]`, and set
private values as Fly secrets:

```sh
fly secrets set \
  EMAIL_POSTGRES_URL='postgresql://...' \
  EMAIL_SECRET_ENCRYPTION_KEY='...' \
  GOOGLE_OAUTH_CLIENT_ID='...' \
  GOOGLE_OAUTH_CLIENT_SECRET='...' \
  SUPABASE_SERVICE_ROLE_KEY='...'
```

Set `EMAIL_PUBLIC_BASE_URL` to the final Fly HTTPS URL before configuring Google
OAuth callbacks. Set `EMAIL_BACKGROUND_SYNC_INTERVAL_MS=300000` for a five-minute
hosted sync cadence; leave it at `0` only for local/manual-sync deployments.

## 3. Google OAuth

The Google OAuth web redirect URI must be:

```text
https://YOUR_FLY_APP.fly.dev/api/auth/gmail/callback
```

For external users beyond a small test group, Gmail restricted scopes will need
Google OAuth app verification.

## 4. Client Config

The macOS and iOS apps need only public runtime config:

- Email API base URL
- Supabase URL
- Supabase publishable key

They must never contain `SUPABASE_SERVICE_ROLE_KEY`, `EMAIL_POSTGRES_URL`,
Google client secrets, APNs private keys, or `EMAIL_SECRET_ENCRYPTION_KEY`.

## 5. Smoke Test

Before inviting a friend:

1. Sign up as user A and connect one Gmail account.
2. Sign up as user B and connect a different Gmail account.
3. Confirm each user only sees their own accounts, messages, labels, push
   tokens, and attachments.
4. Search for a known body term and open a result.
5. Download an attachment.
6. Send a tracked test email and confirm the open pixel records without requiring
   a bearer token.
