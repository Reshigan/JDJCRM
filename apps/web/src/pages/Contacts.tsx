import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Merge, Pencil } from 'lucide-react';
import { can, COMPLAINANT_TYPES } from '@baton/core';
import { api, useLookups, useMe } from '../api';
import { ago, Badge, Button, Card, Empty, ErrorText, Field, Input, Modal, Select } from '../ui';

type Contact = { id: number; name: string; type: string; organisation_id: number | null; organisation: string | null; phone: string | null; email: string | null; total: number; open: number; last_at: string | null };

/** Client register (brief §5.2): everyone who has raised a query, under their practice or hospital. */
export function Contacts() {
  const { data: me } = useMe();
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Contact | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['contacts', q], queryFn: () => api<Contact[]>(`/contacts?q=${encodeURIComponent(q)}`) });
  const merger = !!me && can(me.role, 'contact.merge');
  const { data: dups } = useQuery({ queryKey: ['contacts', 'duplicates'], queryFn: () => api<Contact[][]>('/contacts/duplicates'), enabled: merger });
  const done = () => qc.invalidateQueries({ queryKey: ['contacts'] });
  const merge = useMutation({
    mutationFn: async ({ keep, group }: { keep: Contact; group: Contact[] }) => { for (const c of group) if (c.id !== keep.id) await api(`/contacts/${c.id}/merge`, { body: { into: keep.id } }); },
    onSuccess: done,
  });
  const save = useMutation({ mutationFn: (c: Contact) => api(`/contacts/${c.id}`, { method: 'PUT', body: { name: c.name, type: c.type, organisation_id: c.organisation_id, phone: c.phone || null, email: c.email || '' } }), onSuccess: () => { setEdit(null); done(); } });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Client register</h1>
        <p className="mt-0.5 text-sm text-muted">Everyone who has raised a query, under their practice or hospital. New complainants are added at intake.</p>
      </div>

      {merger && !!dups?.length && (
        <Card title={`Possible duplicates (${dups.length})`}>
          <p className="-mt-1 mb-3 text-sm text-muted">Same name once titles and punctuation are ignored. Choose the entry to keep: the others are merged into it, with their tickets. Merges are recorded in the audit trail.</p>
          <ul className="space-y-3">
            {dups.map((g) => (
              <li key={g.map((c) => c.id).join()} className="divide-y divide-line rounded-lg border border-line">
                {g.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted">{c.organisation ?? 'No practice'} · {c.phone ?? c.email ?? '—'} · {c.total} ticket{c.total !== 1 && 's'}</span>
                    <Button size="sm" variant="outline" className="ml-auto" aria-label={`Keep ${c.name}`} disabled={merge.isPending} onClick={() => merge.mutate({ keep: c, group: g })}>
                      <Merge size={14} />Keep this one
                    </Button>
                  </div>
                ))}
              </li>
            ))}
          </ul>
          <ErrorText error={merge.error} />
        </Card>
      )}

      <Card>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, practice, phone or e-mail" className="mb-4 max-w-md" />
        <div className="-mx-5 -mb-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-y border-line bg-surface-2/60 text-left text-xs text-muted">
              <tr>{['Name', 'Practice / hospital', 'Contact', 'Queries', 'Last', ''].map((h) => <th key={h} className="px-5 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-2.5"><div className="font-medium">{c.name}</div><div className="text-xs text-muted">{COMPLAINANT_TYPES[c.type as keyof typeof COMPLAINANT_TYPES]}</div></td>
                  <td className="px-5 py-2.5">{c.organisation ?? <span className="text-muted">—</span>}</td>
                  <td className="px-5 py-2.5 text-xs">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-5 py-2.5">
                    <Link to={`/tickets?scope=all&contact_id=${c.id}`} className="num text-brand">{c.total}</Link>
                    {c.open > 0 && <Badge tone="amber">{c.open} open</Badge>}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-muted">{c.last_at ? `${ago(c.last_at)} ago` : '—'}</td>
                  <td className="px-5 py-2.5 text-right">{me && can(me.role, 'ticket.open') && <Button size="sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => { save.reset(); setEdit(c); }}><Pencil size={14} /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!isLoading && !data?.length && <Empty>No one matches.</Empty>}
        </div>
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} title="Edit client">
        {edit && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(edit); }}>
            <Field label="Name" required><Input value={edit.name} required onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Type" required>
              <Select value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>{Object.entries(COMPLAINANT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </Field>
            <Field label="Practice / hospital">
              <Select value={edit.organisation_id ?? ''} onChange={(e) => setEdit({ ...edit, organisation_id: e.target.value ? +e.target.value : null })}>
                <option value="">—</option>
                {lk?.organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone"><Input type="tel" value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
              <Field label="E-mail"><Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            </div>
            <ErrorText error={save.error} />
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={save.isPending}>Save</Button></div>
          </form>
        )}
      </Modal>
    </div>
  );
}
