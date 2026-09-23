import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CircleDashed, FileText, Lock, Paperclip, Phone, RotateCcw, Shuffle, Undo2, X } from 'lucide-react';
import {
  ASSIGNMENT_STATES, CHANNELS, CLOSURE_REASONS, closureChecklist, COMPLAINANT_TYPES, formatMinutes, PRIORITIES, QUERY_STATES, ROOT_CAUSES, sast,
  type QueryState,
} from '@baton/core';
import { api, formValues, useLookups, useMe } from '../api';
import { Badge, Button, Card, cx, DeptClock, ErrorText, Field, FlagPill, Input, Modal, PRIORITY_TONE, Select, StatePill, Textarea } from '../ui';

const STEPS = Object.keys(QUERY_STATES) as QueryState[];

const EVENT: Record<string, (d: any) => string> = {
  created: () => 'Logged the query',
  routed: (d) => `Routed to ${d.departments?.join(' + ')} · ${formatMinutes(d.limit_minutes)} ${d.clock === 'business' ? 'working' : 'wall-clock'}`,
  acknowledged: (d) => `${d.department} acknowledged`,
  responded: (d) => `${d.department} submitted findings${d.breach_reason ? ` · breach: ${d.breach_reason}` : ''}`,
  returned: (d) => `Returned to ${d.department}: ${d.reason}`,
  accepted: (d) => `Accepted ${d.department}'s response`,
  assigned_user: (d) => `Assigned ${d.department} to ${d.user}`,
  state: (d) => `${QUERY_STATES[d.from as QueryState] ?? d.from} → ${QUERY_STATES[d.to as QueryState] ?? d.to}`,
  call_logged: (d) => `Called ${d.spoken_to} · ${d.satisfied ? 'satisfied' : 'not satisfied'}`,
  not_satisfied: (d) => `Client not satisfied — reopened ${d.departments?.join(', ')}`,
  reopened: (d) => `Reopened: ${d.reason}`,
  reassigned: (d) => `Reassigned ${d.from} → ${d.to}: ${d.reason}`,
  reprioritised: (d) => `Priority ${d.from} → ${d.to}: ${d.reason}`,
  escalated: (d) => `${['', 'Amber', 'Red breach', 'Escalated to management'][d.level]} · ${d.department} at ${d.pct}%`,
  note: () => 'Added a note',
  attachment_added: (d) => `Attached ${d.filename}`,
};

function useAct(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: object) => api(`/tickets/${id}/actions`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ticket', id] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

function Stepper({ state, cycle }: { state: QueryState; cycle: number }) {
  const cur = STEPS.indexOf(state);
  return (
    <ol className="flex overflow-x-auto rounded-xl border border-line bg-surface p-1.5">
      {STEPS.map((s, i) => (
        <li key={s} className={cx('flex min-w-[118px] flex-1 items-center gap-2 rounded-lg px-3 py-2 text-xs', i === cur && 'bg-brand-soft font-semibold text-brand', i < cur && 'text-text', i > cur && 'text-muted')}>
          <span className={cx('grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px]', i < cur ? 'bg-ok text-white' : i === cur ? 'bg-brand text-brand-ink' : 'border border-line')}>
            {i < cur ? <Check size={12} strokeWidth={3} /> : i + 1}
          </span>
          {QUERY_STATES[s]}
        </li>
      ))}
      {cycle > 0 && <li className="flex items-center px-3 text-xs text-muted"><RotateCcw size={13} className="mr-1" />cycle {cycle + 1}</li>}
    </ol>
  );
}

function Assignment({ t, a, act }: { t: any; a: any; act: ReturnType<typeof useAct> }) {
  const { data: lk } = useLookups();
  const [responding, setResponding] = useState(false);
  const [returning, setReturning] = useState(false);
  const running = ['assigned', 'in_progress'].includes(a.state);
  const breached = a.sla.pct >= (lk?.thresholds?.[1] ?? 100);
  const people = lk?.users.filter((u) => u.department_id === a.department_id) ?? [];

  return (
    <div className={cx('rounded-xl border p-4', running && a.sla.flag === 'red' ? 'border-bad/50 bg-bad-soft/20' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-3">
        <DeptClock a={a} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{a.department}</span>
            <Badge tone={a.state === 'accepted' ? 'green' : a.state === 'responded' ? 'brand' : 'neutral'}>{ASSIGNMENT_STATES[a.state as keyof typeof ASSIGNMENT_STATES]}</Badge>
            {running && <FlagPill flag={a.sla.flag} />}
            {a.breach_reason && <Badge tone="red">Breach recorded</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {a.assignee ? `Owner: ${a.assignee}` : 'Unassigned'} ·{' '}
            {running
              ? a.sla.remaining >= 0 ? `${formatMinutes(a.sla.remaining)} left of ${formatMinutes(a.limit_minutes)}` : `${formatMinutes(-a.sla.remaining)} over ${formatMinutes(a.limit_minutes)} limit`
              : `responded in ${formatMinutes(a.sla.used)} of ${formatMinutes(a.limit_minutes)}`}
            {running && <> · due <span className="num">{sast(a.due_at)}</span></>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {a.actions.includes('assign_user') && (
            <Select className="h-8 w-40 text-[13px]" value={a.assignee_id ?? ''} onChange={(e) => e.target.value && act.mutate({ action: 'assign_user', assignment_id: a.id, user_id: e.target.value })}>
              <option value="">Assign to…</option>
              {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          )}
          {a.actions.includes('acknowledge') && <Button size="sm" onClick={() => act.mutate({ action: 'acknowledge', assignment_id: a.id })}>Acknowledge</Button>}
          {a.actions.includes('respond') && !responding && <Button size="sm" onClick={() => setResponding(true)}>Submit response</Button>}
          {a.actions.includes('return') && <Button size="sm" variant="outline" onClick={() => setReturning(true)}><Undo2 size={14} />Return</Button>}
          {a.actions.includes('accept') && <Button size="sm" onClick={() => act.mutate({ action: 'accept', assignment_id: a.id })}><Check size={14} />Accept</Button>}
        </div>
      </div>

      {(a.findings || a.breach_reason) && !responding && (
        <dl className="mt-3 grid gap-3 border-t border-line pt-3 text-sm sm:grid-cols-2">
          {a.findings && <div><dt className="text-xs font-medium text-muted">Findings</dt><dd className="mt-0.5 whitespace-pre-wrap">{a.findings}</dd></div>}
          {a.corrective_action && <div><dt className="text-xs font-medium text-muted">Corrective action</dt><dd className="mt-0.5 whitespace-pre-wrap">{a.corrective_action}</dd></div>}
          {a.breach_reason && <div className="sm:col-span-2"><dt className="text-xs font-medium text-bad">Breach reason</dt><dd className="mt-0.5">{a.breach_reason}</dd></div>}
        </dl>
      )}

      {responding && (
        <form
          className="mt-4 grid gap-3 border-t border-line pt-4"
          onSubmit={(e) => act.mutate({ action: 'respond', assignment_id: a.id, ...formValues(e) }, { onSuccess: () => setResponding(false) })}
        >
          <Field label="Findings" required><Textarea name="findings" required defaultValue={a.findings ?? ''} /></Field>
          <Field label="Corrective action" required><Textarea name="corrective_action" required rows={3} defaultValue={a.corrective_action ?? ''} /></Field>
          {breached && (
            <Field label="Breach reason" required hint="The time limit has passed. Say why, so it can be reported.">
              <Input name="breach_reason" required defaultValue={a.breach_reason ?? ''} />
            </Field>
          )}
          <div className="flex gap-2">
            <Button disabled={act.isPending}>Return to Client Services</Button>
            <Button type="button" variant="ghost" onClick={() => setResponding(false)}>Cancel</Button>
          </div>
        </form>
      )}

      <Modal open={returning} onClose={() => setReturning(false)} title={`Return to ${a.department}`}>
        <form className="space-y-4" onSubmit={(e) => act.mutate({ action: 'return', assignment_id: a.id, ...formValues(e) }, { onSuccess: () => setReturning(false) })}>
          <Field label="Why is the response inadequate?" required><Textarea name="reason" required /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setReturning(false)}>Cancel</Button><Button>Return</Button></div>
        </form>
      </Modal>
    </div>
  );
}

function ClosureGate({ t, act }: { t: any; act: ReturnType<typeof useAct> }) {
  const [reason, setReason] = useState('');
  const [root, setRoot] = useState('');
  const [satisfied, setSatisfied] = useState<boolean | null>(null);
  const [reopening, setReopening] = useState(false);
  const accepted = t.assignments.filter((a: any) => a.state === 'accepted');
  const items = closureChecklist({ state: t.state, assignments: t.assignments, calls: t.calls, cycle: t.cycle, closure_reason: reason, root_cause: root });
  const canClose = t.actions.includes('close');

  if (t.state === 'closed')
    return (
      <Card title={<span className="flex items-center gap-2"><Lock size={15} className="text-ok" />Closed</span>}>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between"><dt className="text-muted">Reason</dt><dd>{CLOSURE_REASONS[t.closure_reason as keyof typeof CLOSURE_REASONS]}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">Root cause</dt><dd>{ROOT_CAUSES[t.root_cause as keyof typeof ROOT_CAUSES]}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">Closed</dt><dd className="num">{sast(t.closed_at)}</dd></div>
        </dl>
        {t.actions.includes('reopen') && <Button variant="outline" className="mt-4 w-full" onClick={() => setReopening(true)}><RotateCcw size={15} />Reopen</Button>}
        <Modal open={reopening} onClose={() => setReopening(false)} title="Reopen ticket">
          <form className="space-y-4" onSubmit={(e) => {
            const fd = new FormData(e.currentTarget);
            e.preventDefault();
            act.mutate({ action: 'reopen', reason: fd.get('reason'), department_ids: fd.getAll('dept').map(Number) }, { onSuccess: () => setReopening(false) });
          }}>
            <Field label="Reason" required><Textarea name="reason" required /></Field>
            <DeptPicks list={accepted} />
            <ErrorText error={act.error} />
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setReopening(false)}>Cancel</Button><Button>Reopen</Button></div>
          </form>
        </Modal>
      </Card>
    );

  return (
    <Card title="Closure gate">
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-2 text-sm">
            {i.ok ? <span className="grid h-5 w-5 place-items-center rounded-full bg-ok text-white"><Check size={12} strokeWidth={3} /></span> : <CircleDashed size={20} className="text-muted" />}
            <span className={i.ok ? '' : 'text-muted'}>{i.label}</span>
          </li>
        ))}
      </ul>

      {t.actions.includes('log_call') && (
        <form
          className="mt-5 space-y-3 border-t border-line pt-4"
          onSubmit={(e) => {
            const fd = new FormData(e.currentTarget);
            e.preventDefault();
            act.mutate(
              { action: 'log_call', called_at: new Date(String(fd.get('called_at'))).toISOString(), spoken_to: fd.get('spoken_to'), number_used: fd.get('number_used'), summary: fd.get('summary'), satisfied, reopen_department_ids: fd.getAll('dept').map(Number) },
              { onSuccess: () => setSatisfied(null) },
            );
          }}
        >
          <div className="flex items-center gap-2 text-sm font-semibold"><Phone size={15} className="text-brand" />Verification call</div>
          <Field label="Called at" required><Input name="called_at" type="datetime-local" required defaultValue={localNow()} /></Field>
          <Field label="Spoke to" required><Input name="spoken_to" required defaultValue={t.complainant_name} /></Field>
          <Field label="Number used" required><Input name="number_used" required defaultValue={t.contact_phone ?? ''} /></Field>
          <Field label="What was said" required><Textarea name="summary" required rows={3} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setSatisfied(true)} className={cx('h-10 rounded-lg border text-sm font-medium', satisfied === true ? 'border-ok bg-ok-soft text-ok' : 'border-line')}>Satisfied</button>
            <button type="button" onClick={() => setSatisfied(false)} className={cx('h-10 rounded-lg border text-sm font-medium', satisfied === false ? 'border-bad bg-bad-soft text-bad' : 'border-line')}>Not satisfied</button>
          </div>
          {satisfied === false && (
            <>
              <p className="text-xs text-muted">Closure stays blocked. The ticket returns to In Progress for:</p>
              <DeptPicks list={accepted} />
            </>
          )}
          <Button className="w-full" disabled={satisfied === null || act.isPending}>Record call</Button>
        </form>
      )}

      {canClose && (
        <div className="mt-5 space-y-3 border-t border-line pt-4">
          <Field label="Closure reason" required>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Choose…</option>{Object.entries(CLOSURE_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Field label="Root cause" required hint="Feeds quality indicator reporting.">
            <Select value={root} onChange={(e) => setRoot(e.target.value)}><option value="">Choose…</option>{Object.entries(ROOT_CAUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Button className="w-full" disabled={!items.every((i) => i.ok) || act.isPending} onClick={() => act.mutate({ action: 'close', closure_reason: reason, root_cause: root })}>
            <Lock size={15} />Close ticket
          </Button>
        </div>
      )}
      {!canClose && !t.actions.includes('log_call') && (
        <p className="mt-4 text-xs text-muted">Close unlocks after every department's response is accepted and the client confirms they are satisfied.</p>
      )}
    </Card>
  );
}

const DeptPicks = ({ list }: { list: any[] }) => (
  <div className="flex flex-wrap gap-2">
    {list.map((a) => (
      <label key={a.id} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm">
        <input type="checkbox" name="dept" value={a.department_id} defaultChecked className="accent-[var(--brand)]" />{a.department}
      </label>
    ))}
  </div>
);

const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function Ticket() {
  const { id } = useParams() as { id: string };
  const { data: me } = useMe();
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const { data: t, error, isLoading } = useQuery({ queryKey: ['ticket', id], queryFn: () => api(`/tickets/${id}`), refetchInterval: 60_000 });
  const act = useAct(id);
  const [modal, setModal] = useState<'reassign' | 'reprioritise' | null>(null);
  const [upErr, setUpErr] = useState<unknown>(null);
  const addNote = useNoteMutation(id, qc);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-surface-2" />;
  if (error || !t) return <ErrorText error={error ?? new Error('Not found')} />;

  const upload = async (files: FileList | null) => {
    setUpErr(null);
    try {
      for (const file of files ?? []) {
        const fd = new FormData();
        fd.append('file', file);
        await api(`/tickets/${id}/attachments`, { body: fd });
      }
      qc.invalidateQueries({ queryKey: ['ticket', id] });
    } catch (e) { setUpErr(e); }
  };
  const readOnly = me?.role === 'management';
  const running = t.assignments.filter((a: any) => ['assigned', 'in_progress', 'responded'].includes(a.state));

  return (
    <div className="space-y-5">
      <Link to="/tickets" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft size={15} />Back</Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="num text-2xl font-semibold tracking-tight">{t.number}</h1>
            <StatePill state={t.state} />
            <Badge tone={PRIORITY_TONE[t.priority as keyof typeof PRIORITY_TONE]}>{PRIORITIES[t.priority as keyof typeof PRIORITIES]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">{t.category} · {t.site}{t.organisation && ` · ${t.organisation}`}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {t.actions.includes('review') && <Button onClick={() => act.mutate({ action: 'review' })}>Start review</Button>}
          {t.actions.includes('reassign') && running.length > 0 && <Button variant="outline" onClick={() => setModal('reassign')}><Shuffle size={15} />Reassign</Button>}
          {t.actions.includes('reprioritise') && <Button variant="outline" onClick={() => setModal('reprioritise')}>Change priority</Button>}
        </div>
      </div>

      <Stepper state={t.state} cycle={t.cycle} />
      {act.error && <ErrorText error={act.error} />}

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <Card title="Departments">
            <div className="space-y-3">
              {t.assignments.filter((a: any) => a.state !== 'cancelled').map((a: any) => <Assignment key={a.id} t={t} a={a} act={act} />)}
            </div>
          </Card>

          <Card title="Query">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              {[
                ['Complainant', `${t.complainant_name} (${COMPLAINANT_TYPES[t.complainant_type as keyof typeof COMPLAINANT_TYPES]})`],
                ['Practice / hospital', t.organisation ?? '—'],
                ['Channel', CHANNELS[t.channel as keyof typeof CHANNELS]],
                ['Contact', [t.contact_phone, t.contact_email].filter(Boolean).join(' · ')],
                ['Patient', t.patient_name ?? '—'],
                ['Requisition', t.requisition_no ?? '—'],
                ['Received', sast(t.created_at)],
                ['Logged by', t.logged_by_name],
                ['Clock', t.clock === 'business' ? 'Working hours (SAST)' : '24/7'],
              ].map(([k, v]) => (
                <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className={cx('mt-0.5', (k === 'Requisition' || k === 'Received') && 'num')}>{v}</dd></div>
              ))}
            </dl>
            <p className="mt-4 rounded-lg bg-surface-2 p-3 text-sm whitespace-pre-wrap">{t.description}</p>
          </Card>

          {t.calls.length > 0 && (
            <Card title="Verification calls">
              <ul className="space-y-3">
                {t.calls.map((c: any) => (
                  <li key={c.id} className="flex gap-3 text-sm">
                    <span className={cx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full', c.satisfied ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad')}>{c.satisfied ? <Check size={13} /> : <X size={13} />}</span>
                    <div>
                      <div className="font-medium">{c.spoken_to} · <span className="num font-normal text-muted">{c.number_used}</span></div>
                      <div className="text-xs text-muted"><span className="num">{sast(c.called_at)}</span> · by {c.recorded_by_name}</div>
                      <p className="mt-1 whitespace-pre-wrap">{c.summary}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Notes & attachments">
            <div className="space-y-3">
              {t.notes.map((n: any) => (
                <div key={n.id} className="rounded-lg bg-surface-2 p-3 text-sm">
                  <div className="text-xs text-muted">{n.author} · <span className="num">{sast(n.created_at)}</span></div>
                  <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
                </div>
              ))}
              {t.attachments.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {t.attachments.map((f: any) => (
                    <li key={f.id}>
                      <a href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm hover:border-brand">
                        <FileText size={14} />{f.filename}<span className="text-xs text-muted">{Math.ceil(f.size / 1024)} KB</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {!readOnly && t.state !== 'closed' && (
                <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { const v = formValues(e); (e.currentTarget as HTMLFormElement).reset(); addNote.mutate(v.body); }}>
                  <Input name="body" placeholder="Add a note…" required />
                  <div className="flex gap-2">
                    <Button variant="outline">Add note</Button>
                    <label className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 text-sm hover:bg-surface-2">
                      <Paperclip size={15} />Attach<input type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
                    </label>
                  </div>
                </form>
              )}
              <ErrorText error={upErr ?? addNote.error} />
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <ClosureGate t={t} act={act} />
          <Card title="Timeline">
            <ol className="relative space-y-4 border-l border-line pl-4">
              {t.timeline.map((e: any) => (
                <li key={e.id} className="relative text-sm">
                  <span className={cx('absolute top-1.5 -left-[21px] h-2.5 w-2.5 rounded-full border-2 border-surface', e.action === 'escalated' ? 'bg-bad' : e.action === 'state' ? 'bg-brand' : 'bg-line')} />
                  <div>{(EVENT[e.action] ?? (() => e.action))(e.data)}</div>
                  <div className="text-xs text-muted">{e.actor ?? 'System'} · <span className="num">{sast(e.at)}</span></div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <Modal open={modal === 'reassign'} onClose={() => setModal(null)} title="Reassign department">
        <form className="space-y-4" onSubmit={(e) => { const v = formValues(e); act.mutate({ action: 'reassign', assignment_id: v.assignment_id, department_id: +v.department_id, reason: v.reason }, { onSuccess: () => setModal(null) }); }}>
          <Field label="From" required><Select name="assignment_id" required>{running.map((a: any) => <option key={a.id} value={a.id}>{a.department}</option>)}</Select></Field>
          <Field label="To" required>
            <Select name="department_id" required>
              {lk?.departments.filter((d) => !t.assignments.some((a: any) => a.department_id === d.id && a.state !== 'cancelled')).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="Reason" required hint="Recorded in the audit trail."><Textarea name="reason" required rows={3} /></Field>
          <ErrorText error={act.error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setModal(null)}>Cancel</Button><Button>Reassign</Button></div>
        </form>
      </Modal>

      <Modal open={modal === 'reprioritise'} onClose={() => setModal(null)} title="Change priority">
        <form className="space-y-4" onSubmit={(e) => { const v = formValues(e); act.mutate({ action: 'reprioritise', ...v }, { onSuccess: () => setModal(null) }); }}>
          <Field label="Priority" required><Select name="priority" defaultValue={t.priority}>{Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Reason" required><Textarea name="reason" required rows={3} /></Field>
          <p className="text-xs text-muted">Open department clocks are recalculated against the new limit.</p>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setModal(null)}>Cancel</Button><Button>Save</Button></div>
        </form>
      </Modal>
    </div>
  );
}

function useNoteMutation(id: string, qc: ReturnType<typeof useQueryClient>) {
  return useMutation({
    mutationFn: (body: string) => api(`/tickets/${id}/notes`, { body: { body } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ticket', id] }),
  });
}
