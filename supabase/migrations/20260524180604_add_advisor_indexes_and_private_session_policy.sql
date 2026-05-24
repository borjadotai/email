create policy "service role manages provider auth sessions"
  on email_private.provider_auth_sessions
  for all to service_role
  using (true)
  with check (true);

create index if not exists provider_secrets_account_user_idx
  on email_private.provider_secrets(account_id, user_id);

create index if not exists blocked_senders_account_user_idx
  on public.blocked_senders(account_id, user_id);
create index if not exists blocked_senders_source_email_idx
  on public.blocked_senders(source_email_id);
create index if not exists email_attachments_email_user_idx
  on public.email_attachments(email_id, user_id);
create index if not exists email_labels_email_user_idx
  on public.email_labels(email_id, user_id);
create index if not exists email_labels_label_user_idx
  on public.email_labels(label_id, user_id);
create index if not exists emails_account_user_idx
  on public.emails(account_id, user_id);
create index if not exists emails_mailbox_user_idx
  on public.emails(mailbox_id, user_id);
create index if not exists labels_account_user_idx
  on public.labels(account_id, user_id);
create index if not exists mailboxes_account_user_idx
  on public.mailboxes(account_id, user_id);
create index if not exists open_events_email_user_idx
  on public.open_events(email_id, user_id);
create index if not exists outbound_messages_account_user_idx
  on public.outbound_messages(account_id, user_id);
create index if not exists outbound_messages_email_user_idx
  on public.outbound_messages(email_id, user_id);
