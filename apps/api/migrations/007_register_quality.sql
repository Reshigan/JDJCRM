-- Tier 2: client register, corrective-action effectiveness, productivity, scale.
create extension if not exists pg_trgm;

-- G. Client register: people who raise queries (doctors, nurses, patients…), under their practice / hospital.
create function contact_key(name text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(lower(name), '^\s*(dr|prof|sister|sr|mr|mrs|ms|miss)\.?\s+', ''), '[^a-z]', '', 'g')
$$;

create table contacts (
  id serial primary key,
  name text not null,
  type text not null,
  organisation_id integer references organisations,
  phone text,
  email text,
  merged_into integer references contacts,
  created_at timestamptz not null default now()
);
create index on contacts (contact_key(name));
create index contacts_name_trgm on contacts using gin (name gin_trgm_ops);

alter table tickets add column contact_id integer references contacts;
create index on tickets (contact_id);

-- Backfill: one contact per (name, type, organisation) seen so far, with the latest contact details.
insert into contacts (name, type, organisation_id, phone, email)
select distinct on (lower(complainant_name), complainant_type, organisation_id)
  complainant_name, complainant_type, organisation_id, contact_phone, contact_email
from tickets order by lower(complainant_name), complainant_type, organisation_id, created_at desc;
update tickets t set contact_id = c.id from contacts c
where lower(c.name) = lower(t.complainant_name) and c.type = t.complainant_type and c.organisation_id is not distinct from t.organisation_id;

-- H. Corrective-action effectiveness check (ISO 15189 quality indicators).
alter table tickets
  add column effectiveness_due date,
  add column effectiveness_result text check (effectiveness_result in ('effective', 'not_effective')),
  add column effectiveness_note text,
  add column effectiveness_at timestamptz,
  add column effectiveness_by uuid references users,
  add column effectiveness_reminded boolean not null default false;
create index on tickets (effectiveness_due) where effectiveness_due is not null and effectiveness_at is null;

-- I. Saved board views and canned responses.
create table saved_views (
  id serial primary key,
  user_id uuid not null references users on delete cascade,
  page text not null check (page in ('tickets', 'bleeds')),
  name text not null,
  query text not null,
  unique (user_id, page, name)
);

create table canned_responses (
  id serial primary key,
  title text not null,
  body text not null,
  department_id integer references departments, -- null = everyone
  active boolean not null default true
);

-- J. Scale: board and search paths at 100k+ tickets.
create index on tickets (type, created_at desc);
create index on tickets (closed_at);
create index tickets_search_trgm on tickets using gin (number gin_trgm_ops, complainant_name gin_trgm_ops, patient_name gin_trgm_ops, requisition_no gin_trgm_ops);
create index on bleeds (closed_at, opened_at desc);
