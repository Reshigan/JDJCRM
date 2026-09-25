import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Lock, MapPin, MapPinOff, UserRound, WifiOff } from 'lucide-react';
import { BLEED_STATES, can, CHECKPOINTS, formatMinutes, OUTCOMES, PHOTO_SHARPNESS_MIN, sast, type BleedState } from '@baton/core';
import { api, formValues, useLookups, useMe } from '../api';
import { Badge, StageBar, Button, Card, cx, ErrorText, Field, FlagPill, Modal, Select, Textarea } from '../ui';

const EVENT: Record<string, (d: any) => string> = {
  'bleed.requested': (d) => `Bleed requested · ${d.hospital} · ${d.patients} patient(s)`,
  'bleed.opened': (d) => `Ticket ${d.number} opened`,
  'bleed.arrived': (d) => `Nurse arrived${d.distance_m != null ? ` · ${d.distance_m} m from hospital, ±${d.accuracy_m} m` : ''}${d.override ? ` · override: ${d.override}` : ''}${d.late ? ' · synced late' : ''}`,
  'bleed.captured': (d) => `Bleed captured · ${d.tubes} tube(s)${d.late ? ' · synced late' : ''}`,
  'bleed.unsuccessful': (d) => `Unsuccessful: ${OUTCOMES[d.outcome as keyof typeof OUTCOMES]} — ${d.reason}`,
  'bleed.receive': () => 'Accepted into Pre-Analytical',
  'bleed.lab_accept': () => 'Accepted into the laboratory',
  'bleed.release': () => 'All results released',
  'bleed.filed': (d) => `Report filed in patient folder${d.distance_m != null ? ` · ${d.distance_m} m from hospital` : ''}${d.override ? ` · override: ${d.override}` : ''}`,
  'bleed.escalated': (d) => `${d.level === 2 ? 'Red' : 'Amber'} · ${d.interval} at ${d.pct}%`,
  'bleed.cancelled': (d) => `Cancelled: ${d.reason}`,
  'bleed.closed': () => 'Closed by Client Services',
  'bleed.nurse_changed': (d) => `Nurse changed to ${d.nurse}: ${d.reason}`,
  'photo.viewed': (d) => `Viewed ${d.kind} photo`,
};

function PendingReason({ id, interval, onDone }: { id: string; interval: number; onDone: () => void }) {
  const [v, setV] = useState('');
  const m = useMutation({ mutationFn: () => api(`/bleeds/${id}/breach-reason`, { body: { interval, reason: v } }), onSuccess: onDone });
  return (
    <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Reason needed (late, from LIS)" className="h-7 w-44 rounded-md border border-warn/60 bg-surface px-2 text-xs" required />
      <Button size="sm" className="h-7" disabled={m.isPending}>Save</Button>
      {m.error && <span className="text-bad">{(m.error as Error).message}</span>}
    </form>
  );
}

export function Bleed() {
  const { id } = useParams() as { id: string };
  const { data: me } = useMe();
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const { data: b, error, isLoading } = useQuery({ queryKey: ['bleed', id], queryFn: () => api(`/bleeds/${id}`), refetchInterval: 60_000 });
  const [modal, setModal] = useState<'cancel' | 'nurse' | null>(null);
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api(path, { body: body ?? {} }),
    onSuccess: () => { setModal(null); qc.invalidateQueries({ queryKey: ['bleed', id] }); qc.invalidateQueries({ queryKey: ['bleeds'] }); },
  });

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-surface-2" />;
  if (error || !b) return <ErrorText error={error ?? new Error('Not found')} />;

  const cs = me && can(me.role, 'bleed.open');
  const state = b.state as BleedState;
  const ended = ['filed', 'unsuccessful', 'cancelled', 'closed'].includes(state);
  const nurseDept = lk?.departments.find((d) => d.code === 'NUR')?.id;
  const byCp = [null, b.nurse, b.who[b.captured_by], b.who[b.received_by], b.who[b.lab_accepted_by], b.who[b.released_by], b.who[b.filed_by]];

  return (
    <div className="space-y-5">
      <Link to="/bleeds" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft size={15} />Bleed board</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="num text-2xl font-semibold tracking-tight">{b.number}</h1>
            <Badge tone={state === 'closed' ? 'green' : 'brand'}>{BLEED_STATES[state]}</Badge>
            {state !== 'cancelled' && <FlagPill flag={b.flag} />}
            {b.geo_exception && <Badge tone="geo"><MapPinOff size={12} />Geolocation exception</Badge>}
            {b.offline_sync && <Badge><WifiOff size={12} />Synced late</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">{b.hospital} · request <span className="num">{b.request_number}</span> · {b.requested_by}</p>
        </div>
        {cs && (
          <div className="flex flex-wrap gap-2">
            {!b.arrived_at && !ended && <Button variant="outline" onClick={() => setModal('nurse')}><UserRound size={15} />Change nurse</Button>}
            {!ended && <Button variant="outline" onClick={() => setModal('cancel')}><Ban size={15} />Cancel</Button>}
            {(state === 'filed' || state === 'unsuccessful') && <Button onClick={() => act.mutate({ path: `/bleeds/${id}/close` })}><Lock size={15} />Close ticket</Button>}
          </div>
        )}
      </div>
      <ErrorText error={act.error} />

      <Card>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="text-sm text-muted">{b.current ? <>Now: <b className="text-text">{b.current.label}</b> · {b.current.owner}</> : BLEED_STATES[state]}</div>
          <div className="text-sm">Total turnaround <span className="num ml-1 text-lg font-semibold">{b.total != null ? formatMinutes(b.total) : '—'}</span></div>
        </div>
        <StageBar intervals={b.intervals} labels className="mt-3" />
        <div className="-mx-5 mt-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-y border-line bg-surface-2/60 text-left text-xs text-muted">
              <tr>{['Interval', 'Owner', 'Started', 'Stopped', 'Used / limit', 'Status', 'Breach reason'].map((h) => <th key={h} className="px-5 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {b.intervals.map((iv: any, i: number) => (
                <tr key={iv.key} className={cx('border-b border-line last:border-0', iv.status === 'running' && 'bg-brand-soft/30')}>
                  <td className="px-5 py-2.5 font-medium">{i + 1}. {iv.label}</td>
                  <td className="px-5 py-2.5 text-muted">{iv.owner}</td>
                  <td className="num px-5 py-2.5">{b[CHECKPOINTS[i]] ? sast(b[CHECKPOINTS[i]]).slice(11) : '—'}</td>
                  <td className="num px-5 py-2.5">{b[CHECKPOINTS[i + 1]] ? <>{sast(b[CHECKPOINTS[i + 1]]).slice(11)} <span className="font-sans text-xs text-muted">{byCp[i + 1]}</span></> : '—'}</td>
                  <td className="num px-5 py-2.5">{iv.status === 'pending' ? '—' : `${formatMinutes(iv.used)} / ${formatMinutes(iv.limit)}`}</td>
                  <td className="px-5 py-2.5">{iv.status === 'pending' ? <span className="text-xs text-muted">Not started</span> : <FlagPill flag={iv.flag} />}</td>
                  <td className="px-5 py-2.5 text-xs">{String(b.breach_reasons?.[i] ?? '').startsWith('Pending —') ? <PendingReason id={id} interval={i} onDone={() => qc.invalidateQueries({ queryKey: ['bleed', id] })} /> : b.breach_reasons?.[i] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <Card title="Patient and bleed">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              {[
                ['Patient', b.patient_name], ['Folder / hospital no.', b.folder_no], ['Ward · bed', [b.ward, b.bed].filter(Boolean).join(' · ')],
                ['Requisition', b.requisition_no], ['Outcome', b.outcome ? OUTCOMES[b.outcome as keyof typeof OUTCOMES] : null], ['Nurse', b.nurse],
              ].map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="mt-0.5">{v || '—'}</dd></div>)}
            </dl>
            {b.tubes?.length > 0 && <div className="mt-4 flex flex-wrap gap-1.5">{b.tubes.map((t: any) => <Badge key={t.type} tone="brand">{t.count} × {t.type}</Badge>)}</div>}
            {b.outcome_reason && <p className="mt-3 rounded-lg bg-warn-soft p-3 text-sm text-warn">{b.outcome_reason}</p>}
            {b.cancel_reason && <p className="mt-3 rounded-lg bg-surface-2 p-3 text-sm">Cancelled: {b.cancel_reason}. Excluded from turnaround statistics.</p>}
            {b.photos.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                {b.photos.map((p: any) => (
                  <a key={p.id} href={`/api/bleed-photos/${p.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line">
                    <img src={`/api/bleed-photos/${p.id}`} alt={`${p.kind} photograph`} className="aspect-[4/3] w-full object-cover" />
                    <div className="px-2 py-1 text-xs text-muted">{p.kind === 'sticker' ? 'Hospital sticker' : 'Requisition number'} · viewing is audited{p.sharpness != null && p.sharpness < PHOTO_SHARPNESS_MIN && <span className="ml-1 font-medium text-warn">· may be blurry</span>}</div>
                  </a>
                ))}
              </div>
            )}
          </Card>

          <Card title="Geolocation evidence">
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                ['Arrival', b.arrived_at, b.arrive_distance_m, b.arrive_accuracy_m, b.arrive_override, b.arrive_suspect],
                ['Report filed', b.filed_at, b.file_distance_m, b.file_accuracy_m, b.file_override, b.file_suspect],
              ].map(([label, at, dist, acc, override, suspect]) => (
                <div key={label} className={cx('rounded-lg border p-3 text-sm', override || suspect ? 'border-geo/40 bg-geo-soft/40' : 'border-line')}>
                  <div className="flex items-center gap-1.5 font-medium">{override || suspect ? <MapPinOff size={15} className="text-geo" /> : <MapPin size={15} className="text-ok" />}{label}</div>
                  {at ? (
                    <div className="mt-1 text-muted">
                      <span className="num">{sast(at)}</span>
                      {dist != null && <> · {Math.round(dist)} m from {b.hospital} (fence {b.radius_m} m){acc != null && `, GPS ±${Math.round(acc)} m`}</>}
                      {override && <p className="mt-1 text-geo">Override: {override}</p>}
                      {suspect && <p className="mt-1 font-medium text-geo">Implausible location: {suspect}</p>}
                    </div>
                  ) : <div className="mt-1 text-muted">Not yet</div>}
                </div>
              ))}
            </div>
          </Card>

          {b.siblings.length > 0 && (
            <Card title="Other patients on this request">
              <ul className="flex flex-wrap gap-2">{b.siblings.map((s: any) => <li key={s.id}><Link to={`/bleeds/${s.id}`} className="num rounded-lg border border-line px-2.5 py-1.5 text-sm hover:border-brand">{s.number}</Link></li>)}</ul>
            </Card>
          )}
        </div>

        <Card title="Timeline">
          <ol className="relative space-y-4 border-l border-line pl-4">
            {b.timeline.map((e: any) => (
              <li key={e.id} className="relative text-sm">
                <span className={cx('absolute top-1.5 -left-[21px] h-2.5 w-2.5 rounded-full border-2 border-surface', e.action === 'bleed.escalated' ? 'bg-bad' : e.data?.override ? 'bg-geo' : 'bg-brand')} />
                <div>{(EVENT[e.action] ?? (() => e.action))(e.data)}</div>
                <div className="text-xs text-muted">{e.actor ?? 'System'} · <span className="num">{sast(e.at)}</span></div>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Modal open={modal === 'cancel'} onClose={() => setModal(null)} title="Cancel this bleed">
        <form className="space-y-4" onSubmit={(e) => act.mutate({ path: `/bleeds/${id}/cancel`, body: formValues(e) })}>
          <p className="text-sm text-muted">The ticket closes with your reason. Travel time is kept, and the bleed is excluded from turnaround statistics.</p>
          <Field label="Reason" required><Textarea name="reason" required rows={3} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setModal(null)}>Back</Button><Button variant="danger">Cancel bleed</Button></div>
        </form>
      </Modal>
      <Modal open={modal === 'nurse'} onClose={() => setModal(null)} title="Change nurse">
        <form className="space-y-4" onSubmit={(e) => act.mutate({ path: `/bleed-requests/${b.request_id}/nurse`, body: formValues(e) })}>
          <Field label="Nurse" required><Select name="nurse_id" required>{lk?.users.filter((u) => u.department_id === nurseDept).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
          <Field label="Reason" required><Textarea name="reason" required rows={2} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setModal(null)}>Back</Button><Button>Reassign</Button></div>
        </form>
      </Modal>
    </div>
  );
}
