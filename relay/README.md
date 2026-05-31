# Carta Email Relay

This Next.js app is the hosted secret boundary for the standalone Carta CLI.
It is intentionally stateless today: the local CLI owns mail data and refresh
tokens, while the relay owns provider application secrets. There is no Supabase
database to provision for the current relay because OAuth state is encrypted in
short-lived redirect payloads and mail state remains in the local CLI database.

Production deployment:

```sh
npx vercel@latest link --cwd relay --yes --project carta-email-relay
npx vercel@latest env add CARTA_RELAY_PUBLIC_URL production --cwd relay
npx vercel@latest env add CARTA_RELAY_TOKEN production --cwd relay  # protects APNs push sends
npx vercel@latest env add CARTA_RELAY_STATE_SECRET production --cwd relay
npx vercel@latest env add CARTA_RELAY_ALLOWED_CALLBACK_HOSTS production --cwd relay
npx vercel@latest env add GOOGLE_OAUTH_CLIENT_ID production --cwd relay
npx vercel@latest env add GOOGLE_OAUTH_CLIENT_SECRET production --cwd relay
npx vercel@latest deploy --cwd relay --prod --yes
```

Current production URL:

```text
https://carta-email-relay.vercel.app
```

The normal CLI Gmail flow uses the fixed local callback:
`http://127.0.0.1:7332/api/auth/gmail/callback`. Google redirects there,
then the CLI forwards the one-time code to the hosted relay for exchange. A
fake-code exchange should fail with `Malformed auth code`; that proves the
local callback, Google client ID, Google client secret, and relay exchange are
wired together.

Smoke checks:

```sh
curl -fsS https://carta-email-relay.vercel.app/api/health

curl -fsS -X POST https://carta-email-relay.vercel.app/api/oauth/google/start \
  -H "content-type: application/json" \
  --data '{
    "state":"local-state-smoke",
    "deliveryToken":"delivery-smoke",
    "callbackURL":"http://127.0.0.1:7332/api/auth/gmail/callback",
    "deliveryMode":"local-code"
  }'

curl -sS -X POST https://carta-email-relay.vercel.app/api/oauth/google/exchange \
  -H "content-type: application/json" \
  --data '{
    "code":"fake-code",
    "redirectURI":"http://127.0.0.1:7332/api/auth/gmail/callback"
  }'
```

APNs push delivery is implemented at `POST /api/push/send`. The deployed relay
APNs values currently mirror the existing server configuration; switch
`APNS_ENVIRONMENT` when the client apps use production-signed push tokens.
