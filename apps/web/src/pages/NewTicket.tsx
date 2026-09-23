import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, History, Paperclip, Route, TriangleAlert } from 'lucide-react';
import { CHANNELS, COMPLAINANT_TYPES, formatMinutes, PRIORITIES, type ComplainantType, type Priority } from '@baton/core';
import { api, useLookups } from '../api';
import { Badge, Button, Card, cx, ErrorText, Field, Input, Select, Textarea } from '../ui';

export function NewTicket() {
  const { data: lk } = useLookups();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({
    channel: 'telephone', complainant_type: 'doctor' as ComplainantType, complainant_name: '', organisation: '', contact_phone: '', contact_email: '',
    patient_name: '', requisition_no: '', site_id: '', category_id: '', priority: 'normal' as Priority, description: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const { data: matches } = useQuery({
    queryKey: ['complainants', f.complainant_name],
    queryFn: () => api<any[]>(`/complainants?q=${encodeURIComponent(f.complainant_name)}`),
    enabled: f.complainant_name.trim().length >= 3,
    staleTime: 30_000,
  });
  const history = matches?.find((m) => m.name.toLowerCase() === f.complainant_name.trim().toLowerCase());
  const cat = lk?.categories.find((c) => String(c.id) === f.category_id);
  const org = lk?.organisations.find((o) => o.name === f.organisation);
  const limit = cat && cat[`limit_${f.priority}`];
  const repeatsInCat = history && cat ? history.category_ids.filter((x: number) => x === cat.id).length : 0;
  const needsOrg = f.complainant_type !== 'patient' && f.complainant_type !== 'internal';

  const pickComplainant = (m: any) => {
    const o = lk?.organisations.find((x) => x.id === m.organisation_id);
    setF({ ...f, complainant_name: m.name, complainant_type: m.type, organisation: o?.name ?? f.organisation, contact_phone: m.contact_phone ?? '', contact_email: m.contact_email ?? '', site_id: o?.site_id ? String(o.site_id) : f.site_id });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsOrg && !org) throw new Error('Choose the practice / hospital from the list');
      const { organisation, site_id, category_id, ...rest } = f;
      const { id } = await api('/tickets', { body: { ...rest, organisation_id: org?.id ?? null, site_id: +site_id, category_id: +category_id } });
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        await api(`/tickets/${id}/attachments`, { body: fd });
      }
      qc.invalidateQueries({ queryKey: ['tickets'] });
      nav(`/tickets/${id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const depts = cat?.department_ids.map((id) => lk!.departments.find((d) => d.id === id)?.name).filter(Boolean) ?? [];

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New query</h1>
          <p className="mt-0.5 text-sm text-muted">Logged by you now. The ticket number is generated and routing starts the department clocks.</p>
        </div>

        <Card title="Who is querying">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Channel received" required>
              <Select value={f.channel} onChange={set('channel')}>{Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </Field>
            <Field label="Complainant type" required>
              <Select value={f.complainant_type} onChange={set('complainant_type')}>{Object.entries(COMPLAINANT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </Field>
            <Field label="Complainant name" required className="sm:col-span-2">
              <Input value={f.complainant_name} onChange={set('complainant_name')} required autoFocus autoComplete="off" placeholder="Start typing to search previous complainants" />
              {matches && matches.length > 0 && !history && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {matches.map((m) => (
                    <button type="button" key={m.name + m.type} onClick={() => pickComplainant(m)} className="rounded-md border border-line bg-surface-2 px-2 py-1 text-xs hover:border-brand">
                      {m.name} <span className="text-muted">· {m.total} ticket{m.total > 1 && 's'}</span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Practice / hospital" required={needsOrg} className="sm:col-span-2">
              <Input list="orgs" value={f.organisation} onChange={(e) => {
                const o = lk?.organisations.find((x) => x.name === e.target.value);
                setF({ ...f, organisation: e.target.value, site_id: o?.site_id && !f.site_id ? String(o.site_id) : f.site_id });
              }} placeholder="Search practices and hospitals" autoComplete="off" />
              <datalist id="orgs">{lk?.organisations.map((o) => <option key={o.id} value={o.name}>{o.kind === 'hospital' ? 'Hospital' : 'Practice'}</option>)}</datalist>
            </Field>
            <Field label="Contact number" hint="At least one of number or e-mail."><Input type="tel" value={f.contact_phone} onChange={set('contact_phone')} /></Field>
            <Field label="Contact e-mail"><Input type="email" value={f.contact_email} onChange={set('contact_email')} /></Field>
          </div>
        </Card>

        <Card title="What happened">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Query category" required className="sm:col-span-2">
              <Select value={f.category_id} onChange={set('category_id')} required>
                <option value="">Choose a category — this decides routing</option>
                {lk?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Priority" required>
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-surface p-0.5">
                {(Object.keys(PRIORITIES) as Priority[]).map((k) => (
                  <button type="button" key={k} onClick={() => setF({ ...f, priority: k })} className={cx('h-8 rounded-md text-sm', f.priority === k ? (k === 'critical' ? 'bg-bad text-white' : k === 'high' ? 'bg-warn text-white' : 'bg-brand-soft font-medium text-brand') : 'text-muted')}>
                    {PRIORITIES[k]}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Site / branch affected" required>
              <Select value={f.site_id} onChange={set('site_id')} required>
                <option value="">Choose a site</option>
                {lk?.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Patient name" hint="Where applicable"><Input value={f.patient_name} onChange={set('patient_name')} /></Field>
            <Field label="Requisition number" hint="Where applicable"><Input value={f.requisition_no} onChange={set('requisition_no')} className="num" /></Field>
            <Field label="Description" required className="sm:col-span-2">
              <Textarea value={f.description} onChange={set('description')} required rows={5} placeholder="What the complainant said, in their words." />
            </Field>
            <Field label="Attachments" className="sm:col-span-2" hint="Images, PDF or documents. Stored encrypted.">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted hover:border-brand">
                <Paperclip size={16} />
                {files.length ? files.map((x) => x.name).join(', ') : 'Choose files'}
                <input type="file" multiple className="hidden" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
              </label>
            </Field>
          </div>
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Card title={<span className="flex items-center gap-2"><Route size={16} className="text-brand" />Routing preview</span>}>
          {cat ? (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted">Routes to</span>
                {depts.map((d) => <Badge key={d} tone="brand">{d}</Badge>)}
              </div>
              <div className="rounded-lg bg-surface-2 p-3">
                <div className="num text-2xl font-semibold">{formatMinutes(limit!)}</div>
                <div className="text-xs text-muted">{cat.clock === 'business' ? 'working time (SAST, site hours, public holidays excluded)' : '24/7 wall-clock'} · {PRIORITIES[f.priority]} priority</div>
              </div>
              {depts.length > 1 && <p className="text-xs text-muted">Each department gets its own clock and must respond independently.</p>}
            </div>
          ) : (
            <p className="text-sm text-muted">Pick a category to see where this goes and how long each department has.</p>
          )}
        </Card>

        {history && (
          <Card title={<span className="flex items-center gap-2"><History size={16} className="text-brand" />Complainant history</span>}>
            <dl className="grid grid-cols-3 gap-2 text-center">
              {[['Total', history.total], ['90 days', history.recent], ['Open', history.open]].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-surface-2 py-2"><dd className="num text-xl font-semibold">{v}</dd><dt className="text-[11px] text-muted">{k}</dt></div>
              ))}
            </dl>
            {!f.contact_phone && !f.contact_email && (
              <Button type="button" variant="outline" size="sm" className="mt-3 w-full" onClick={() => pickComplainant(history)}>Use last contact details</Button>
            )}
            {repeatsInCat > 0 && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-warn-soft p-2.5 text-xs text-warn">
                <TriangleAlert size={15} className="mt-px shrink-0" />
                Repeat: {repeatsInCat} previous ticket{repeatsInCat > 1 && 's'} in this category. The same failure may be recurring.
              </p>
            )}
          </Card>
        )}

        <ErrorText error={error} />
        <Button className="h-11 w-full" disabled={busy}>{busy ? 'Logging…' : <>Log and route <ArrowRight size={16} /></>}</Button>
      </aside>
    </form>
  );
}
