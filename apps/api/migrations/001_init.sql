-- Baton schema v1: foundation + Module A (queries).
create extension if not exists citext;

create table departments (
  id serial primary key,
  code text unique not null,
  name text not null,
  active boolean not null default true
);

-- hours: 7-element JSON array (Sun..Sat) of [openMinute, closeMinute] SAST or null
create table sites (
  id serial primary key,
  code text unique not null,
  name text not null,
  region text,
  hours jsonb not null default '[null,[480,1020],[480,1020],[480,1020],[480,1020],[480,1020],null]',
  active boolean not null default true
);

create table holidays (day date primary key, name text not null);

-- practices and hospitals; hospitals carry the geofence used by Module B
create table organisations (
  id serial primary key,
  kind text not null check (kind in ('practice', 'hospital')),
  name text not null,
  address text,
  phone text,
  email text,
  lat double precision,
  lng double precision,
  radius_m integer default 250,
  site_id integer references sites,
  active boolean not null default true
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  name text not null,
  role text not null check (role in ('cs_agent','cs_supervisor','dept_responder','dept_manager','management','admin')),
  department_id integer references departments,
  site_id integer references sites,
  auth text not null default 'local' check (auth in ('local', 'ad')),
  password_hash text,
  totp_secret text,
  mfa_enabled boolean not null default false,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  check (role not in ('dept_responder','dept_manager') or department_id is not null)
);

create table sessions (
  id text primary key, -- sha256 of the cookie token
  user_id uuid not null references users on delete cascade,
  mfa_ok boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- AD security group → role mapping (first match by priority wins)
create table ad_groups (
  id serial primary key,
  group_dn text unique not null,
  role text not null,
  department_id integer references departments,
  priority integer not null default 100
);

create table settings (key text primary key, value jsonb not null);
insert into settings values
  ('escalation_thresholds', '[80,100,150]'),
  ('mfa_enforced_roles', '["cs_agent","cs_supervisor","management","admin"]');

-- limits: minutes per priority; clock business = site working hours, wall = 24/7
create table categories (
  id serial primary key,
  name text unique not null,
  department_ids integer[] not null check (cardinality(department_ids) > 0),
  clock text not null default 'business' check (clock in ('business', 'wall')),
  limit_critical integer not null default 120,
  limit_high integer not null default 240,
  limit_normal integer not null default 480,
  active boolean not null default true
);

create table counters (prefix text primary key, n integer not null);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,
  type text not null default 'query' check (type in ('query', 'bleed')),
  state text not null,
  cycle integer not null default 0, -- bumps on reopen / not satisfied; calls count per cycle
  channel text not null,
  complainant_type text not null,
  complainant_name text not null,
  organisation_id integer references organisations,
  contact_phone text,
  contact_email text,
  patient_name text,
  requisition_no text,
  site_id integer not null references sites,
  category_id integer not null references categories,
  priority text not null check (priority in ('critical', 'high', 'normal')),
  description text not null,
  logged_by uuid not null references users,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closure_reason text,
  root_cause text,
  closed_at timestamptz,
  closed_by uuid references users,
  check (contact_phone is not null or contact_email is not null),
  check (state <> 'closed' or (closure_reason is not null and root_cause is not null and closed_by is not null and closed_at is not null))
);
create index on tickets (state);
create index on tickets (created_at);
create index on tickets (lower(complainant_name));

create table assignments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets on delete cascade,
  department_id integer not null references departments,
  assignee_id uuid references users,
  state text not null default 'assigned',
  clock text not null,
  limit_minutes integer not null,
  started_at timestamptz not null default now(),
  due_at timestamptz not null,
  acknowledged_at timestamptz,
  responded_at timestamptz,
  findings text,
  corrective_action text,
  breach_reason text,
  escalation_level integer not null default 0,
  created_at timestamptz not null default now()
);
create index on assignments (ticket_id);
create index on assignments (department_id, state);

create table calls (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets on delete cascade,
  cycle integer not null,
  called_at timestamptz not null,
  spoken_to text not null,
  number_used text not null,
  summary text not null,
  satisfied boolean not null,
  recorded_by uuid not null references users,
  created_at timestamptz not null default now()
);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets on delete cascade,
  filename text not null,
  mime text not null,
  size integer not null,
  key_wrapped text not null, -- per-file AES key, wrapped with the master key
  uploaded_by uuid not null references users,
  created_at timestamptz not null default now()
);

create table notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets on delete cascade,
  body text not null,
  author_id uuid not null references users,
  created_at timestamptz not null default now()
);

create table notifications (
  id bigserial primary key,
  user_id uuid not null references users on delete cascade,
  ticket_id uuid references tickets on delete cascade,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on notifications (user_id, read_at);

-- Closure is technically impossible without the §5.4 evidence, even via direct SQL.
create function enforce_closure() returns trigger language plpgsql as $$
begin
  if new.state = 'closed' and old.state <> 'closed' then
    if (select role from users where id = new.closed_by) not in ('cs_agent', 'cs_supervisor') then
      raise exception 'only Client Services may close a ticket';
    end if;
    if exists (select 1 from assignments where ticket_id = new.id and state not in ('accepted', 'cancelled'))
       or not exists (select 1 from assignments where ticket_id = new.id and state = 'accepted') then
      raise exception 'departmental responses not accepted';
    end if;
    if coalesce((select satisfied from calls where ticket_id = new.id and cycle = new.cycle order by created_at desc limit 1), false) = false then
      raise exception 'client not recorded as satisfied';
    end if;
  end if;
  return new;
end $$;
create trigger tickets_enforce_closure before update on tickets for each row execute function enforce_closure();

-- Append-only, hash-chained audit trail. Also serves as the ticket timeline.
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid references users,
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb not null default '{}',
  ip text,
  prev_hash text not null,
  hash text not null
);
create index on audit_log (entity, entity_id);

create function audit_hash(r audit_log) returns text language sql immutable as $$
  select encode(sha256(convert_to(concat_ws('|', r.prev_hash, extract(epoch from r.at)::text, r.actor_id, r.action,
    r.entity, r.entity_id, r.data::text, r.ip), 'UTF8')), 'hex')
$$;

-- returns the first id whose hash or link is broken, null when the chain is intact
create function audit_verify() returns bigint language sql stable as $$
  select id from (
    select id, hash, prev_hash, audit_hash(a) as calc, lag(hash, 1, 'genesis') over (order by id) as expected_prev
    from audit_log a
  ) x where hash <> calc or prev_hash <> expected_prev order by id limit 1
$$;

create function audit_chain() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(4242);
  new.id := nextval('audit_log_id_seq'); -- taken under the lock so id order = chain order
  new.prev_hash := coalesce((select hash from audit_log order by id desc limit 1), 'genesis');
  new.hash := audit_hash(new);
  return new;
end $$;
create trigger audit_chain before insert on audit_log for each row execute function audit_chain();

create function audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_immutable before update or delete on audit_log for each row execute function audit_immutable();
