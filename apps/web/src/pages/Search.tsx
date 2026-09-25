import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BLEED_STATES, bleedState, patientRef, sast, type QueryState } from '@baton/core';
import { ShieldCheck } from 'lucide-react';
import { api, useMe } from '../api';
import { Badge, Button, Card, Empty, StatePill } from '../ui';

/** Full search across queries and bleeds (brief §7). Results respect the caller's scope. */
export function Search() {
  const [p] = useSearchParams();
  const q = p.get('q') ?? '';
  const { data: me } = useMe();
  const popia = me && ['cs_supervisor', 'management'].includes(me.role) && q.trim().length >= 3;
  const { data, isLoading } = useQuery({ queryKey: ['search', q], queryFn: () => api(`/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Search <span className="text-muted">“{q}”</span></h1>
        {popia && (
          <a href={`/api/popia/subject?q=${encodeURIComponent(q)}`} title="Every record held about this person and everyone who viewed it — for a POPIA access request. The export is audited.">
            <Button variant="outline" size="sm"><ShieldCheck size={15} />POPIA access report</Button>
          </a>
        )}
      </div>
      {q.trim().length < 2 && <p className="text-sm text-muted">Type at least two characters: a ticket number, patient, requisition, hospital or complainant.</p>}
      {isLoading && <div className="h-32 animate-pulse rounded-xl bg-surface-2" />}
      {data && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={`Queries (${data.tickets.length})`}>
            <ul className="-my-2 divide-y divide-line">
              {data.tickets.map((t: any) => (
                <li key={t.id}><Link to={`/tickets/${t.id}`} className="flex items-center justify-between gap-3 py-2.5 -mx-2 rounded-md px-2 hover:bg-surface-2">
                  <div className="min-w-0"><div className="num text-sm font-medium">{t.number}</div><div className="truncate text-xs text-muted">{t.category} · {t.complainant_name}{t.patient_name && ` · ${t.patient_name}`} · {sast(t.created_at).slice(0, 10)}</div></div>
                  <StatePill state={t.state as QueryState} />
                </Link></li>
              ))}
              {!data.tickets.length && <li><Empty>No queries match.</Empty></li>}
            </ul>
          </Card>
          <Card title={`Hospital bleeds (${data.bleeds.length})`}>
            <ul className="-my-2 divide-y divide-line">
              {data.bleeds.map((b: any) => (
                <li key={b.id}><Link to={`/bleeds/${b.id}`} className="flex items-center justify-between gap-3 py-2.5 -mx-2 rounded-md px-2 hover:bg-surface-2">
                  <div className="min-w-0"><div className="num text-sm font-medium">{b.number}</div><div className="truncate text-xs text-muted">{b.hospital} · {patientRef(b.patient_name, b.folder_no)}{b.requisition_no && ` · ${b.requisition_no}`} · {sast(b.opened_at).slice(0, 10)}</div></div>
                  <Badge tone="brand">{BLEED_STATES[bleedState(b)]}</Badge>
                </Link></li>
              ))}
              {!data.bleeds.length && <li><Empty>No bleeds match.</Empty></li>}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
