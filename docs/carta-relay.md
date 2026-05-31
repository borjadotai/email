# Carta Relay

The relay is the cloud-owned boundary for provider secrets. The local CLI/server
keeps mail data and user refresh tokens locally, while the relay keeps secrets
that should not ship in the CLI package.

## Responsibilities

- Google OAuth: own the Google OAuth client secret, exchange authorization codes,
  and refresh short-lived access tokens for local servers.
- APNs: own Apple push credentials and send notifications on behalf of local
  servers.

## Local Server Configuration

The CLI bundles the production Carta relay URL, so normal setup does not ask
users to choose or configure a relay. With that default, `carta accounts
providers` reports Gmail OAuth mode as `relay`.

For custom relay testing, `CARTA_RELAY_BASE_URL` or `carta relay configure`
can override the bundled URL. Direct Desktop OAuth remains available only for
development through
`CARTA_GOOGLE_OAUTH_CLIENT_ID` and `CARTA_GOOGLE_OAUTH_CLIENT_SECRET`.

## Relay Deployment Configuration

```sh
CARTA_RELAY_PUBLIC_URL=https://relay.example.com
CARTA_RELAY_TOKEN=shared-push-token
CARTA_RELAY_STATE_SECRET=long-random-secret
CARTA_RELAY_ALLOWED_CALLBACK_HOSTS=127.0.0.1,localhost,.ts.net

GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...

APNS_KEY_ID=...
APNS_TEAM_ID=...
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
APNS_ENVIRONMENT=production
```

## API

- `POST /api/oauth/google/start`
- `GET /api/oauth/google/callback`
- `POST /api/oauth/google/exchange`
- `POST /api/oauth/google/refresh`
- `POST /api/push/send`
- `GET /api/health`

For the normal CLI setup flow, Google redirects to the fixed local CLI callback:
`http://127.0.0.1:7332/api/auth/gmail/callback`. The CLI forwards the one-time
code to the hosted relay, and the relay exchanges it with Google using the web
client secret. That keeps Google secrets on the relay while refresh tokens stay
in the local Keychain.

Gmail OAuth start, exchange, and refresh use the hosted relay without requiring
a local relay token. `CARTA_RELAY_TOKEN` still protects push delivery requests.
The Google callback itself is protected by encrypted, expiring state.

## Smoke Test

Use the relay e2e smoke test before releases or after changing OAuth setup:

```sh
npm run smoke:relay:e2e
```

The smoke test uses a temporary CLI data directory, configures the relay,
verifies Gmail is available in relay mode, starts the Gmail OAuth flow, and
hits the local callback with a fake Google code. A fake-code failure is
expected: it proves the local callback and deployed relay exchange path are
reachable without creating a real account. No local relay token is required for
this Gmail OAuth smoke. It uses an available local port by default; set
`CARTA_SMOKE_PORT=7332` when you intentionally want to test a specific port.
