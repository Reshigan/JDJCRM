-- Phase 4: retention policy, GPS plausibility flags.
insert into settings values
  ('retention_days', '{"bleed_photos": null, "attachments": null, "notifications": 180}')
on conflict do nothing;

-- Set when a checkpoint's position is physically implausible (e.g. faster than a car could travel since the
-- same nurse's previous checkpoint): a likely spoofed location. Shown with geolocation exceptions.
alter table bleed_requests add column arrive_suspect text;
alter table bleeds add column file_suspect text;

create index on audit_log (actor_id, action, entity, entity_id, at);
