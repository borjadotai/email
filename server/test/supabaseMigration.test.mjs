import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const migrationsDir = resolve("supabase/migrations");
const migration = readdirSync(migrationsDir)
  .filter(file => file.endsWith(".sql"))
  .sort()
  .map(file => readFileSync(join(migrationsDir, file), "utf8"))
  .join("\n");

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
  assert.match(migration, /create table email_private\.provider_auth_sessions/u);
  assert.match(migration, /alter table email_private\.provider_auth_sessions enable row level security/u);
  assert.match(migration, /on email_private\.provider_auth_sessions\s+for all to service_role/u);
  assert.match(migration, /revoke all on schema "email_private" from anon, authenticated/u);
  assert.match(migration, /revoke all on email_private\.provider_secrets from anon, authenticated/u);
  assert.match(migration, /revoke all on email_private\.provider_auth_sessions from anon, authenticated/u);
  assert.doesNotMatch(
    migration,
    /grant select, insert, update, delete on email_private\.provider_secrets to authenticated/u
  );
  assert.doesNotMatch(
    migration,
    /grant .* on email_private\.provider_auth_sessions to authenticated/u
  );
});

test("hosted Supabase migration creates private object storage and full-text indexes", () => {
  assert.match(migration, /insert into storage\.buckets \(id, name, public\)\s+values \('email-attachments', 'email-attachments', false\)/u);
  assert.match(migration, /bucket_id = 'email-attachments'[\s\S]+split_part\(name, '\/', 1\) = \(select auth\.uid\(\)\)::text/u);
  assert.match(migration, /search_vector tsvector generated always as/u);
  assert.match(migration, /create index emails_search_vector_idx on public\.emails using gin\(search_vector\)/u);
});

test("hosted Supabase migration covers composite tenant foreign keys", () => {
  for (const index of [
    "provider_secrets_account_user_idx",
    "blocked_senders_account_user_idx",
    "email_attachments_email_user_idx",
    "email_labels_email_user_idx",
    "email_labels_label_user_idx",
    "emails_account_user_idx",
    "emails_mailbox_user_idx",
    "labels_account_user_idx",
    "mailboxes_account_user_idx",
    "open_events_email_user_idx",
    "outbound_messages_account_user_idx",
    "outbound_messages_email_user_idx"
  ]) {
    assert.match(migration, new RegExp(`create index if not exists ${index}`, "u"));
  }
});
