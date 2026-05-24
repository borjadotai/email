create extension if not exists "pgcrypto" with schema "public";
create extension if not exists "citext" with schema "public";
create extension if not exists "pg_trgm" with schema "public";

create schema if not exists "email_private";
revoke all on schema "email_private" from anon, authenticated;
grant usage on schema "email_private" to service_role;

create or replace function email_private.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'User',
  primary_email public.citext,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'icloud')),
  provider_account_email public.citext not null,
  display_name text not null,
  avatar_url text,
  auth_type text not null default 'not_configured',
  status text not null default 'needs_auth',
  sync_history boolean not null default true,
  last_sync_at timestamptz,
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, user_id),
  unique (user_id, provider, provider_account_email)
);

create table public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  name text not null,
  role text not null check (role in ('inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'custom')),
  unread_count integer not null default 0 check (unread_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, user_id),
  unique (account_id, role),
  foreign key (account_id, user_id) references public.accounts(id, user_id) on delete cascade
);

create table public.labels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  account_id uuid,
  name text not null,
  color text not null default 'gray',
  is_system boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, user_id),
  foreign key (account_id, user_id) references public.accounts(id, user_id) on delete cascade
);

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  mailbox_id uuid not null,
  provider_uid text,
  thread_id text,
  sender_name text not null,
  sender_email public.citext not null,
  sender_avatar_url text,
  recipients_json jsonb not null default '[]'::jsonb,
  cc_json jsonb not null default '[]'::jsonb,
  bcc_json jsonb not null default '[]'::jsonb,
  subject text not null default '',
  snippet text not null default '',
  body_text text not null default '',
  body_html text,
  raw_storage_bucket text,
  raw_storage_path text,
  rfc_message_id text,
  in_reply_to text,
  references_json jsonb not null default '[]'::jsonb,
  sent_at timestamptz not null,
  received_at timestamptz not null,
  is_read boolean not null default false,
  is_starred boolean not null default false,
  importance text not null default 'normal' check (importance in ('low', 'normal', 'high')),
  has_attachments boolean not null default false,
  tracking_id uuid unique,
  opened_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(sender_name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(sender_email::text, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(recipients_json::text, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(snippet, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(body_text, '')), 'D')
  ) stored,
  unique (id, user_id),
  foreign key (account_id, user_id) references public.accounts(id, user_id) on delete cascade,
  foreign key (mailbox_id, user_id) references public.mailboxes(id, user_id) on delete restrict
);

create table public.email_labels (
  user_id uuid not null references public.app_users(id) on delete cascade,
  email_id uuid not null,
  label_id uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (email_id, label_id),
  foreign key (email_id, user_id) references public.emails(id, user_id) on delete cascade,
  foreign key (label_id, user_id) references public.labels(id, user_id) on delete cascade
);

create table public.email_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email_id uuid not null,
  provider_attachment_id text,
  content_id text,
  filename text not null,
  mime_type text not null default 'application/octet-stream',
  size bigint not null default 0 check (size >= 0),
  disposition text,
  is_inline boolean not null default false,
  storage_bucket text,
  storage_path text,
  storage_status text not null default 'remote_only' check (storage_status in ('remote_only', 'stored', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, user_id),
  foreign key (email_id, user_id) references public.emails(id, user_id) on delete cascade
);

create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email_id uuid not null,
  account_id uuid not null,
  status text not null check (status in ('queued', 'sending', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  sent_at timestamptz,
  foreign key (email_id, user_id) references public.emails(id, user_id) on delete cascade,
  foreign key (account_id, user_id) references public.accounts(id, user_id) on delete cascade
);

create table public.open_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email_id uuid not null,
  tracking_id uuid not null,
  user_agent text,
  remote_addr inet,
  opened_at timestamptz not null default timezone('utc', now()),
  foreign key (email_id, user_id) references public.emails(id, user_id) on delete cascade
);

create table public.blocked_senders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  scope text not null check (scope in ('email', 'domain')),
  value public.citext not null,
  source_email_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  unique (account_id, scope, value),
  foreign key (account_id, user_id) references public.accounts(id, user_id) on delete cascade,
  foreign key (source_email_id) references public.emails(id) on delete set null
);

create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios', 'macos')),
  bundle_id text not null,
  environment text not null check (environment in ('development', 'production')),
  device_name text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  disabled_at timestamptz,
  failure_reason text,
  unique (token, bundle_id, environment)
);

create table email_private.provider_secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  secret_name text not null,
  algorithm text not null default 'aes-256-gcm',
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  key_id text not null default 'primary',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (account_id, secret_name),
  foreign key (account_id, user_id) references public.accounts(id, user_id) on delete cascade
);

create index accounts_user_created_idx on public.accounts(user_id, created_at);
create index mailboxes_user_account_idx on public.mailboxes(user_id, account_id);
create index labels_user_account_idx on public.labels(user_id, account_id);
create unique index labels_user_account_name_idx on public.labels(user_id, account_id, lower(name)) where account_id is not null;
create unique index labels_user_global_name_idx on public.labels(user_id, lower(name)) where account_id is null;
create index emails_user_received_idx on public.emails(user_id, received_at desc);
create index emails_account_received_idx on public.emails(account_id, received_at desc);
create index emails_mailbox_received_idx on public.emails(mailbox_id, received_at desc);
create unique index emails_account_provider_uid_idx on public.emails(account_id, provider_uid) where provider_uid is not null;
create index emails_tracking_idx on public.emails(tracking_id) where tracking_id is not null;
create index emails_search_vector_idx on public.emails using gin(search_vector);
create index emails_subject_trgm_idx on public.emails using gin(subject gin_trgm_ops);
create index emails_sender_email_trgm_idx on public.emails using gin((sender_email::text) gin_trgm_ops);
create index email_labels_label_idx on public.email_labels(user_id, label_id);
create index email_attachments_email_idx on public.email_attachments(user_id, email_id);
create index outbound_messages_user_status_idx on public.outbound_messages(user_id, status, created_at);
create index open_events_tracking_idx on public.open_events(tracking_id);
create index blocked_senders_account_idx on public.blocked_senders(account_id, scope, value);
create index push_tokens_user_active_idx on public.push_tokens(user_id, platform, bundle_id, environment) where disabled_at is null;

create trigger set_app_users_updated_at
  before update on public.app_users
  for each row execute function email_private.set_updated_at();
create trigger set_accounts_updated_at
  before update on public.accounts
  for each row execute function email_private.set_updated_at();
create trigger set_mailboxes_updated_at
  before update on public.mailboxes
  for each row execute function email_private.set_updated_at();
create trigger set_labels_updated_at
  before update on public.labels
  for each row execute function email_private.set_updated_at();
create trigger set_emails_updated_at
  before update on public.emails
  for each row execute function email_private.set_updated_at();
create trigger set_email_attachments_updated_at
  before update on public.email_attachments
  for each row execute function email_private.set_updated_at();
create trigger set_outbound_messages_updated_at
  before update on public.outbound_messages
  for each row execute function email_private.set_updated_at();
create trigger set_push_tokens_updated_at
  before update on public.push_tokens
  for each row execute function email_private.set_updated_at();
create trigger set_provider_secrets_updated_at
  before update on email_private.provider_secrets
  for each row execute function email_private.set_updated_at();

alter table public.app_users enable row level security;
alter table public.accounts enable row level security;
alter table public.mailboxes enable row level security;
alter table public.labels enable row level security;
alter table public.emails enable row level security;
alter table public.email_labels enable row level security;
alter table public.email_attachments enable row level security;
alter table public.outbound_messages enable row level security;
alter table public.open_events enable row level security;
alter table public.blocked_senders enable row level security;
alter table public.push_tokens enable row level security;
alter table email_private.provider_secrets enable row level security;

create policy "users can read own profile"
  on public.app_users for select to authenticated
  using ((select auth.uid()) = id);
create policy "users can insert own profile"
  on public.app_users for insert to authenticated
  with check ((select auth.uid()) = id);
create policy "users can update own profile"
  on public.app_users for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "tenant read accounts"
  on public.accounts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write accounts"
  on public.accounts for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update accounts"
  on public.accounts for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "tenant delete accounts"
  on public.accounts for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "tenant read mailboxes"
  on public.mailboxes for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write mailboxes"
  on public.mailboxes for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update mailboxes"
  on public.mailboxes for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "tenant delete mailboxes"
  on public.mailboxes for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "tenant read labels"
  on public.labels for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write labels"
  on public.labels for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update labels"
  on public.labels for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "tenant delete labels"
  on public.labels for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "tenant read emails"
  on public.emails for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write emails"
  on public.emails for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update emails"
  on public.emails for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "tenant delete emails"
  on public.emails for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "tenant read email labels"
  on public.email_labels for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write email labels"
  on public.email_labels for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant delete email labels"
  on public.email_labels for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "tenant read email attachments"
  on public.email_attachments for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write email attachments"
  on public.email_attachments for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update email attachments"
  on public.email_attachments for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "tenant delete email attachments"
  on public.email_attachments for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "tenant read outbound messages"
  on public.outbound_messages for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write outbound messages"
  on public.outbound_messages for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update outbound messages"
  on public.outbound_messages for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "tenant read open events"
  on public.open_events for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write open events"
  on public.open_events for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "tenant read blocked senders"
  on public.blocked_senders for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write blocked senders"
  on public.blocked_senders for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update blocked senders"
  on public.blocked_senders for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "tenant delete blocked senders"
  on public.blocked_senders for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "tenant read push tokens"
  on public.push_tokens for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write push tokens"
  on public.push_tokens for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update push tokens"
  on public.push_tokens for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "tenant delete push tokens"
  on public.push_tokens for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "tenant read provider secrets"
  on email_private.provider_secrets for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "tenant write provider secrets"
  on email_private.provider_secrets for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "tenant update provider secrets"
  on email_private.provider_secrets for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "tenant delete provider secrets"
  on email_private.provider_secrets for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on
  public.app_users,
  public.accounts,
  public.mailboxes,
  public.labels,
  public.emails,
  public.email_labels,
  public.email_attachments,
  public.outbound_messages,
  public.open_events,
  public.blocked_senders,
  public.push_tokens
to authenticated;

revoke all on
  public.app_users,
  public.accounts,
  public.mailboxes,
  public.labels,
  public.emails,
  public.email_labels,
  public.email_attachments,
  public.outbound_messages,
  public.open_events,
  public.blocked_senders,
  public.push_tokens
from anon;

grant select, insert, update, delete on email_private.provider_secrets to service_role;
revoke all on email_private.provider_secrets from anon, authenticated;

create or replace function email_private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.app_users (id, display_name, primary_email)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), nullif(new.raw_user_meta_data->>'name', ''), new.email, 'User'),
    new.email
  )
  on conflict (id) do update set
    display_name = excluded.display_name,
    primary_email = coalesce(public.app_users.primary_email, excluded.primary_email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function email_private.handle_new_auth_user();

insert into public.app_users (id, display_name, primary_email)
select
  users.id,
  coalesce(nullif(users.raw_user_meta_data->>'full_name', ''), nullif(users.raw_user_meta_data->>'name', ''), users.email, 'User'),
  users.email
from auth.users
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('email-attachments', 'email-attachments', false)
on conflict (id) do update set public = false;

create policy "users can read own email attachment objects"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'email-attachments'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

create policy "users can upload own email attachment objects"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'email-attachments'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

create policy "users can update own email attachment objects"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'email-attachments'
    and split_part(name, '/', 1) = (select auth.uid())::text
  )
  with check (
    bucket_id = 'email-attachments'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

create policy "users can delete own email attachment objects"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'email-attachments'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );
