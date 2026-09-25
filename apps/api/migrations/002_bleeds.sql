-- Module B: hospital bleed requests. One request (one call, one hospital visit) → N patient bleeds.

alter table organisations add column nurse_id uuid references users; -- nurse allocated to this hospital
alter table notifications add column link text; -- generic deep link (queries use ticket_id)

insert into settings values ('bleed_limits', '[60,30,120,60,240,90]') on conflict do nothing;

create table bleed_requests (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,
  hospital_id integer not null references organisations,
  site_id integer references sites,
  nurse_id uuid references users,
  requested_by text not null,
  contact_phone text,
  notes text,
  logged_by uuid not null references users,
  created_at timestamptz not null default now(),
  -- arrival checkpoint, geofence evidence (brief §6.3)
  arrived_at timestamptz,
  arrived_by uuid references users,
  arrive_lat double precision,
  arrive_lng double precision,
  arrive_accuracy_m double precision,
  arrive_distance_m double precision,
  arrive_override text
);

create table bleeds (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,
  request_id uuid not null references bleed_requests on delete cascade,
  patient_name text not null,
  folder_no text,
  ward text,
  bed text,
  requisition_no text,
  tubes jsonb not null default '[]',
  outcome text check (outcome in ('successful','patient_unavailable','patient_refused','difficult_draw','cancelled_by_hospital')),
  outcome_reason text,
  -- the seven checkpoints; intervals are derived
  opened_at timestamptz not null default now(),
  arrived_at timestamptz,
  captured_at timestamptz,
  captured_by uuid references users,
  received_at timestamptz,
  received_by uuid references users,
  lab_accepted_at timestamptz,
  lab_accepted_by uuid references users,
  released_at timestamptz,
  released_by uuid references users,
  filed_at timestamptz,
  filed_by uuid references users,
  file_lat double precision,
  file_lng double precision,
  file_accuracy_m double precision,
  file_distance_m double precision,
  file_override text,
  breach_reasons jsonb not null default '{}', -- { "<interval index>": "reason" }
  escalations jsonb not null default '{}',    -- { "<interval index>": level }
  offline_sync boolean not null default false, -- a checkpoint arrived late from an offline device
  cancelled_at timestamptz,
  cancel_reason text,
  closed_at timestamptz,
  closed_by uuid references users,
  check (captured_at is null or arrived_at is not null),
  check (received_at is null or captured_at is not null),
  check (lab_accepted_at is null or received_at is not null),
  check (released_at is null or lab_accepted_at is not null),
  check (filed_at is null or released_at is not null)
);
create index on bleeds (request_id);
create index on bleeds (opened_at);
create index on bleeds (closed_at) where closed_at is null;

create table bleed_photos (
  id uuid primary key default gen_random_uuid(),
  bleed_id uuid not null references bleeds on delete cascade,
  kind text not null check (kind in ('requisition', 'sticker')),
  mime text not null,
  size integer not null,
  key_wrapped text not null,
  uploaded_by uuid not null references users,
  created_at timestamptz not null default now()
);

-- Closing a bleed follows the same rule as queries: Client Services only, and only once it has ended.
create function enforce_bleed_closure() returns trigger language plpgsql as $$
begin
  if new.closed_at is not null and old.closed_at is null then
    if (select role from users where id = new.closed_by) not in ('cs_agent', 'cs_supervisor') then
      raise exception 'only Client Services may close a bleed';
    end if;
    if new.filed_at is null and new.cancelled_at is null and coalesce(new.outcome, 'successful') = 'successful' then
      raise exception 'bleed has not ended: report not filed';
    end if;
  end if;
  return new;
end $$;
create trigger bleeds_enforce_closure before update on bleeds for each row execute function enforce_bleed_closure();
