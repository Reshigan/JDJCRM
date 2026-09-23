import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { can, formatMinutes, PRIORITIES, sast } from '@baton/core';
import { api, useLookups, useMe } from '../api';
import { ago, Badge, Button, cx, DeptClock, Empty, FlagPill, PRIORITY_TONE, Select, StatePill, type Flag } from '../ui';

const RANK = { red: 2, amber: 1, green: 0 } as const;

export function Tickets() {
  const { data: me } = useMe();
  const { data: lk } = useLookups();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const p = Object.fromEntries(params);
  const set = (k: string, v?: string) => {
    const n = new URLSearchParams(params);
    v ? n.set(k, v) : n.delete(k);
    setParams(n, { replace: true });
  };
  const { flag, ...serverParams } = p;
  const qs = new URLSearchParams(serverParams).toString();
  const { data, isLoading } = useQuery({ queryKey: ['tickets', qs], queryFn: () => api<any[]>(`/tickets?${qs}`), refetchInterval: 30_000 });

  const counts = useMemo(() => {
    const c = { red: 0, amber: 0, green: 0, review: 0 };
    for (const t of data ?? []) {
      if (t.flag) c[t.flag as Flag]++;
      if (t.state === 'response_submitted' || t.state === 'under_review') c.review++;
    }
    return c;
  }, [data]);

  // Red sorts to the top, then amber, then oldest first.
  const rows = useMemo(
    () =>
      (data ?? [])
        .filter((t) => !flag || t.flag === flag)
        .sort((a, b) => (RANK[b.flag as Flag] ?? -1) - (RANK[a.flag as Flag] ?? -1) || +new Date(a.created_at) - +new Date(b.created_at)),
    [data, flag],
  );

  const all = me && can(me.role, 'tickets.view_all');
  const scope = p.scope ?? 'open';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{all ? 'Query board' : 'My department'}</h1>
          <p className="mt-0.5 text-sm text-muted">
            {all ? 'Every open query across all sites. Breaches sort to the top.' : `Tickets routed to ${lk?.departments.find((d) => d.id === me?.department_id)?.name ?? 'your department'}.`}
          </p>
        </div>
        {me && can(me.role, 'ticket.open') && (
          <Button onClick={() => nav('/tickets/new')}><Plus size={16} />New query <kbd className="num ml-1 rounded bg-white/20 px-1 text-[11px]">N</kbd></Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(
          [
            ['red', 'Breached', counts.red, 'text-bad'],
            ['amber', 'At risk', counts.amber, 'text-warn'],
            ['green', 'On time', counts.green, 'text-ok'],
            [null, 'Awaiting CS review', counts.review, 'text-brand'],
          ] as const
        ).map(([f, label, n, cls]) => (
          <button
            key={label}
            onClick={() => f && set('flag', flag === f ? undefined : f)}
            className={cx('card px-4 py-3 text-left transition', f && 'hover:border-brand', flag === f && f && 'ring-2 ring-brand')}
          >
            <div className="text-xs font-medium text-muted">{label}</div>
            <div className={cx('num mt-1 text-3xl font-semibold', n ? cls : 'text-muted')}>{isLoading ? '–' : n}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-sm">
          {['open', 'closed', 'all'].map((s) => (
            <button key={s} onClick={() => set('scope', s === 'open' ? undefined : s)} className={cx('rounded-md px-3 py-1.5 capitalize', scope === s ? 'bg-brand-soft font-medium text-brand' : 'text-muted')}>
              {s}
            </button>
          ))}
        </div>
        {all && (
          <div className="w-full sm:w-52"><Select value={p.department_id ?? ''} onChange={(e) => set('department_id', e.target.value)} className="h-9">
            <option value="">All departments</option>
            {lk?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select></div>
        )}
        <div className="w-full sm:w-40"><Select value={p.priority ?? ''} onChange={(e) => set('priority', e.target.value)} className="h-9">
          <option value="">Any priority</option>
          {Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select></div>
        {p.q && (
          <button onClick={() => set('q')} className="inline-flex h-9 items-center gap-1 rounded-lg bg-brand-soft px-3 text-sm text-brand">
            “{p.q}” <X size={14} />
          </button>
        )}
      </div>

      <ul className="space-y-2 md:hidden">
        {rows.map((t) => (
          <li key={t.id}>
            <Link to={`/tickets/${t.id}`} className={cx('card block p-4', t.flag === 'red' && 'border-bad/40')}>
              <div className="flex items-center justify-between gap-2">
                <span className="num text-sm font-semibold">{t.number}</span>
                {t.flag ? <FlagPill flag={t.flag} /> : <Badge tone="green">Closed</Badge>}
              </div>
              <div className="mt-1 truncate text-sm font-medium">{t.category}</div>
              <div className="truncate text-xs text-muted">{t.complainant_name} · {ago(t.created_at)} ago</div>
              <div className="mt-2 flex items-center justify-between">
                <div className="flex gap-1">{t.assignments.map((a: any) => <DeptClock key={a.id} a={a} size={34} />)}</div>
                <StatePill state={t.state} />
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="card hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-line bg-surface-2/60 text-left text-xs text-muted">
              <tr>
                <th className="w-28 px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Ticket</th>
                <th className="px-4 py-2.5 font-medium">Category · complainant</th>
                <th className="px-4 py-2.5 font-medium">Departments</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 text-right font-medium">Time left</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const running = t.assignments.filter((a: any) => ['assigned', 'in_progress'].includes(a.state));
                const left = running.length ? Math.min(...running.map((a: any) => a.sla.remaining)) : null;
                return (
                  <tr key={t.id} className={cx('border-b border-line last:border-0 hover:bg-surface-2/60', t.flag === 'red' && 'bg-bad-soft/30')}>
                    <td className="px-4 py-3">{t.flag ? <FlagPill flag={t.flag} /> : <Badge tone="green">Closed</Badge>}</td>
                    <td className="px-4 py-3">
                      <Link to={`/tickets/${t.id}`} className="num font-semibold text-text hover:text-brand">{t.number}</Link>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                        <Badge tone={PRIORITY_TONE[t.priority as keyof typeof PRIORITY_TONE]}>{PRIORITIES[t.priority as keyof typeof PRIORITIES]}</Badge>
                        <span title={sast(t.created_at)}>{ago(t.created_at)} ago</span>
                      </div>
                    </td>
                    <td className="max-w-[320px] px-4 py-3">
                      <Link to={`/tickets/${t.id}`} className="block truncate font-medium">{t.category}</Link>
                      <div className="truncate text-xs text-muted">{t.complainant_name}{t.organisation && ` · ${t.organisation}`} · {t.site}</div>
                    </td>
                    <td className="px-4 py-3"><div className="flex gap-1">{t.assignments.map((a: any) => <DeptClock key={a.id} a={a} size={38} />)}</div></td>
                    <td className="px-4 py-3">
                      <StatePill state={t.state} />
                      {t.cycle > 0 && <span className="ml-1.5 text-xs text-muted">cycle {t.cycle + 1}</span>}
                    </td>
                    <td className={cx('num px-4 py-3 text-right', left != null && left < 0 ? 'font-semibold text-bad' : 'text-muted')}>
                      {left == null ? '—' : left < 0 ? `${formatMinutes(-left)} over` : formatMinutes(left)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!isLoading && !rows.length && <Empty>No tickets match. Nothing is waiting on you.</Empty>}
      </div>
    </div>
  );
}
