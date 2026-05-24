create table email_private.provider_auth_sessions (
  state text primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  provider text not null check (provider in ('gmail')),
  code_verifier text not null,
  display_name text not null default '',
  sync_history boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null
);

create index provider_auth_sessions_user_idx
  on email_private.provider_auth_sessions(user_id, provider, created_at);

create index provider_auth_sessions_expires_idx
  on email_private.provider_auth_sessions(expires_at);

alter table email_private.provider_auth_sessions enable row level security;

grant select, insert, delete on email_private.provider_auth_sessions to service_role;
revoke all on email_private.provider_auth_sessions from anon, authenticated;
