-- Enhancements: live events, capture quality, LIS integration.

-- Live push: every audited change and every notification is announced (ids only, never patient data).
create function notify_change() returns trigger language plpgsql as $$
begin
  perform pg_notify('baton_change', json_build_object('entity', new.entity, 'id', new.entity_id, 'action', new.action)::text);
  return null;
end $$;
create trigger audit_notify after insert on audit_log for each row execute function notify_change();

create function notify_user() returns trigger language plpgsql as $$
begin
  perform pg_notify('baton_user', new.user_id::text);
  return null;
end $$;
create trigger notification_notify after insert on notifications for each row execute function notify_user();

-- Photo sharpness (variance of Laplacian, measured on the phone) so illegible photos are visible to reviewers.
alter table bleed_photos add column sharpness real;

-- LIS webhook idempotency: each event id is processed once; replays return the stored result.
create table lis_events (
  event_id text primary key,
  received_at timestamptz not null default now(),
  payload jsonb not null,
  result jsonb not null
);
