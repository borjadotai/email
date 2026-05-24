create table if not exists email_private.api_rate_limits (
  scope text not null check (length(scope) > 0),
  subject text not null check (length(subject) > 0),
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (scope, subject, window_start)
);

create index if not exists api_rate_limits_window_idx
  on email_private.api_rate_limits(window_start);

alter table email_private.api_rate_limits enable row level security;

grant select, insert, update, delete on email_private.api_rate_limits to service_role;
revoke all on email_private.api_rate_limits from anon, authenticated;

drop policy if exists api_rate_limits_service_role_all on email_private.api_rate_limits;
create policy api_rate_limits_service_role_all
  on email_private.api_rate_limits
  for all to service_role
  using (true)
  with check (true);
