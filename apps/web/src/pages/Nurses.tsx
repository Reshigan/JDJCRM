// Live nurse runs for Client Services: every nurse's stops, what is left at each, and where they last checked in.
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MapPin, UserRound } from 'lucide-react';
import { formatMinutes, sast } from '@baton/core';
import { api } from '../api';
import { ago, Card, cx, Empty, FlagPill } from '../ui';

function Stops({ stops }: { stops: any[] }) {
  if (!stops.length) return <p className="text-sm text-muted">No active stops.</p>;
  return (
    <ol className="space-y-2">
      {stops.map((s, i) => (
        <li key={s.id}>
          <Link to={`/bleeds/${s.first_bleed}`} className={cx('flex items-center gap-3 rounded-lg border p-2.5 hover:bg-surface-2', s.flag === 'red' ? 'border-bad/40' : 'border-line')}>
            <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.hospital}</span>
              <span className="block text-xs text-muted">
                {s.arrived ? 'On site' : `Requested ${ago(s.opened_at)} ago`} · {s.to_bleed ? `${s.to_bleed} to bleed` : ''}{s.to_bleed && s.to_file ? ' · ' : ''}{s.to_file ? `${s.to_file} report${s.to_file > 1 ? 's' : ''} to file` : ''}
              </span>
            </span>
            <FlagPill flag={s.flag} compact />
          </Link>
        </li>
      ))}
    </ol>
  );
}

export function Nurses() {
  const { data } = useQuery({ queryKey: ['bleeds', 'runs'], queryFn: () => api('/dispatch/runs'), refetchInterval: 60_000 });
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Nurse runs</h1>
        <p className="mt-0.5 text-sm text-muted">Each nurse's open stops, in the order they were requested. Location shown is the hospital of their last checkpoint only.</p>
      </div>
      {data?.unallocated.length > 0 && (
        <Card title={<span className="text-bad">Unallocated requests ({data.unallocated.length})</span>}><Stops stops={data.unallocated} /></Card>
      )}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {data?.nurses.map((n: any) => (
          <Card key={n.id} title={<span className="flex items-center gap-2"><UserRound size={16} className="text-brand" />{n.name}</span>}
            action={<span className="text-xs text-muted">{n.stops.length} stop{n.stops.length === 1 ? '' : 's'}</span>}>
            <p className="-mt-1 mb-3 flex items-center gap-1.5 text-xs text-muted">
              <MapPin size={13} />{n.last_hospital ? <>Last at {n.last_hospital} · <span className="num">{sast(n.last_at).slice(11)}</span> ({formatMinutes((Date.now() - +new Date(n.last_at)) / 60_000, true)} ago)</> : 'No checkpoint yet'}
            </p>
            <Stops stops={n.stops} />
          </Card>
        ))}
      </div>
      {data && !data.nurses.length && <Empty>No active nursing staff.</Empty>}
    </div>
  );
}
