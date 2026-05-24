alter table public.accounts
  add column if not exists sync_lease_owner text,
  add column if not exists sync_lease_until timestamptz;

create index if not exists accounts_sync_lease_idx
  on public.accounts(status, sync_lease_until, last_sync_at);
