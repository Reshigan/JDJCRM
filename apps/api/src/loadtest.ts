// Load test: 100k synthetic queries + 20k bleeds, then time every board, search and dashboard path against a budget.
// DESTROYS the target database's data. Runs only on a database whose name contains "test" or "load".
//   DATABASE_URL=postgres://…/baton_load npm run loadtest -w @baton/api -- [--tickets 100000] [--bleeds 20000]
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.MASTER_KEY ??= randomBytes(32).toString('base64');
process.env.DATA_DIR ??= mkdtempSync(`${tmpdir()}/baton-load-`);
process.env.NODE_ENV = 'test';
const { sql } = await import('./db');
const { seed } = await import('./seed');
const { buildApp } = await import('./app');

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('tickets', 100_000), M = arg('bleeds', 20_000), RUNS = arg('runs', 7);

const [{ db }] = await sql`select current_database() as db`;
if (!/test|load/.test(db)) throw new Error(`Refusing to wipe database "${db}": use a database whose name contains "test" or "load"`);

let t0 = Date.now();
await sql.unsafe('drop schema public cascade; create schema public');
await seed(true, false);
await sql`insert into contacts (name, type, organisation_id, phone)
  select 'Dr Load ' || g, 'doctor', (select array_agg(id order by id) from organisations)[1 + g % (select count(*) from organisations)::int], '012 555 ' || lpad(g::text, 4, '0')
  from generate_series(0, 4999) g`;
// One ticket every 5 minutes going back ~a year; 1 in 300 still open.
await sql`
  with o as (select array_agg(id order by id) a from contacts), c as (select array_agg(id order by id) a from categories),
       s as (select array_agg(id order by id) a from sites), u as (select id from users where email = 'agent@baton.local')
  insert into tickets (number, state, channel, complainant_type, complainant_name, contact_id, organisation_id, contact_phone, patient_name, requisition_no,
    site_id, category_id, priority, description, logged_by, created_at, closure_reason, root_cause, closed_at, closed_by)
  select 'LT-' || g, x.state, 'telephone', 'doctor', 'Dr Load ' || (g % 5000), o.a[1 + g % 5000], null, '012 555 0100', 'Patient ' || g, 'RQ-LT-' || g,
    s.a[1 + g % cardinality(s.a)], c.a[1 + g % cardinality(c.a)], (array['critical', 'high', 'normal'])[1 + g % 3], 'Synthetic load-test query ' || g, u.id,
    now() - g * interval '5 minutes',
    case when x.state = 'closed' then 'resolved_corrective' end, case when x.state = 'closed' then 'logistics' end,
    case when x.state = 'closed' then now() - g * interval '5 minutes' + interval '1 hour' end, case when x.state = 'closed' then u.id end
  from generate_series(${N}, 1, -1) g cross join o cross join c cross join s cross join u
  cross join lateral (select case when g % 300 = 0 then 'in_progress' else 'closed' end as state) x`;
await sql`update tickets t set organisation_id = c.organisation_id from contacts c where c.id = t.contact_id`;
await sql`
  insert into assignments (ticket_id, department_id, state, clock, limit_minutes, started_at, due_at, acknowledged_at, responded_at, findings, corrective_action)
  select t.id, c.department_ids[1], case when t.state = 'closed' then 'accepted' else 'in_progress' end, c.clock, c.limit_normal, t.created_at,
    t.created_at + interval '8 hours', t.created_at + interval '10 minutes', case when t.state = 'closed' then t.created_at + interval '50 minutes' end,
    case when t.state = 'closed' then 'Investigated' end, case when t.state = 'closed' then 'Corrected' end
  from tickets t join categories c on c.id = t.category_id where t.number like 'LT-%'`;
// One bleed every 25 minutes; checkpoints only up to now; 1 in 100 ended but not yet closed.
await sql`
  with h as (select array_agg(id order by id) a from organisations where kind = 'hospital'), u as (select id from users where email = 'agent@baton.local')
  insert into bleed_requests (number, hospital_id, requested_by, logged_by, created_at, arrived_at)
  select 'LTR-' || g, h.a[1 + g % cardinality(h.a)], 'Ward', u.id, now() - g * interval '25 minutes',
    nullif(least(now() - g * interval '25 minutes' + interval '20 minutes', now()), now())
  from generate_series(${M}, 1, -1) g cross join h cross join u`;
await sql`
  insert into bleeds (number, request_id, patient_name, folder_no, requisition_no, outcome, opened_at, arrived_at, captured_at, received_at, lab_accepted_at, released_at, filed_at, closed_at, closed_by)
  select 'LTB-' || g, r.id, 'Patient B' || g, 'F' || g, 'RQ-LTB-' || g, case when k.cap is not null then 'successful' end, r.created_at, r.arrived_at,
    k.cap, k.rec, k.acc, k.rel, k.fil, case when k.fil is not null and g % 100 <> 0 then k.fil + interval '10 minutes' end,
    case when k.fil is not null and g % 100 <> 0 then r.logged_by end
  from bleed_requests r cross join lateral (select substr(r.number, 5)::int as g) n(g)
  cross join lateral (select
    case when r.arrived_at is not null and r.created_at + interval '50 minutes' < now() then r.created_at + interval '50 minutes' end as cap,
    case when r.created_at + interval '2 hours' < now() then r.created_at + interval '2 hours' end as rec,
    case when r.created_at + interval '3 hours' < now() then r.created_at + interval '3 hours' end as acc,
    case when r.created_at + interval '6 hours' < now() then r.created_at + interval '6 hours' end as rel,
    case when r.created_at + interval '7 hours' < now() then r.created_at + interval '7 hours' end as fil) k
  where r.number like 'LTR-%'`;
await sql`analyze`;
console.log(`generated ${N} queries and ${M} bleeds in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const app = await buildApp();
const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'supervisor@baton.local', password: 'Baton!demo2026' } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const day = (d: number) => new Date(Date.now() + 2 * 3_600_000 - d * 86_400_000).toISOString().slice(0, 10);

// [label, url, p95 budget ms]
const CASES: [string, string, number][] = [
  ['Query board (open)', '/api/tickets', 1000],
  ['Query board (closed, first page)', '/api/tickets?scope=closed', 500],
  ['Query board (search)', '/api/tickets?scope=all&q=RQ-LT-4242', 500],
  ['Global search', '/api/search?q=Patient%2077777', 500],
  ['Complainant lookup', '/api/complainants?q=Load%20123', 500],
  ['Client register', '/api/contacts?q=Load', 1000],
  ['Bleed board (open)', '/api/bleeds', 1000],
  ['Bleed board (closed, first page)', '/api/bleeds?scope=closed', 500],
  ['Live dashboard', '/api/dashboard/live', 1000],
  ['Performance, 30 days', `/api/analytics?from=${day(30)}&to=${day(0)}`, 1500],
  ['Performance, 90 days', `/api/analytics?from=${day(90)}&to=${day(0)}`, 2500],
  ['Performance, 12 months', `/api/analytics?from=${day(364)}&to=${day(0)}`, 8000],
  ['Excel export, 30 days', `/api/export.xlsx?from=${day(30)}&to=${day(0)}`, 5000],
];

const rows: string[][] = [];
let failed = 0;
for (const [label, url, budget] of CASES) {
  const ms: number[] = [];
  let status = 0, size = 0;
  for (let i = 0; i < RUNS; i++) {
    t0 = performance.now();
    const r = await app.inject({ method: 'GET', url, headers: { cookie } });
    ms.push(performance.now() - t0);
    status = r.statusCode;
    size = r.rawPayload.length;
  }
  ms.sort((a, b) => a - b);
  const p50 = ms[ms.length >> 1], p95 = ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)];
  const ok = status === 200 && p95 <= budget;
  if (!ok) failed++;
  rows.push([ok ? 'ok' : 'FAIL', label, String(status), `${Math.round(p50)}`, `${Math.round(p95)}`, `${budget}`, `${Math.round(size / 1024)} KB`]);
}
await app.close();
await sql.end();

const head = ['', 'Endpoint', 'HTTP', 'p50 ms', 'p95 ms', 'budget', 'size'];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
for (const r of [head, ...rows]) console.log(r.map((c, i) => c.padEnd(w[i])).join('  '));
if (failed) {
  console.error(`${failed} endpoint(s) over budget`);
  process.exit(1);
}
