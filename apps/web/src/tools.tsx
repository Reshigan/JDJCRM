// Productivity helpers: saved board views, canned responses, @mentions.
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, X } from 'lucide-react';
import { api, useLookups } from './api';
import { Button, cx, Input } from './ui';

/** Named filter sets for a board, per user. The view is the URL query string. */
export function SavedViews({ page }: { page: 'tickets' | 'bleeds' }) {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [naming, setNaming] = useState(false);
  const { data } = useQuery({ queryKey: ['views', page], queryFn: () => api<{ id: number; name: string; query: string }[]>(`/views?page=${page}`) });
  const done = () => qc.invalidateQueries({ queryKey: ['views', page] });
  const save = useMutation({ mutationFn: (name: string) => api('/views', { body: { page, name, query: params.toString() } }), onSuccess: () => { setNaming(false); done(); } });
  const del = useMutation({ mutationFn: (id: number) => api(`/views/${id}`, { method: 'DELETE' }), onSuccess: done });
  const cur = params.toString();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {data?.map((v) => (
        <span key={v.id} className={cx('inline-flex h-8 items-center rounded-lg border text-sm', v.query === cur ? 'border-brand bg-brand-soft text-brand' : 'border-line')}>
          <button className="px-2.5" onClick={() => setParams(new URLSearchParams(v.query), { replace: true })}>{v.name}</button>
          <button aria-label={`Delete view ${v.name}`} className="pr-2 text-muted hover:text-bad" onClick={() => del.mutate(v.id)}><X size={13} /></button>
        </span>
      ))}
      {naming ? (
        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); save.mutate(String(new FormData(e.currentTarget).get('name'))); }}>
          <Input name="name" autoFocus required maxLength={60} placeholder="View name" className="h-8 w-40" />
          <Button size="sm">Save</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        </form>
      ) : (
        cur && !data?.some((v) => v.query === cur) && <Button size="sm" variant="ghost" onClick={() => setNaming(true)}><Bookmark size={14} />Save view</Button>
      )}
    </div>
  );
}

/** Appends a canned response to the named textarea in the same form. */
export function Canned({ target }: { target: string }) {
  const { data: lk } = useLookups();
  if (!lk?.canned?.length) return null;
  return (
    <select
      aria-label="Insert canned response"
      value=""
      className="mt-1.5 h-8 rounded-md border border-line bg-surface px-2 text-xs text-muted"
      onChange={(e) => {
        const el = e.target.form?.elements.namedItem(target) as HTMLTextAreaElement | null;
        const c = lk.canned.find((x) => String(x.id) === e.target.value);
        if (el && c) { el.value = el.value ? `${el.value}\n${c.body}` : c.body; el.focus(); }
      }}
    >
      <option value="">Insert canned response…</option>
      {lk.canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
    </select>
  );
}

/** Text input that suggests colleagues after "@". */
export function MentionInput({ value, onChange, people, ...p }: { value: string; onChange: (v: string) => void; people: { id: string; name: string }[] } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const m = /@([^@\n]{0,30})$/.exec(value);
  const frag = m?.[1].toLowerCase();
  const hits = frag == null ? [] : people.filter((u) => { const n = u.name.toLowerCase(); return n.startsWith(frag) || n.split(/\s+/).some((w) => w.startsWith(frag)); }).slice(0, 6);
  return (
    <div className="relative min-w-0 flex-1">
      <Input {...p} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
      {hits.length > 0 && (
        <ul role="listbox" className="card absolute top-full left-0 z-20 mt-1 w-64 overflow-hidden py-1">
          {hits.map((u) => (
            <li key={u.id}>
              <button type="button" role="option" aria-selected={false} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => onChange(`${value.slice(0, m!.index)}@${u.name} `)}>{u.name}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Highlights @Name for known colleagues. */
export function withMentions(body: string, names: string[]) {
  if (!names.length) return body;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'gi');
  return body.split(re).map((part, i) => (i % 2 ? <span key={i} className="font-medium text-brand">{part}</span> : part));
}
