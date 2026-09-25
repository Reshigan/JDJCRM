import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanLine, TestTubes } from 'lucide-react';
import { BLEED_STATES, formatMinutes, patientRef, type BleedState } from '@baton/core';
import { api, useLookups, useMe } from '../api';
import { StageBar, Button, cx, Empty, ErrorText, FlagPill, Input } from '../ui';

const ACTION: Record<string, { step: string; label: string; dept: string }> = {
  in_transit: { step: 'receive', label: 'Accept sample in', dept: 'PRE' },
  receiving: { step: 'lab_accept', label: 'Accept into lab', dept: 'ANA' },
  processing: { step: 'release', label: 'Results released', dept: 'ANA' },
};

/** Pre-Analytical and laboratory desk: scan (keyboard-wedge scanner) or type a BLD / requisition number. */
export function Samples() {
  const { data: me } = useMe();
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const code = lk?.departments.find((d) => d.id === me?.department_id)?.code;
  const [q, setQ] = useState('');
  const [breach, setBreach] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null);
  const { data: rows, isLoading } = useQuery({ queryKey: ['samples', q], queryFn: () => api<any[]>(`/samples${q ? `?q=${encodeURIComponent(q)}` : ''}`), refetchInterval: 60_000 });
  const act = useMutation({
    mutationFn: ({ id, step }: { id: string; step: string }) => api(`/bleeds/${id}/step`, { body: { step, breach_reason: breach[id] || undefined } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['samples'] }); setQ(''); input.current?.focus(); },
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sample desk</h1>
        <p className="mt-0.5 text-sm text-muted">{code === 'PRE' ? 'Accept hospital bleed samples from nursing and logistics.' : 'Accept samples into the laboratory and release results.'} Scan the requisition or BLD barcode.</p>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); setQ(input.current!.value.trim()); input.current!.value = ''; }} className="relative max-w-xl">
        <ScanLine size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-brand" />
        <Input ref={input} autoFocus placeholder="Scan or type BLD-… / requisition number, then Enter" className="num h-12 pl-10 text-base" />
      </form>
      {q && <button className="text-sm text-brand" onClick={() => setQ('')}>Showing “{q}” — back to queue</button>}
      <ErrorText error={act.error} />

      <div className="space-y-2">
        {rows?.map((s) => {
          const a = ACTION[s.state];
          const mine = a && a.dept === code;
          const red = s.current?.flag === 'red';
          return (
            <div key={s.id} className={cx('card grid gap-3 p-4 md:grid-cols-[200px_1fr_260px_220px] md:items-center', red && 'border-bad/40')}>
              <div>
                <div className="num font-semibold">{s.number}</div>
                <div className="num text-xs text-muted">{s.requisition_no ?? 'no requisition'}</div>
              </div>
              <div className="min-w-0 text-sm">
                <div className="truncate">{s.hospital} · {patientRef(s.patient, s.folder_no)}</div>
                <div className="flex flex-wrap gap-1 text-xs text-muted"><TestTubes size={13} />{s.tubes.map((t: any) => `${t.count}× ${t.type}`).join(', ') || '—'}</div>
              </div>
              <div>
                <StageBar intervals={s.intervals} />
                <div className="mt-1 flex justify-between text-xs"><span>{BLEED_STATES[s.state as BleedState]}</span>{s.current && <span className={cx('num', red ? 'text-bad' : 'text-muted')}>{formatMinutes(s.current.used)} / {formatMinutes(s.current.limit)}</span>}</div>
              </div>
              <div className="flex flex-col gap-2 md:items-end">
                {mine ? (
                  <>
                    {red && <Input placeholder="Breach reason (required)" value={breach[s.id] ?? ''} onChange={(e) => setBreach({ ...breach, [s.id]: e.target.value })} className="h-9" />}
                    <Button className="w-full md:w-auto" disabled={act.isPending || (red && !breach[s.id])} onClick={() => act.mutate({ id: s.id, step: a.step })}>{a.label}</Button>
                  </>
                ) : <FlagPill flag={s.flag} />}
              </div>
            </div>
          );
        })}
        {!isLoading && !rows?.length && <div className="card"><Empty>{q ? 'No active bleed matches that number.' : 'Nothing waiting at your desk.'}</Empty></div>}
      </div>
    </div>
  );
}
