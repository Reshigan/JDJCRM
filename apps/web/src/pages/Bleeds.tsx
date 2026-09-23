import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MapPinOff, Plus, WifiOff } from 'lucide-react';
import { BLEED_STATES, can, formatMinutes, patientRef, type BleedState } from '@baton/core';
import { api, useMe } from '../api';
import { ago, Badge, BatonBar, Button, cx, Empty, FlagPill, type Flag } from '../ui';

const RANK = { red: 2, amber: 1, green: 0 } as const;
const ENDED: BleedState[] = ['filed', 'unsuccessful', 'cancelled', 'closed'];

/** Brief §7 active bleed board: every bleed in progress; red sorts to the top. */
export function Bleeds() {
  const { data: me } = useMe();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') ?? 'open';
  const qs = new URLSearchParams({ ...Object.fromEntries(params), scope }).toString();
  const drill = [...params.keys()].some((k) => k !== 'scope');
  const { data, isLoading } = useQuery({ queryKey: ['bleeds', drill ? qs : scope], queryFn: () => api<any[]>(`/bleeds?${qs}`), refetchInterval: 20_000 });

  const rows = useMemo(
    () => [...(data ?? [])].sort((a, b) => Number(ENDED.includes(a.state)) - Number(ENDED.includes(b.state)) || RANK[b.flag as Flag] - RANK[a.flag as Flag] || +new Date(a.opened_at) - +new Date(b.opened_at)),
    [data],
  );
  const live = rows.filter((b) => !ENDED.includes(b.state));
  const count = (f: Flag) => live.filter((b) => b.flag === f).length;
  const toClose = rows.filter((b) => ['filed', 'unsuccessful'].includes(b.state)).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bleed board</h1>
          <p className="mt-0.5 text-sm text-muted">{drill ? <>Filtered from the dashboard · <button className="text-brand" onClick={() => setParams({}, { replace: true })}>clear filter</button></> : 'Every hospital bleed in progress, timed across six intervals. Refreshes automatically.'}</p>
        </div>
        {me && can(me.role, 'bleed.open') && <Button onClick={() => nav('/bleeds/new')}><Plus size={16} />New bleed request</Button>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([['Breached', count('red'), 'text-bad'], ['At risk', count('amber'), 'text-warn'], ['On time', count('green'), 'text-ok'], ['Ready to close', toClose, 'text-brand']] as const).map(([l, n, c]) => (
          <div key={l} className="card px-4 py-3">
            <div className="text-xs font-medium text-muted">{l}</div>
            <div className={cx('num mt-1 text-3xl font-semibold', n ? c : 'text-muted')}>{isLoading ? '–' : n}</div>
          </div>
        ))}
      </div>

      <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-sm">
        {['open', 'closed', 'all'].map((s) => (
          <button key={s} onClick={() => setParams(s === 'open' ? {} : { scope: s }, { replace: true })} className={cx('rounded-md px-3 py-1.5 capitalize', scope === s ? 'bg-brand-soft font-medium text-brand' : 'text-muted')}>{s}</button>
        ))}
      </div>

      <div className="space-y-2">
        {rows.map((b) => (
          <Link key={b.id} to={`/bleeds/${b.id}`} className={cx('card grid gap-3 p-4 transition hover:border-brand md:grid-cols-[180px_1fr_300px_140px] md:items-center', b.flag === 'red' && !ENDED.includes(b.state) && 'border-bad/40 bg-bad-soft/20')}>
            <div>
              <div className="num text-sm font-semibold">{b.number}</div>
              <div className="text-xs text-muted">{ago(b.opened_at)} ago · {b.request_number}</div>
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium">{b.hospital}</div>
              <div className="truncate text-xs text-muted">
                {patientRef(b.patient_name, b.folder_no)}{b.ward && ` · Ward ${b.ward}`} · {b.nurse ?? <span className="text-bad">No nurse allocated</span>}
              </div>
            </div>
            <div>
              <BatonBar intervals={b.intervals} />
              <div className="mt-1.5 flex items-center justify-between text-xs">
                <span className="font-medium">{BLEED_STATES[b.state as BleedState]}</span>
                {b.current && <span className={cx('num', b.current.flag === 'red' ? 'text-bad' : 'text-muted')}>{b.current.label} {formatMinutes(b.current.used)} / {formatMinutes(b.current.limit)}</span>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
              {!ENDED.includes(b.state) || b.state === 'filed' ? <FlagPill flag={b.flag} /> : <Badge>{BLEED_STATES[b.state as BleedState]}</Badge>}
              {b.geo_exception && <Badge tone="geo"><MapPinOff size={12} />Geo</Badge>}
              {b.offline_sync && <Badge><WifiOff size={12} />Late sync</Badge>}
            </div>
          </Link>
        ))}
        {!isLoading && !rows.length && <div className="card"><Empty>No bleeds here.</Empty></div>}
      </div>
    </div>
  );
}
