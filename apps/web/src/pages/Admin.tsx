import { useState, type ReactNode } from 'react';
import { NavLink, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { formatMinutes, ROLES, sast } from '@baton/core';
import { api, useLookups, type Lookups } from '../api';
import { Badge, Button, Card, cx, ErrorText, Field, Input, Modal, Select, Textarea } from '../ui';

type Opt = [string | number, string][];
type Col = {
  key: string;
  label: string;
  type?: 'text' | 'email' | 'number' | 'bool' | 'select' | 'multi' | 'hours' | 'json' | 'date' | 'password' | 'minutes';
  options?: (lk: Lookups) => Opt;
  list?: boolean; // show in table
  required?: boolean;
  createOnly?: boolean;
  hint?: string;
};
type Spec = { res: string; label: string; pk?: string; del?: boolean; cols: Col[]; blank: Record<string, unknown>; intro: string };

const depts = (lk: Lookups): Opt => lk.departments.map((d) => [d.id, d.name]);
const sites = (lk: Lookups): Opt => lk.sites.map((s) => [s.id, s.name]);
const roles = (): Opt => Object.entries(ROLES);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SPECS: Spec[] = [
  {
    res: 'users', label: 'Users', intro: 'Local accounts sign in with a Baton password. AD accounts are created automatically on first sign-in from the AD group mapping.',
    blank: { auth: 'local', role: 'cs_agent', active: true },
    cols: [
      { key: 'name', label: 'Name', list: true, required: true },
      { key: 'email', label: 'E-mail', type: 'email', list: true, required: true },
      { key: 'role', label: 'Role', type: 'select', options: roles, list: true, required: true },
      { key: 'department_id', label: 'Department', type: 'select', options: depts, list: true, hint: 'Required for department roles. Client Services staff belong to Client Services.' },
      { key: 'site_id', label: 'Site', type: 'select', options: sites },
      { key: 'auth', label: 'Sign-in', type: 'select', options: () => [['local', 'Local'], ['ad', 'Active Directory']], list: true },
      { key: 'password', label: 'Set password', type: 'password', hint: 'Min 10 characters. Leave blank to keep. Local accounts only.' },
      { key: 'active', label: 'Active', type: 'bool', list: true },
    ],
  },
  {
    res: 'categories', label: 'Categories & routing', intro: 'The category chosen at intake decides which departments get the ticket and how long each has. Limits are in minutes of working time (or 24/7 time).',
    blank: { clock: 'business', limit_critical: 120, limit_high: 240, limit_normal: 480, active: true, department_ids: [] },
    cols: [
      { key: 'name', label: 'Category', list: true, required: true },
      { key: 'department_ids', label: 'Routes to', type: 'multi', options: depts, list: true, required: true },
      { key: 'clock', label: 'Clock', type: 'select', options: () => [['business', 'Working hours'], ['wall', '24/7']], list: true },
      { key: 'limit_critical', label: 'Critical limit', type: 'minutes', list: true },
      { key: 'limit_high', label: 'High limit', type: 'minutes', list: true },
      { key: 'limit_normal', label: 'Normal limit', type: 'minutes', list: true },
      { key: 'active', label: 'Active', type: 'bool', list: true },
    ],
  },
  { res: 'departments', label: 'Departments', intro: 'Departments receive routed tickets.', blank: { active: true }, cols: [
    { key: 'code', label: 'Code', list: true, required: true }, { key: 'name', label: 'Name', list: true, required: true }, { key: 'active', label: 'Active', type: 'bool', list: true },
  ] },
  { res: 'sites', label: 'Sites & hours', intro: 'JDJ sites and depots. Working hours (SAST) drive working-time clocks.', blank: { active: true, hours: [null, [480, 1020], [480, 1020], [480, 1020], [480, 1020], [480, 1020], null] }, cols: [
    { key: 'code', label: 'Code', list: true, required: true }, { key: 'name', label: 'Name', list: true, required: true }, { key: 'region', label: 'Region', list: true },
    { key: 'hours', label: 'Working hours', type: 'hours', list: true }, { key: 'active', label: 'Active', type: 'bool', list: true },
  ] },
  { res: 'organisations', label: 'Practices & hospitals', intro: 'The client register. Hospitals carry GPS coordinates and a geofence radius for bleed tickets.', blank: { kind: 'practice', active: true, radius_m: 250 }, cols: [
    { key: 'name', label: 'Name', list: true, required: true },
    { key: 'kind', label: 'Type', type: 'select', options: () => [['practice', 'Practice'], ['hospital', 'Hospital']], list: true },
    { key: 'site_id', label: 'Site', type: 'select', options: sites, list: true },
    { key: 'address', label: 'Address' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'E-mail', type: 'email' },
    { key: 'lat', label: 'Latitude', type: 'number' }, { key: 'lng', label: 'Longitude', type: 'number' },
    { key: 'radius_m', label: 'Geofence radius (m)', type: 'number', list: true }, { key: 'active', label: 'Active', type: 'bool', list: true },
  ] },
  { res: 'holidays', label: 'Public holidays', pk: 'day', del: true, intro: 'Excluded from working-time clocks.', blank: {}, cols: [
    { key: 'day', label: 'Date', type: 'date', list: true, required: true, createOnly: true }, { key: 'name', label: 'Name', list: true, required: true },
  ] },
  { res: 'ad_groups', label: 'AD group mapping', del: true, intro: 'Members of these AD security groups can sign in with their network login. The first match by priority sets role and department.', blank: { priority: 100, role: 'dept_responder' }, cols: [
    { key: 'group_dn', label: 'Group DN', list: true, required: true, hint: 'e.g. CN=Baton-Analytical,OU=Groups,DC=jdj,DC=local' },
    { key: 'role', label: 'Role', type: 'select', options: roles, list: true, required: true },
    { key: 'department_id', label: 'Department', type: 'select', options: depts, list: true },
    { key: 'priority', label: 'Priority', type: 'number', list: true },
  ] },
  { res: 'settings', label: 'Settings', pk: 'key', intro: 'escalation_thresholds: % of time limit for amber, red and management escalation. mfa_enforced_roles: roles that must use two-factor sign-in.', blank: {}, cols: [
    { key: 'key', label: 'Key', list: true, required: true, createOnly: true }, { key: 'value', label: 'Value (JSON)', type: 'json', list: true, required: true },
  ] },
];

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function show(c: Col, v: any, lk: Lookups): ReactNode {
  if (v == null || v === '') return <span className="text-muted">—</span>;
  if (c.type === 'bool') return v ? <Badge tone="green">Yes</Badge> : <Badge>No</Badge>;
  if (c.type === 'select') return c.options?.(lk).find(([k]) => String(k) === String(v))?.[1] ?? String(v);
  if (c.type === 'multi') return <span className="flex flex-wrap gap-1">{(v as number[]).map((x) => <Badge key={x} tone="brand">{lk.departments.find((d) => d.id === x)?.code ?? x}</Badge>)}</span>;
  if (c.type === 'minutes') return <span className="num">{formatMinutes(v)}</span>;
  if (c.type === 'hours') return <span className="text-xs">{(v as any[]).map((d, i) => d && `${DAYS[i]} ${hm(d[0])}–${hm(d[1])}`).filter(Boolean).slice(0, 1).join('')}{(v as any[]).filter(Boolean).length > 1 && ` +${(v as any[]).filter(Boolean).length - 1} days`}</span>;
  if (c.type === 'json') return <code className="num text-xs">{JSON.stringify(v)}</code>;
  if (c.type === 'date') return <span className="num">{String(v).slice(0, 10)}</span>;
  return String(v);
}

function Editor({ c, value, onChange, lk, isNew }: { c: Col; value: any; onChange: (v: any) => void; lk: Lookups; isNew: boolean }) {
  if (c.createOnly && !isNew) return <Input value={String(value ?? '').slice(0, 10)} disabled />;
  switch (c.type) {
    case 'bool':
      return <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" />Enabled</label>;
    case 'select':
      return <Select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : isNaN(+e.target.value) ? e.target.value : +e.target.value)} required={c.required}><option value="">—</option>{c.options!(lk).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>;
    case 'multi':
      return (
        <div className="flex flex-wrap gap-2">
          {c.options!(lk).map(([k, l]) => {
            const on = (value ?? []).includes(k);
            return <button type="button" key={k} onClick={() => onChange(on ? value.filter((x: any) => x !== k) : [...(value ?? []), k])} className={cx('rounded-lg border px-2.5 py-1.5 text-sm', on ? 'border-brand bg-brand-soft text-brand' : 'border-line')}>{l}</button>;
          })}
        </div>
      );
    case 'minutes':
      return <div className="flex items-center gap-2"><Input type="number" min={1} value={value ?? ''} onChange={(e) => onChange(+e.target.value)} className="num" /><span className="w-20 shrink-0 text-xs text-muted">{value ? formatMinutes(value) : ''}</span></div>;
    case 'hours':
      return (
        <div className="space-y-1.5">
          {DAYS.map((d, i) => {
            const day = value?.[i] as [number, number] | null;
            const put = (x: [number, number] | null) => onChange(Object.assign([...(value ?? Array(7).fill(null))], { [i]: x }));
            return (
              <div key={d} className="flex items-center gap-2 text-sm">
                <label className="flex w-20 items-center gap-2"><input type="checkbox" checked={!!day} onChange={(e) => put(e.target.checked ? [480, 1020] : null)} className="accent-[var(--brand)]" />{d}</label>
                {day ? (
                  <>
                    <Input type="time" value={hm(day[0])} onChange={(e) => put([toMin(e.target.value), day[1]])} className="h-8 w-28" />
                    <span className="text-muted">to</span>
                    <Input type="time" value={hm(day[1])} onChange={(e) => put([day[0], toMin(e.target.value)])} className="h-8 w-28" />
                  </>
                ) : <span className="text-muted">Closed</span>}
              </div>
            );
          })}
        </div>
      );
    case 'json':
      return <Textarea className="num" rows={3} defaultValue={JSON.stringify(value ?? null)} onChange={(e) => { try { onChange(JSON.parse(e.target.value)); } catch {} }} />;
    case 'number':
      return <Input type="number" step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : +e.target.value)} />;
    default:
      return <Input type={c.type ?? 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} required={c.required && c.type !== 'password'} autoComplete={c.type === 'password' ? 'new-password' : undefined} />;
  }
}

function Resource({ spec, lk }: { spec: Spec; lk: Lookups }) {
  const qc = useQueryClient();
  const pk = spec.pk ?? 'id';
  const { data, isLoading } = useQuery({ queryKey: ['admin', spec.res], queryFn: () => api<any[]>(`/admin/${spec.res}`) });
  const [edit, setEdit] = useState<{ row: any; isNew: boolean } | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ['admin', spec.res] }); qc.invalidateQueries({ queryKey: ['lookups'] }); setEdit(null); };
  const save = useMutation({
    mutationFn: ({ row, isNew }: { row: any; isNew: boolean }) =>
      api(isNew ? `/admin/${spec.res}` : `/admin/${spec.res}/${encodeURIComponent(String(row[pk]).slice(0, spec.res === 'holidays' ? 10 : undefined))}`, { method: isNew ? 'POST' : 'PUT', body: row }),
    onSuccess: done,
  });
  const del = useMutation({ mutationFn: (row: any) => api(`/admin/${spec.res}/${encodeURIComponent(String(row[pk]).slice(0, 10))}`, { method: 'DELETE' }), onSuccess: done });
  const cols = spec.cols.filter((c) => c.list);

  return (
    <Card title={spec.label} action={<Button size="sm" onClick={() => { save.reset(); setEdit({ row: { ...spec.blank }, isNew: true }); }}><Plus size={15} />Add</Button>}>
      <p className="-mt-1 mb-4 text-sm text-muted">{spec.intro}</p>
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-y border-line bg-surface-2/60 text-left text-xs text-muted">
            <tr>{cols.map((c) => <th key={c.key} className="px-5 py-2 font-medium">{c.label}</th>)}{spec.res === 'users' && <th className="px-5 py-2 font-medium">2FA</th>}<th /></tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r[pk]} className="border-b border-line last:border-0">
                {cols.map((c) => <td key={c.key} className="px-5 py-2.5">{show(c, r[c.key], lk)}</td>)}
                {spec.res === 'users' && <td className="px-5 py-2.5">{r.mfa_enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}{r.locked_until && new Date(r.locked_until) > new Date() && <Badge tone="red">Locked</Badge>}</td>}
                <td className="px-5 py-2.5 text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => { save.reset(); setEdit({ row: { ...r }, isNew: false }); }}><Pencil size={14} /></Button>
                  {spec.del && <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => confirm('Delete this row?') && del.mutate(r)}><Trash2 size={14} /></Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {isLoading && <p className="p-5 text-sm text-muted">Loading…</p>}
      </div>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={`${edit?.isNew ? 'Add' : 'Edit'} ${spec.label.toLowerCase()}`} wide>
        {edit && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(edit); }}>
            <div className="grid gap-4 sm:grid-cols-2">
              {spec.cols.map((c) => (
                <Field key={c.key} label={c.label} required={c.required} hint={c.hint} className={cx((c.type === 'multi' || c.type === 'hours' || c.type === 'json') && 'sm:col-span-2')}>
                  <Editor c={c} lk={lk} isNew={edit.isNew} value={edit.row[c.key]} onChange={(v) => setEdit({ ...edit, row: { ...edit.row, [c.key]: v } })} />
                </Field>
              ))}
            </div>
            {spec.res === 'users' && !edit.isNew && (
              <div className="flex flex-wrap gap-4 rounded-lg bg-surface-2 p-3 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" onChange={(e) => setEdit({ ...edit, row: { ...edit.row, reset_mfa: e.target.checked } })} className="accent-[var(--brand)]" />Reset two-factor</label>
                <label className="flex items-center gap-2"><input type="checkbox" onChange={(e) => setEdit({ ...edit, row: { ...edit.row, unlock: e.target.checked } })} className="accent-[var(--brand)]" />Unlock account</label>
              </div>
            )}
            <ErrorText error={save.error} />
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={save.isPending}>Save</Button></div>
          </form>
        )}
      </Modal>
    </Card>
  );
}

function Audit() {
  const { data } = useQuery({ queryKey: ['admin-audit'], queryFn: () => api('/admin-audit') });
  return (
    <Card title="Audit trail">
      {data && (
        <div className={cx('mb-4 flex items-center gap-2 rounded-lg p-3 text-sm', data.intact ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad')}>
          {data.intact ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
          {data.intact ? 'Hash chain verified — no entry has been altered or removed.' : `Chain broken at entry #${data.broken_at}. Investigate immediately.`}
        </div>
      )}
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-y border-line bg-surface-2/60 text-left text-xs text-muted"><tr>{['#', 'When (SAST)', 'Who', 'Action', 'Entity', 'IP', 'Hash'].map((h) => <th key={h} className="px-5 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {data?.rows.map((r: any) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="num px-5 py-2 text-muted">{r.id}</td>
                <td className="num px-5 py-2">{sast(r.at)}</td>
                <td className="px-5 py-2">{r.actor ?? 'System'}</td>
                <td className="px-5 py-2">{r.action}</td>
                <td className="px-5 py-2 text-muted">{r.entity}</td>
                <td className="num px-5 py-2 text-muted">{r.ip}</td>
                <td className="num px-5 py-2 text-xs text-muted">{r.hash.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function Admin() {
  const { tab = 'users' } = useParams();
  const { data: lk } = useLookups();
  const spec = SPECS.find((s) => s.res === tab);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="mt-0.5 text-sm text-muted">Users, routing, time limits and hospitals: all changes apply immediately and are audited.</p>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-b border-line">
        {[...SPECS.map((s) => [s.res, s.label]), ['audit', 'Audit trail']].map(([k, l]) => (
          <NavLink key={k} to={`/admin/${k}`} className={cx('border-b-2 px-3 py-2 text-sm whitespace-nowrap', tab === k ? 'border-brand font-medium text-brand' : 'border-transparent text-muted hover:text-text')}>{l}</NavLink>
        ))}
      </nav>
      {tab === 'audit' ? <Audit /> : spec && lk ? <Resource key={spec.res} spec={spec} lk={lk} /> : null}
    </div>
  );
}
