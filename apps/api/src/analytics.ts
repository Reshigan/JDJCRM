// Brief §7 analytics. Aggregates in JS with the same core clock/interval code the tickets use, so the
// dashboard can never disagree with a ticket (working-hours SLAs cannot be computed faithfully in SQL alone).
import { z } from 'zod';
import { bleedIntervals, bleedState, INTERVALS, SAST_OFFSET } from '@baton/core';
import { sql, type Sql } from './db';
import { bleedConfig } from './routes/bleeds';
import { slaContext } from './sla';

const id = z.coerce.number().int().optional();
export const Filters = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  region: z.string().max(100).optional(),
  site_id: id,
  hospital_id: id,
  department_id: id,
  category_id: id,
  nurse_id: z.uuid().optional(),
  priority: z.enum(['critical', 'high', 'normal']).optional(),
  status: z.enum(['open', 'closed']).optional(),
});
export type Filters = z.infer<typeof Filters>;

/** SAST calendar day → UTC instant range [from 00:00, to+1 00:00). */
export const range = (f: { from: string; to: string }) => {
  const a = new Date(new Date(`${f.from}T00:00:00Z`).getTime() - SAST_OFFSET);
  const b = new Date(new Date(`${f.to}T00:00:00Z`).getTime() - SAST_OFFSET + 86_400_000);
  if (b.getTime() - a.getTime() > 400 * 86_400_000) throw Object.assign(new Error('Choose a period of at most 400 days'), { statusCode: 400 });
  return [a, b] as const;
};
const day = (d: Date | string) => new Date(new Date(d).getTime() + SAST_OFFSET).toISOString().slice(0, 10);
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (ok: number, n: number) => (n ? Math.round((ok / n) * 1000) / 10 : null);
function groupBy<T>(xs: T[], key: (x: T) => string | number | null) {
  const m = new Map<string | number, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (k == null) continue;
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}
function days(f: { from: string; to: string }) {
  const out: string[] = [];
  for (let t = new Date(`${f.from}T00:00:00Z`).getTime(); t <= new Date(`${f.to}T00:00:00Z`).getTime(); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export async function bleedRows(db: Sql, f: Filters) {
  const [a, b] = range(f);
  return db`
    select bl.*, r.number as request_number, r.hospital_id, r.nurse_id, r.site_id, r.arrive_override, r.arrive_suspect, h.name as hospital, s.name as site, s.region, n.name as nurse
    from bleeds bl join bleed_requests r on r.id = bl.request_id join organisations h on h.id = r.hospital_id
    left join sites s on s.id = r.site_id left join users n on n.id = r.nurse_id
    where bl.opened_at >= ${a} and bl.opened_at < ${b}
      and (${f.hospital_id ?? null}::int is null or r.hospital_id = ${f.hospital_id ?? null})
      and (${f.site_id ?? null}::int is null or r.site_id = ${f.site_id ?? null})
      and (${f.region ?? null}::text is null or s.region = ${f.region ?? null})
      and (${f.nurse_id ?? null}::uuid is null or r.nurse_id = ${f.nurse_id ?? null})
      and (${f.status ?? null}::text is null or (${f.status === 'closed'} = (bl.closed_at is not null)))
    order by bl.opened_at`;
}

export async function queryRows(db: Sql, f: Filters) {
  const [a, b] = range(f);
  return db`
    select t.*, c.name as category, s.name as site, s.region, o.name as organisation,
      (select json_agg(json_build_object('department_id', x.department_id, 'department', d.name, 'state', x.state, 'clock', x.clock,
          'limit_minutes', x.limit_minutes, 'started_at', x.started_at, 'acknowledged_at', x.acknowledged_at, 'responded_at', x.responded_at,
          'breach_reason', x.breach_reason))
        from assignments x join departments d on d.id = x.department_id where x.ticket_id = t.id and x.state <> 'cancelled') as assignments
    from tickets t join categories c on c.id = t.category_id join sites s on s.id = t.site_id left join organisations o on o.id = t.organisation_id
    where t.created_at >= ${a} and t.created_at < ${b}
      and (${f.site_id ?? null}::int is null or t.site_id = ${f.site_id ?? null})
      and (${f.region ?? null}::text is null or s.region = ${f.region ?? null})
      and (${f.category_id ?? null}::int is null or t.category_id = ${f.category_id ?? null})
      and (${f.priority ?? null}::text is null or t.priority = ${f.priority ?? null})
      and (${f.hospital_id ?? null}::int is null or t.organisation_id = ${f.hospital_id ?? null})
      and (${f.department_id ?? null}::int is null or exists (select 1 from assignments x where x.ticket_id = t.id and x.department_id = ${f.department_id ?? null} and x.state <> 'cancelled'))
      and (${f.status ?? null}::text is null or (${f.status === 'closed'} = (t.state = 'closed')))
    order by t.created_at`;
}

export async function analytics(f: Filters, db: Sql = sql) {
  const [cfg, sla, bleedsRaw, queries] = await Promise.all([bleedConfig(db), slaContext(db), bleedRows(db, f), queryRows(db, f)]);
  const now = new Date();

  // ---- bleeds ----
  const bleeds: any[] = bleedsRaw.map((b) => ({ ...b, state: bleedState(b), ...bleedIntervals(b, cfg.limits, now, cfg.th) }));
  const counted = bleeds.filter((b) => !b.cancelled_at); // cancelled: excluded from turnaround statistics (brief §6.6)
  const done = counted.filter((b) => b.filed_at);
  const within = (b: any) => b.intervals.every((i: any) => i.status !== 'done' || i.flag !== 'red');
  const stages = INTERVALS.map((iv, k) => {
    const used = counted.map((b) => b.intervals[k]).filter((i) => i.status === 'done').map((i) => i.used);
    const ok = used.filter((u) => u <= cfg.limits[k]).length;
    return { key: iv.key, label: iv.label, owner: iv.owner, limit: cfg.limits[k], n: used.length, avg: avg(used), median: median(used), compliance: pct(ok, used.length) };
  });
  const bleedBy = (key: (b: any) => string | number | null, label: (b: any) => string) =>
    [...groupBy(counted, key)].map(([k, xs]) => {
      const fin = xs.filter((b) => b.filed_at);
      return { id: k, label: label(xs[0]), n: xs.length, completed: fin.length, compliance: pct(fin.filter(within).length, fin.length), median_tat: median(fin.map((b) => b.total!)), breaches: xs.filter((b) => b.flag === 'red').length };
    }).sort((x, y) => y.n - x.n);
  const bleedTrend = days(f).map((d) => {
    const xs = counted.filter((b) => day(b.opened_at) === d);
    const fin = xs.filter((b) => b.filed_at);
    return { day: d, n: xs.length, compliance: pct(fin.filter(within).length, fin.length), median_tat: median(fin.map((b) => b.total!)) };
  });

  // ---- queries ----
  const assign = queries
    .flatMap((t) => (t.assignments ?? []).map((a: any) => ({ ...a, ticket: t, sla: sla.measure(t.site_id, a, now) })))
    .filter((a) => !f.department_id || a.department_id === f.department_id);
  const firstResp = (a: any) => (a.acknowledged_at ? sla.measure(a.ticket.site_id, { ...a, responded_at: a.acknowledged_at }).used : null);
  const deptPerf = [...groupBy(assign, (a) => a.department_id)].map(([k, xs]) => {
    const responded = xs.filter((a) => a.responded_at);
    const fr = xs.map(firstResp).filter((x): x is number => x != null);
    return {
      id: k, label: xs[0].department, n: xs.length, open: xs.filter((a) => ['assigned', 'in_progress'].includes(a.state)).length,
      avg_first_response: avg(fr), avg_resolution: avg(responded.map((a) => a.sla.used)),
      compliance: pct(responded.filter((a) => a.sla.pct < 100).length, responded.length + xs.filter((a) => !a.responded_at && a.sla.pct >= 100).length),
      breaches: xs.filter((a) => a.sla.pct >= 100).length,
    };
  }).sort((x, y) => y.n - x.n);
  const count = (key: (t: any) => string | number | null, label: (t: any) => string) =>
    [...groupBy(queries, key)].map(([k, xs]) => ({ id: k, label: label(xs[0]), n: xs.length })).sort((x, y) => y.n - x.n);
  const complainants = [...groupBy(queries, (t) => t.complainant_name.toLowerCase())].map(([, xs]) => ({
    label: xs[0].complainant_name, organisation: xs[0].organisation, n: xs.length,
    categories: [...groupBy(xs, (t) => t.category)].map(([c, ys]) => ({ category: c as string, n: ys.length })).sort((x, y) => y.n - x.n),
  }));
  const repeatPairs = complainants.flatMap((c) => c.categories.filter((x) => x.n > 1).map((x) => ({ complainant: c.label, organisation: c.organisation, category: x.category, n: x.n })));

  return {
    filters: f,
    bleeds: {
      requested: bleeds.length, cancelled: bleeds.length - counted.length, completed: done.length,
      compliance: pct(done.filter(within).length, done.length), median_tat: median(done.map((b) => b.total!)),
      geo_exceptions: counted.filter((b) => b.arrive_override || b.file_override || b.arrive_suspect || b.file_suspect).length,
      late_sync: counted.filter((b) => b.offline_sync).length,
      stages, trend: bleedTrend,
      by_site: bleedBy((b) => b.site_id, (b) => b.site ?? '—'),
      by_hospital: bleedBy((b) => b.hospital_id, (b) => b.hospital),
      by_nurse: bleedBy((b) => b.nurse_id, (b) => b.nurse ?? 'Unallocated'),
    },
    queries: {
      logged: queries.length, closed: queries.filter((t) => t.state === 'closed').length,
      compliance: pct(assign.filter((a) => a.responded_at && a.sla.pct < 100).length, assign.filter((a) => a.responded_at || a.sla.pct >= 100).length),
      by_category: count((t) => t.category_id, (t) => t.category),
      by_site: count((t) => t.site_id, (t) => t.site),
      by_department: deptPerf,
      by_complainant: complainants.sort((x, y) => y.n - x.n).slice(0, 15),
      repeats: repeatPairs.sort((x, y) => y.n - x.n).slice(0, 20),
      root_causes: count((t) => t.root_cause, (t) => t.root_cause),
      trend: days(f).map((d) => ({ day: d, n: queries.filter((t) => day(t.created_at) === d).length })),
    },
  };
}
export type Analytics = Awaited<ReturnType<typeof analytics>>;

/** Brief §7 live panels: today at a glance + breach register (every stage red today, with its reason). */
export async function live(db: Sql = sql) {
  const today = day(new Date());
  const [a] = range({ from: today, to: today });
  const [cfg, sla] = await Promise.all([bleedConfig(db), slaContext(db)]);
  const [tiles] = await db`
    select
      (select count(*)::int from bleeds where opened_at >= ${a}) as bleeds_requested,
      (select count(*)::int from bleeds where captured_at >= ${a} and outcome = 'successful') as bleeds_completed,
      (select count(*)::int from bleeds where filed_at >= ${a}) as reports_delivered,
      (select count(*)::int from tickets where created_at >= ${a}) as queries_logged,
      (select count(*)::int from tickets where closed_at >= ${a}) as queries_closed`;
  const bl = await db`
    select b.*, r.nurse_id, h.name as hospital from bleeds b join bleed_requests r on r.id = b.request_id join organisations h on h.id = r.hospital_id
    where b.cancelled_at is null and (b.closed_at is null or b.closed_at >= ${a}) and greatest(b.opened_at, b.arrived_at, b.captured_at, b.received_at, b.lab_accepted_at, b.released_at, b.filed_at) >= ${a} - interval '2 days'`;
  const register: any[] = [];
  for (const b of bl) {
    const { intervals } = bleedIntervals(b, cfg.limits, new Date(), cfg.th);
    intervals.forEach((iv, k) => {
      const end = b[['arrived_at', 'captured_at', 'received_at', 'lab_accepted_at', 'released_at', 'filed_at'][k]];
      if (iv.flag === 'red' && (iv.status === 'running' || (end && new Date(end) >= a)))
        register.push({ kind: 'bleed', id: b.id, number: b.number, where: b.hospital, stage: iv.label, used: iv.used, limit: iv.limit, running: iv.status === 'running', reason: b.breach_reasons?.[k] ?? null });
    });
  }
  const qa = await db`
    select x.*, t.number, t.site_id, t.id as ticket_id, d.name as department from assignments x join tickets t on t.id = x.ticket_id join departments d on d.id = x.department_id
    where x.state <> 'cancelled' and (x.state in ('assigned', 'in_progress') or x.responded_at >= ${a})`;
  for (const x of qa) {
    const m = sla.measure(x.site_id, x);
    if (m.pct >= cfg.th[1]) register.push({ kind: 'query', id: x.ticket_id, number: x.number, where: x.department, stage: 'Department response', used: m.used, limit: x.limit_minutes, running: !x.responded_at, reason: x.breach_reason });
  }
  register.sort((p, q) => Number(q.running) - Number(p.running) || q.used / q.limit - p.used / p.limit);
  return { tiles: { ...tiles, breaches: register.length }, register };
}
