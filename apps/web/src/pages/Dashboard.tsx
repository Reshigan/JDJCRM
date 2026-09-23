// Central dashboard (brief §7). Opens on the live operational view; Performance holds analytics.
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Lightbulb, MapPinOff, Maximize2, OctagonAlert, CheckCircle2, TriangleAlert, WifiOff } from 'lucide-react';
import { BLEED_STATES, can, formatMinutes, PRIORITIES, ROOT_CAUSES, SAST_OFFSET, type BleedState } from '@baton/core';
import { api, useLookups, useMe } from '../api';
import { BarList, ChartCard, Columns, DataTable, PctLine, Stat } from '../charts';
import { BatonBar, Button, Card, cx, DeptClock, Empty, FlagPill, Select, type Flag } from '../ui';

const sastDay = (offsetDays = 0) => new Date(Date.now() + SAST_OFFSET - offsetDays * 86_400_000).toISOString().slice(0, 10);
const RANK = { red: 2, amber: 1, green: 0 } as const;
const pc = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const m = (v: number | null | undefined) => (v == null ? '—' : formatMinutes(v));

export function BreachRegister({ rows, compact }: { rows: any[]; compact?: boolean }) {
  if (!rows.length) return <Empty>No stage has gone red today.</Empty>;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-y border-line bg-surface-2/60 text-left text-xs text-muted">
          <tr>{['Ticket', 'Where', 'Stage', 'Time / limit', 'Breach reason'].map((h) => <th key={h} className="px-5 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, compact ? 8 : undefined).map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              <td className="px-5 py-2"><Link to={r.kind === 'bleed' ? `/bleeds/${r.id}` : `/tickets/${r.id}`} className="num font-medium hover:text-brand">{r.number}</Link></td>
              <td className="px-5 py-2">{r.where}</td>
              <td className="px-5 py-2"><span className="inline-flex items-center gap-1"><OctagonAlert size={13} className="text-bad" />{r.stage}{r.running && <span className="text-xs text-bad">· still running</span>}</span></td>
              <td className="num px-5 py-2">{formatMinutes(r.used)} / {formatMinutes(r.limit)}</td>
              <td className={cx('px-5 py-2', !r.reason && 'text-muted')}>{r.reason ?? (r.running ? 'Pending — required to proceed' : '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function useLive() {
  const live = useQuery({ queryKey: ['live'], queryFn: () => api('/dashboard/live'), refetchInterval: 60_000 });
  const bleeds = useQuery({ queryKey: ['bleeds', 'open'], queryFn: () => api<any[]>('/bleeds?scope=open'), refetchInterval: 60_000 });
  const queries = useQuery({ queryKey: ['tickets', ''], queryFn: () => api<any[]>('/tickets'), refetchInterval: 60_000 });
  const active = (bleeds.data ?? []).filter((b) => !['filed', 'unsuccessful', 'cancelled', 'closed'].includes(b.state))
    .sort((a, b) => RANK[b.flag as Flag] - RANK[a.flag as Flag] || (b.current?.pct ?? 0) - (a.current?.pct ?? 0));
  const open = (queries.data ?? []).sort((a, b) => (RANK[b.flag as Flag] ?? 0) - (RANK[a.flag as Flag] ?? 0) || +new Date(a.created_at) - +new Date(b.created_at));
  return { live: live.data, active, open, updated: live.dataUpdatedAt };
}

export const TILES: [string, string][] = [
  ['bleeds_requested', 'Bleeds requested'], ['bleeds_completed', 'Bleeds completed'], ['reports_delivered', 'Reports delivered'],
  ['queries_logged', 'Queries logged'], ['queries_closed', 'Queries closed'], ['breaches', 'Breaches recorded'],
];

function Insights() {
  const { data } = useQuery({ queryKey: ['insights'], queryFn: () => api<any[]>('/insights'), refetchInterval: 300_000 });
  if (!data?.length) return null;
  return (
    <section className="card p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Lightbulb size={16} className="text-brand" />Insights <span className="font-normal text-muted">· compared with each measure's own recent history</span></h2>
      <ul className="grid gap-2 lg:grid-cols-2">
        {data.map((i, k) => (
          <li key={k}>
            <Link to={i.link ?? '#'} className="flex gap-2.5 rounded-lg p-2 hover:bg-surface-2">
              {i.tone === 'warn' ? <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />}
              <span><span className="block text-sm font-medium">{i.title}</span><span className="block text-xs text-muted">{i.detail}</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Live() {
  const { live, active, open, updated } = useLive();
  return (
    <div className="space-y-5">
      <Insights />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {TILES.map(([k, l]) => <Stat key={k} label={l} value={live?.tiles[k] ?? '–'} tone={k === 'breaches' && live?.tiles[k] ? 'bad' : undefined} sub={k === 'breaches' ? 'stages red today' : 'today'} />)}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title={`Active bleeds (${active.length})`} action={<Link to="/bleeds" className="text-xs text-brand">Bleed board</Link>}>
          <ul className="-my-2 divide-y divide-line">
            {active.slice(0, 8).map((b) => (
              <li key={b.id}>
                <Link to={`/bleeds/${b.id}`} className="grid grid-cols-[1fr_170px] items-center gap-3 py-2.5 hover:opacity-80">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{b.hospital} <span className="num text-xs font-normal text-muted">{b.number}</span></div>
                    <div className="truncate text-xs text-muted">{b.nurse ?? 'Unallocated'} · {BLEED_STATES[b.state as BleedState]}{b.current && ` · ${formatMinutes(b.current.used)} in ${b.current.label.toLowerCase()}`}</div>
                  </div>
                  <div className="flex items-center gap-2"><BatonBar intervals={b.intervals} className="flex-1" /><FlagPill flag={b.flag} compact /></div>
                </Link>
              </li>
            ))}
            {!active.length && <li><Empty>No bleeds in progress.</Empty></li>}
          </ul>
        </Card>
        <Card title={`Open queries (${open.length})`} action={<Link to="/tickets" className="text-xs text-brand">Query board</Link>}>
          <ul className="-my-2 divide-y divide-line">
            {open.slice(0, 8).map((t) => {
              const run = t.assignments.filter((a: any) => ['assigned', 'in_progress'].includes(a.state));
              const left = run.length ? Math.min(...run.map((a: any) => a.sla.remaining)) : null;
              return (
                <li key={t.id}>
                  <Link to={`/tickets/${t.id}`} className="grid grid-cols-[1fr_auto] items-center gap-3 py-2.5 hover:opacity-80">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{t.category} <span className="num text-xs font-normal text-muted">{t.number}</span></div>
                      <div className={cx('truncate text-xs', left != null && left < 0 ? 'text-bad' : 'text-muted')}>{left == null ? 'With Client Services' : left < 0 ? `${formatMinutes(-left)} over` : `${formatMinutes(left)} left`}</div>
                    </div>
                    <div className="flex items-center gap-1">{t.assignments.map((a: any) => <DeptClock key={a.id} a={a} size={32} />)}</div>
                  </Link>
                </li>
              );
            })}
            {!open.length && <li><Empty>No open queries.</Empty></li>}
          </ul>
        </Card>
      </div>
      <Card title="Breach register · today" action={<span className="text-xs text-muted">Updated {updated ? new Date(updated).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>}>
        <BreachRegister rows={live?.register ?? []} />
      </Card>
    </div>
  );
}

function Filters() {
  const { data: lk } = useLookups();
  const [p, setP] = useSearchParams();
  const set = (k: string, v?: string) => { const n = new URLSearchParams(p); v ? n.set(k, v) : n.delete(k); setP(n, { replace: true }); };
  const preset = (d: number) => { const n = new URLSearchParams(p); n.set('from', sastDay(d - 1)); n.set('to', sastDay()); setP(n, { replace: true }); };
  const from = p.get('from') ?? sastDay(29), to = p.get('to') ?? sastDay();
  const days = Math.round((+new Date(to) - +new Date(from)) / 86_400_000) + 1;
  const regions = [...new Set(lk?.sites.map((s) => s.region).filter(Boolean))];
  const nurseDept = lk?.departments.find((d) => d.code === 'NUR')?.id;
  const sel = (k: string, label: string, opts: [string | number, string][]) => (
    <Select value={p.get(k) ?? ''} onChange={(e) => set(k, e.target.value)} className="h-9 w-auto max-w-44 text-[13px]" aria-label={label}>
      <option value="">{label}</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </Select>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-[13px]">
        {[1, 7, 30, 90].map((d) => <button key={d} onClick={() => preset(d)} className={cx('rounded-md px-2.5 py-1.5', days === d && to === sastDay() ? 'bg-brand-soft font-medium text-brand' : 'text-muted')}>{d === 1 ? 'Today' : `${d} days`}</button>)}
      </div>
      <input type="date" value={from} max={to} onChange={(e) => set('from', e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px]" aria-label="From" />
      <input type="date" value={to} min={from} onChange={(e) => set('to', e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px]" aria-label="To" />
      {sel('region', 'All regions', regions.map((r) => [r!, r!]))}
      {sel('site_id', 'All sites & depots', lk?.sites.map((s) => [s.id, s.name]) ?? [])}
      {sel('hospital_id', 'All hospitals', lk?.organisations.filter((o) => o.kind === 'hospital').map((o) => [o.id, o.name]) ?? [])}
      {sel('department_id', 'All departments', lk?.departments.map((d) => [d.id, d.name]) ?? [])}
      {sel('nurse_id', 'All nurses', lk?.users.filter((u) => u.department_id === nurseDept).map((u) => [u.id, u.name]) ?? [])}
      {sel('category_id', 'All categories', lk?.categories.map((c) => [c.id, c.name]) ?? [])}
      {sel('priority', 'Any priority', Object.entries(PRIORITIES))}
      {sel('status', 'Open & closed', [['open', 'Open'], ['closed', 'Closed']])}
    </div>
  );
}

function Performance() {
  const { data: me } = useMe();
  const nav = useNavigate();
  const [p] = useSearchParams();
  const f = new URLSearchParams(p);
  if (!f.get('from')) f.set('from', sastDay(29));
  if (!f.get('to')) f.set('to', sastDay());
  const qs = f.toString();
  const { data: a, isFetching, error } = useQuery({ queryKey: ['analytics', qs], queryFn: () => api(`/analytics?${qs}`), placeholderData: keepPreviousData });
  const period = `from=${f.get('from')}&to=${f.get('to')}`;
  const drillB = (k: string) => (id: string | number) => nav(`/bleeds?scope=all&${period}&${k}=${id}`);
  const drillQ = (k: string) => (id: string | number) => nav(`/tickets?scope=all&${period}&${k}=${id}`);
  if (error) return <p className="text-sm text-bad">{(error as Error).message}</p>;
  if (!a) return <div className="h-64 animate-pulse rounded-xl bg-surface-2" />;
  const b = a.bleeds, q = a.queries;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Filters />
        {me && can(me.role, 'dashboard.export') && <a href={`/api/export.xlsx?${qs}`}><Button variant="outline" size="sm"><Download size={15} />Export to Excel</Button></a>}
      </div>

      {b && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight">Hospital bleeds</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <div className="col-span-2"><Stat hero label="Turnaround compliance" value={pc(b.compliance)} sub={`${b.completed} report${b.completed === 1 ? '' : 's'} filed · every interval within its limit`} /></div>
            <Stat label="Bleeds requested" value={b.requested} sub={`${b.cancelled} cancelled, excluded`} />
            <Stat label="Median total turnaround" value={m(b.median_tat)} sub="call to report in folder" />
            <Stat label="Geolocation exceptions" value={<span className="inline-flex items-center gap-2">{b.geo_exceptions}{b.geo_exceptions > 0 && <MapPinOff size={20} className="text-geo" />}</span>} sub="override with reason" />
            <Stat label="Late (offline) syncs" value={<span className="inline-flex items-center gap-2">{b.late_sync}{b.late_sync > 0 && <WifiOff size={20} className="text-muted" />}</span>} sub="device time kept" />
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <ChartCard dim={isFetching} title="Median time per stage" sub="Bar = median of completed intervals · line = time limit"
              table={<DataTable head={['Stage', 'Completed', 'Average', 'Median', 'Limit', 'Compliance']} rows={b.stages.map((s: any) => ({ key: s.key, cells: [s.label, s.n, m(s.avg), m(s.median), m(s.limit), pc(s.compliance)] }))} />}>
              <BarList fmt={formatMinutes} rows={b.stages.map((s: any) => ({ id: s.key, label: s.label, value: s.median, marker: s.limit, tip: <div className="text-muted">avg {m(s.avg)} · {s.n} done · {pc(s.compliance)} within limit</div> }))} />
            </ChartCard>
            <ChartCard dim={isFetching} title="Compliance by stage" sub="% of completed intervals within their limit"
              table={<DataTable head={['Stage', 'Owner', 'Compliance']} rows={b.stages.map((s: any) => ({ key: s.key, cells: [s.label, s.owner, pc(s.compliance)] }))} />}>
              <BarList fmt={(v) => `${v}%`} rows={b.stages.map((s: any) => ({ id: s.key, label: s.label, value: s.compliance, tip: <div className="text-muted">{s.owner}</div> }))} />
            </ChartCard>
            <ChartCard dim={isFetching} title="Bleeds per day" sub="Requested, excluding cancelled"
              table={<DataTable head={['Day', 'Bleeds', 'Compliance', 'Median TAT']} rows={b.trend.map((d: any) => ({ key: d.day, cells: [d.day, d.n, pc(d.compliance), m(d.median_tat)] }))} />}>
              <Columns data={b.trend} label="bleeds" />
            </ChartCard>
            <ChartCard dim={isFetching} title="Turnaround compliance per day" sub="Of bleeds opened that day with the report filed"
              table={<DataTable head={['Day', 'Compliance']} rows={b.trend.map((d: any) => ({ key: d.day, cells: [d.day, pc(d.compliance)] }))} />}>
              <PctLine data={b.trend.map((d: any) => ({ day: d.day, v: d.compliance }))} label="compliance" />
            </ChartCard>
          </div>
          <div className="grid gap-5 xl:grid-cols-3">
            {([['Per hospital', b.by_hospital, 'hospital_id'], ['Per site', b.by_site, 'site_id'], ['Per nurse', b.by_nurse, 'nurse_id']] as const).map(([title, rows, key]) => (
              <ChartCard key={title} dim={isFetching} title={`Compliance ${title.toLowerCase()}`} sub="Click a row for its bleeds"
                table={<DataTable onPick={drillB(key)} head={[title.slice(4), 'Bleeds', 'Filed', 'Compliance', 'Median TAT', 'Red now']} rows={rows.map((r: any) => ({ key: r.id, cells: [r.label, r.n, r.completed, pc(r.compliance), m(r.median_tat), r.breaches] }))} />}>
                <BarList onPick={drillB(key)} fmt={(v) => `${v}%`} rows={rows.map((r: any) => ({ id: r.id, label: r.label, value: r.compliance, tip: <div className="text-muted">{r.n} bleeds · {r.completed} filed · median {m(r.median_tat)}</div> }))} />
              </ChartCard>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">Queries</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Queries logged" value={q.logged} />
          <Stat label="Queries closed" value={q.closed} />
          <Stat label="Department response compliance" value={pc(q.compliance)} sub="responded within limit" />
          <Stat label="Repeat failures" value={q.repeats.length} sub="same complainant, same category" tone={q.repeats.length ? 'warn' : undefined} />
        </div>
        <div className="grid gap-5 xl:grid-cols-2">
          <ChartCard dim={isFetching} title="Volume by category" sub="Click a bar for its tickets"
            table={<DataTable onPick={drillQ('category_id')} head={['Category', 'Queries']} rows={q.by_category.map((c: any) => ({ key: c.id, cells: [c.label, c.n] }))} />}>
            <BarList onPick={drillQ('category_id')} rows={q.by_category.map((c: any) => ({ id: c.id, label: c.label, value: c.n }))} />
          </ChartCard>
          <ChartCard dim={isFetching} title="Queries per day" table={<DataTable head={['Day', 'Queries']} rows={q.trend.map((d: any) => ({ key: d.day, cells: [d.day, d.n] }))} />}>
            <Columns data={q.trend} label="queries" />
          </ChartCard>
        </div>
        <Card title="Department response performance">
          <div className="-mx-5 -my-5 overflow-x-auto">
            <DataTable onPick={drillQ('department_id')} head={['Department', 'Assigned', 'Open', 'Avg first response', 'Avg resolution', 'Compliance', 'Breaches']}
              rows={q.by_department.map((d: any) => ({ key: d.id, cells: [d.label, d.n, d.open, m(d.avg_first_response), m(d.avg_resolution), pc(d.compliance), d.breaches] }))} />
          </div>
        </Card>
        <div className="grid gap-5 xl:grid-cols-3">
          <ChartCard dim={isFetching} title="Volume by site" table={<DataTable onPick={drillQ('site_id')} head={['Site', 'Queries']} rows={q.by_site.map((c: any) => ({ key: c.id, cells: [c.label, c.n] }))} />}>
            <BarList onPick={drillQ('site_id')} rows={q.by_site.map((c: any) => ({ id: c.id, label: c.label, value: c.n }))} />
          </ChartCard>
          <ChartCard dim={isFetching} title="Top complainants" table={<DataTable head={['Complainant', 'Queries']} rows={q.by_complainant.map((c: any) => ({ key: c.label, cells: [c.label, c.n] }))} />}>
            <BarList onPick={(id) => nav(`/search?q=${encodeURIComponent(String(id))}`)} rows={q.by_complainant.slice(0, 8).map((c: any) => ({ id: c.label, label: c.label, value: c.n, tip: <div className="text-muted">{c.categories.map((x: any) => `${x.category} ×${x.n}`).join(', ')}</div> }))} />
          </ChartCard>
          <ChartCard dim={isFetching} title="Root cause of closed queries" table={<DataTable head={['Root cause', 'Queries']} rows={q.root_causes.map((c: any) => ({ key: c.id, cells: [ROOT_CAUSES[c.id as keyof typeof ROOT_CAUSES] ?? c.id, c.n] }))} />}>
            <BarList rows={q.root_causes.map((c: any) => ({ id: c.id, label: ROOT_CAUSES[c.id as keyof typeof ROOT_CAUSES] ?? String(c.id), value: c.n }))} />
          </ChartCard>
        </div>
        <Card title="Repeat failures — the same failure recurring">
          {q.repeats.length ? (
            <div className="-mx-5 -my-5 overflow-x-auto">
              <DataTable onPick={(k) => nav(`/search?q=${encodeURIComponent(String(k).split('|')[0])}`)} head={['Complainant', 'Practice / hospital', 'Category', 'Times']}
                rows={q.repeats.map((r: any) => ({ key: `${r.complainant}|${r.category}`, cells: [r.complainant, r.organisation ?? '—', r.category, r.n] }))} />
            </div>
          ) : <Empty>No complainant has raised the same category twice in this period.</Empty>}
        </Card>
      </section>
    </div>
  );
}

/** Corrective-action effectiveness checks (ISO 15189 quality indicator). */
function Quality() {
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['quality'], queryFn: () => api('/quality/effectiveness') });
  if (!data) return <div className="h-40 animate-pulse rounded-xl bg-surface-2" />;
  const today = sastDay();
  const overdue = data.due.filter((r: any) => r.effectiveness_due < today).length;
  const rate = data.checked.length ? Math.round((data.effective / data.checked.length) * 100) : null;
  const open = (k: string | number) => nav(`/tickets/${k}`);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Checks due" value={data.due.length} />
        <Stat label="Overdue" value={overdue} tone={overdue ? 'bad' : undefined} />
        <Stat label="Effective (12 months)" value={pc(rate)} sub={`${data.effective} of ${data.checked.length} checked`} tone={rate != null && rate >= 90 ? 'ok' : undefined} />
        <Stat label="Not effective" value={data.not_effective} tone={data.not_effective ? 'warn' : undefined} />
      </div>
      <Card title="Effectiveness checks due">
        <div className="-mx-5 -my-5 overflow-x-auto">
          <DataTable text onPick={open} head={['Ticket', 'Category', 'Root cause', 'Closed', 'Due']}
            rows={data.due.map((r: any) => ({ key: r.id, cells: [<span className="num">{r.number}</span>, r.category, ROOT_CAUSES[r.root_cause as keyof typeof ROOT_CAUSES] ?? '—', r.closed_at.slice(0, 10), <span className={cx('num', r.effectiveness_due < today && 'font-semibold text-bad')}>{r.effectiveness_due}</span>] }))} />
        </div>
      </Card>
      <Card title="Checked in the last 12 months">
        <div className="-mx-5 -my-5 overflow-x-auto">
          <DataTable text onPick={open} head={['Ticket', 'Category', 'Result', 'Evidence', 'Checked by']}
            rows={data.checked.map((r: any) => ({ key: r.id, cells: [<span className="num">{r.number}</span>, r.category, r.effectiveness_result === 'effective' ? 'Effective' : <span className="font-semibold text-bad">Not effective</span>, <span className="line-clamp-1 max-w-[320px]">{r.effectiveness_note}</span>, r.checked_by] }))} />
        </div>
      </Card>
    </div>
  );
}

export function Dashboard() {
  const { tab = 'live' } = useParams();
  const { data: me } = useMe();
  const liveAllowed = me && can(me.role, 'dashboard.view');
  const t = liveAllowed ? tab : 'performance';
  const [p] = useSearchParams();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-0.5 text-sm text-muted">{t === 'live' ? 'Live operational picture across all sites. Refreshes every 20 seconds.' : t === 'quality' ? 'Were corrective actions effective? Checks fall due on the date set at closure.' : 'Turnaround performance and query analytics. Every figure drills down to its tickets.'}</p>
        </div>
        {liveAllowed && <Link to="/wall" target="_blank"><Button variant="outline" size="sm"><Maximize2 size={15} />Wall mode</Button></Link>}
      </div>
      {liveAllowed && (
        <nav className="flex gap-1 border-b border-line">
          {[['live', 'Live'], ['performance', 'Performance'], ['quality', 'Quality']].map(([k, l]) => (
            <NavLink key={k} to={`/dashboard/${k}${k === 'performance' && p.toString() ? `?${p}` : ''}`} className={cx('border-b-2 px-3 py-2 text-sm', t === k ? 'border-brand font-medium text-brand' : 'border-transparent text-muted hover:text-text')}>{l}</NavLink>
          ))}
        </nav>
      )}
      {t === 'live' ? <Live /> : t === 'quality' ? <Quality /> : <Performance />}
    </div>
  );
}
