# Hosting Platform Decision And TODO

Last reviewed: 2026-05-24

## Recommendation

Keep the v1 hosted backend on Fly.io plus Supabase.

Do not move the core Email API or sync worker to Cloudflare Workers right now.
Cloudflare is attractive for high-volume stateless edge work, but the current
mail backend is a long-lived Node process with IMAP, SMTP, APNs, OAuth callbacks,
server-sent events, Postgres connections, and scheduled provider polling. That is
a closer fit for a container/Machine runtime than an isolate/serverless runtime.

The long-term direction should be:

- Supabase Auth, Postgres, and Storage remain the system of record for v1.
- Fly runs the Node API and background sync worker until scale or reliability
  evidence says otherwise.
- Cloudflare can be introduced later for edge-only pieces such as tracking pixel
  ingestion, CDN/WAF, R2 attachment storage, or a lightweight API gateway.
- Cloudflare Containers can be evaluated later if we want Cloudflare's edge
  network plus a real container runtime, but it should be treated as a separate
  migration from plain Workers and not as the v1 default.
- Vercel can be introduced later for a web/admin app, marketing site, or
  agent-friendly dashboard workflows, but not for the mail sync worker.

## Why Fly Is Still The Right V1 Runtime

The current server depends on runtime features that fit a normal Node container:

- `imapflow` and `nodemailer` for provider IMAP/SMTP.
- `googleapis` OAuth and Gmail calls.
- APNs over HTTP/2.
- A process-local scheduler for background sync.
- Server-sent events for connected clients.
- Direct Postgres access through `pg`.
- Docker packaging already exists and builds successfully.

Fly's cost is mostly predictable machine time. That is less magical than
serverless, but it is also easier to reason about for an always-on sync service.
The first production shape can stay tiny: one always-on shared VM, one Supabase
project, no Fly volume, and object bytes in Supabase Storage.

## Why Not Cloudflare Workers For The Core API Yet

Cloudflare Workers are excellent for globally distributed, stateless request
handling. They are less natural for this specific service today:

- Workers have CPU/memory/runtime model limits that are reasonable for request
  handlers but awkward for mail sync loops and large-message parsing.
- Node compatibility is partial; some Node APIs are supported, some are partial
  or polyfilled. That makes `imapflow`, `nodemailer`, APNs, and direct driver
  behavior a migration risk.
- Cron/Queue/Durable Object invocations have duration limits, so a full mailbox
  sync must be split into careful jobs from day one.
- It would require a real refactor: queue-driven sync, provider adapters tested
  under Workers, likely Hyperdrive for Postgres, and a new deployment surface.

Cloudflare may still be the best long-term edge companion:

- Move `/api/track/open/:id.gif` to a Worker when tracking traffic grows.
- Use Queues to buffer open events before writing to Postgres.
- Consider R2 for attachment/raw MIME storage if Supabase Storage cost or egress
  becomes painful.
- Put Cloudflare in front of the API for WAF, rate limiting, and caching of
  public/static endpoints.

## Cloudflare Containers

Cloudflare Containers are a better fit than plain Workers for this backend
because they can run an existing container image with a normal Linux-like
runtime. They are not the recommended v1 move because they introduce a new
application model: requests enter through a Worker, route through a Durable
Object-backed container, and the container can sleep and cold-start again.

That may become attractive once the product has enough load to justify the
migration, especially if Cloudflare's edge network, R2, Queues, and WAF are
already part of the architecture. For now, Fly is simpler: the same Docker image
we already build runs as a normal always-on service, with fewer platform-specific
assumptions to validate around long sync jobs, process lifetime, and routing.

## Why Not Vercel For The Core API Yet

Vercel is strong for web apps and agent-friendly workflows. The available plugin
and platform APIs make it easier for an agent to manage projects, deployments,
and env vars.

The issue is fit: Vercel Functions are request-scoped with max-duration limits.
That is fine for an admin UI, billing, onboarding pages, or API routes that call
the hosted Email API. It is not the right primary home for an always-on mail sync
worker or provider connections.

## Supabase Edge Functions

Supabase Edge Functions are useful near the existing Supabase project for
webhooks, small trusted operations, and JWT-gated glue code. They are Deno-based
edge functions, not a drop-in replacement for this Node mail process.

Keep using Supabase for Auth, Postgres, Storage, migrations, RLS, advisors, and
possibly small edge functions later. Do not move the main sync worker there.

## Agent-Friendliness

Current agent experience:

- Supabase connector is useful for project metadata, publishable keys,
  migrations, SQL, advisors, and logs.
- In this session, the Supabase connector did not expose service-role keys or
  the database password. Those still need to come from the dashboard unless a
  secret-key management tool becomes available.
- Fly has a good CLI path. It is less MCP-native here, but now that the account
  is unlocked, the agent can create apps, stage secrets, deploy, and inspect
  status through `flyctl`.
- Vercel has the best agent/plugin surface in this environment, but the runtime
  fit is weaker for the core mail backend.
- Cloudflare is agent-friendly through Wrangler/API tokens, but no Cloudflare
  connector is available in this current toolset.

## Cost Notes

- Fly: pay for Machines that run, including background workers. Good for a small
  always-on worker because the bill is easy to model.
- Cloudflare Workers: very cheap at high request volume for stateless edge code,
  with paid plan included usage and low overage rates. Good future home for
  open tracking and edge ingestion.
- Supabase: Postgres/Storage costs become the main scaling axis because message
  metadata, search text, attachments, and raw MIME live there.
- Vercel: excellent DX, but function duration and request/body constraints mean
  cost/performance can become awkward for large email payloads or long sync.

## Near-Term TODO

- [x] Finish `.env.fly` with `EMAIL_POSTGRES_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  Google OAuth secrets, and `EMAIL_SECRET_ENCRYPTION_KEY`.
- [x] Run `npm run check:hosted -- --env-file .env.fly`.
- [x] Deploy to Fly with `npm run deploy:fly -- --env-file .env.fly`.
- [x] Run `npm run smoke:hosted -- --base-url https://dearly-email.fly.dev`.
- [x] Add a deeper `/api/ready` endpoint that verifies Postgres, private storage,
  auth settings, and required provider configuration. Use this for deploy smoke,
  not just `/api/health`.
- [ ] Invite one test user and run the two-user isolation checklist in
  [hosted-deployment.md](hosted-deployment.md).
- [x] Add per-account sync leases before scaling Fly above one running machine.
  Without leases, multiple workers could sync the same account concurrently.
- [x] Add rate limits for auth-sensitive and provider-expensive endpoints:
  Gmail start, iCloud connect, manual sync, send, and attachment download.
- [x] Add operational logging for sync duration, imported count, provider errors,
  token refresh failures, and attachment storage failures.
- [ ] Re-run Supabase advisors before public testing and decide whether to move
  `citext` and `pg_trgm` extensions out of `public`.

## Revisit Triggers

Re-evaluate Cloudflare or another platform when one of these happens:

- Tracking pixel traffic is high enough that global edge ingestion matters.
- Attachment/raw MIME storage cost or egress becomes a material part of the bill.
- We need multi-region API latency for users far from the Fly primary region.
- Background sync needs queue-based fanout across many workers.
- We build a web app/admin surface that would benefit from Vercel's DX.

## Source Links

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Containers overview](https://developers.cloudflare.com/containers/)
- [Cloudflare Containers lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Fly cost management](https://fly.io/docs/about/cost-management/)
- [Vercel Function duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel Function limits](https://vercel.com/docs/functions/limitations)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
