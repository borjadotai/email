import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeConfig } from "../src/config.js";

test("hosted auth mode fails fast without Supabase public auth config", () => {
  assert.throws(() => validateRuntimeConfig({
    requireAuth: true,
    supabaseURL: "",
    supabasePublishableKey: "",
    storage: "sqlite",
    secretStore: ""
  }), /SUPABASE_URL is required[\s\S]+SUPABASE_PUBLISHABLE_KEY is required/u);
});

test("hosted Postgres mode requires shared database, private storage, and encrypted secrets", () => {
  assert.throws(() => validateRuntimeConfig({
    requireAuth: true,
    supabaseURL: "https://example.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    supabaseServiceRoleKey: "",
    postgresURL: "",
    secretEncryptionKey: "",
    storage: "postgres",
    secretStore: "file"
  }), /EMAIL_POSTGRES_URL is required[\s\S]+SUPABASE_SERVICE_ROLE_KEY is required[\s\S]+EMAIL_SECRET_STORE=postgres/u);
});

test("hosted Postgres mode accepts complete production runtime config", () => {
  assert.doesNotThrow(() => validateRuntimeConfig({
    requireAuth: true,
    supabaseURL: "https://example.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    supabaseServiceRoleKey: "sb_secret_test",
    postgresURL: "postgresql://postgres:postgres@example.supabase.co/postgres",
    secretEncryptionKey: "a".repeat(43),
    storage: "postgres",
    secretStore: "postgres"
  }));
});
