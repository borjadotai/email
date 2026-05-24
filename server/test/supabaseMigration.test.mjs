import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve("supabase/migrations/20260524165936_hosted_multitenant_schema.sql"),
  "utf8"
);

const publicTenantTables = [
  "app_users",
  "accounts",
  "mailboxes",
  "labels",
  "emails",
  "email_labels",
  "email_attachments",
  "outbound_messages",
  "open_events",
  "blocked_senders",
  "push_tokens"
];

test("hosted Supabase migration enables RLS on every exposed tenant table", () => {
  for (const table of publicTenantTables) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security;`, "u"),
      `${table} must enable row level security`
    );
    assert.match(
      migration,
      new RegExp(`on public\\.${table}[\\s\\S]+?auth\\.uid\\(\\)[\\s\\S]+?user_id|on public\\.${table}[\\s\\S]+?auth\\.uid\\(\\)[\\s\\S]+?id`, "u"),
      `${table} must have auth.uid tenant policies`
    );
  }
});

test("hosted Supabase migration keeps provider secrets out of exposed schemas", () => {
  assert.match(migration, /create schema if not exists "email_private"/u);
  assert.match(migration, /create table email_private\.provider_secrets/u);
  assert.match(migration, /revoke all on schema "email_private" from anon, authenticated/u);
  assert.match(migration, /revoke all on email_private\.provider_secrets from anon, authenticated/u);
  assert.doesNotMatch(
    migration,
    /grant select, insert, update, delete on email_private\.provider_secrets to authenticated/u
  );
});

test("hosted Supabase migration creates private object storage and full-text indexes", () => {
  assert.match(migration, /insert into storage\.buckets \(id, name, public\)\s+values \('email-attachments', 'email-attachments', false\)/u);
  assert.match(migration, /bucket_id = 'email-attachments'[\s\S]+split_part\(name, '\/', 1\) = \(select auth\.uid\(\)\)::text/u);
  assert.match(migration, /search_vector tsvector generated always as/u);
  assert.match(migration, /create index emails_search_vector_idx on public\.emails using gin\(search_vector\)/u);
});
