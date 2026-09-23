import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Droplet, Gauge, Route, Inbox, LogOut, Moon, Plus, ScanLine, Search, Settings2, Smartphone, Sun, UserRound } from 'lucide-react';
import { can, ROLES } from '@baton/core';
import { api, useLookups, useMe } from './api';
import { useLiveEvents } from './live';
import { ago, BatonMark, Button, cx } from './ui';

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const d = !dark;
    document.documentElement.classList.toggle('dark', d);
    try { localStorage.setItem('baton-theme', d ? 'dark' : 'light'); } catch {}
    setDark(d);
  };
  return { dark, toggle };
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api('/notifications'), refetchInterval: 60_000 });
  const read = useMutation({ mutationFn: (ids?: number[]) => api('/notifications/read', { body: { ids } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <div className="relative">
      <Button variant="ghost" size="sm" aria-label="Notifications" onClick={() => setOpen(!open)} className="relative">
        <Bell size={18} />
        {data?.unread > 0 && <span className="num absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] text-white">{data.unread}</span>}
      </Button>
      {open && (
        <div className="card absolute right-0 z-30 mt-2 max-h-[70vh] w-[min(380px,calc(100vw-2rem))] overflow-auto" onMouseLeave={() => setOpen(false)}>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-sm font-semibold">
            Notifications
            <button className="text-xs font-normal text-brand" onClick={() => read.mutate(undefined)}>Mark all read</button>
          </div>
          {!data?.rows.length && <p className="p-6 text-center text-sm text-muted">You're all caught up.</p>}
          {data?.rows.map((n: any) => (
            <button
              key={n.id}
              onClick={() => { read.mutate([n.id]); setOpen(false); const to = n.link ?? (n.ticket_id && `/tickets/${n.ticket_id}`); if (to) nav(to); }}
              className={cx('block w-full border-b border-line px-4 py-3 text-left last:border-0 hover:bg-surface-2', !n.read_at && 'bg-brand-soft/40')}
            >
              <div className="flex items-center justify-between gap-2 text-xs text-muted">
                <span className="num">{n.number}</span>
                <span>{ago(n.created_at)} ago</span>
              </div>
              <div className="mt-0.5 text-sm font-medium">{n.title}</div>
              {n.body && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const { data: me, isLoading, error } = useMe();
  const { data: lk } = useLookups();
  const { dark, toggle } = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const search = useRef<HTMLInputElement>(null);
  useLiveEvents(!!me?.mfa_ok);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return;
      if (e.key === '/') { e.preventDefault(); search.current?.focus(); }
      if (e.key === 'n' && me && can(me.role, 'ticket.open')) nav('/tickets/new');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [me, nav]);

  if (isLoading) return <div className="grid h-dvh place-items-center"><BatonMark size={40} className="pulse" /></div>;
  if (error || !me || !me.mfa_ok) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.role === 'admin' && !loc.pathname.startsWith('/admin') && loc.pathname !== '/account') return <Navigate to="/admin" replace />;
  const dept = lk?.departments.find((d) => d.id === me.department_id)?.code;
  if (dept === 'NUR' && me.role === 'dept_responder' && loc.pathname === '/tickets' && !loc.search) return <Navigate to="/field" replace />;

  const logout = async () => {
    await api('/auth/logout', { body: {} });
    qc.clear();
    nav('/login');
  };
  const link = ({ isActive }: { isActive: boolean }) =>
    cx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-text');

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 md:flex">
        <Link to="/" className="mb-6 flex items-center gap-2.5 px-2">
          <BatonMark />
          <span>
            <span className="block text-[15px] leading-tight font-semibold tracking-tight">Baton</span>
            <span className="block text-[11px] text-muted">Every handover, owned.</span>
          </span>
        </Link>
        <nav className="flex flex-col gap-1">
          {(can(me.role, 'dashboard.view') || me.role === 'dept_manager') && <NavLink to="/dashboard" className={link}><Gauge size={17} />Dashboard</NavLink>}
          {me.role !== 'admin' && (
            <NavLink to="/tickets" end className={link}><Inbox size={17} />{can(me.role, 'tickets.view_all') ? 'Query board' : 'My department'}</NavLink>
          )}
          {can(me.role, 'ticket.open') && <NavLink to="/tickets/new" className={link}><Plus size={17} />New query</NavLink>}
          {can(me.role, 'dashboard.view') && <NavLink to="/bleeds" end className={link}><Droplet size={17} />Bleed board</NavLink>}
          {can(me.role, 'bleed.open') && <NavLink to="/bleeds/new" className={link}><Plus size={17} />New bleed request</NavLink>}
          {can(me.role, 'dashboard.view') && <NavLink to="/nurses" className={link}><Route size={17} />Nurse runs</NavLink>}
          {(dept === 'PRE' || dept === 'ANA') && <NavLink to="/samples" className={link}><ScanLine size={17} />Sample desk</NavLink>}
          {dept === 'NUR' && <NavLink to="/field" className={link}><Smartphone size={17} />Field app</NavLink>}
          {can(me.role, 'admin.configure') && <NavLink to="/admin" className={link}><Settings2 size={17} />Administration</NavLink>}
        </nav>
        <div className="mt-auto border-t border-line pt-3">
          <NavLink to="/account" className={link}>
            <UserRound size={17} />
            <span className="min-w-0">
              <span className="block truncate text-text">{me.name}</span>
              <span className="block truncate text-[11px] font-normal">{ROLES[me.role]}</span>
            </span>
          </NavLink>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg/85 px-4 backdrop-blur md:px-6">
          <Link to="/" className="md:hidden"><BatonMark size={26} /></Link>
          {me.role !== 'admin' && (
            <form
              className="relative max-w-md min-w-0 flex-1"
              onSubmit={(e) => { e.preventDefault(); nav(`/search?q=${encodeURIComponent(search.current!.value)}`); }}
            >
              <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input
                ref={search}
                placeholder="Search ticket, patient, requisition, complainant…"
                className="h-9 w-full rounded-lg border border-line bg-surface pr-10 pl-9 text-sm focus:border-brand focus:outline-none"
              />
              <kbd className="num absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border border-line px-1.5 text-[11px] text-muted sm:block">/</kbd>
            </form>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Notifications />
            <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle theme">{dark ? <Sun size={18} /> : <Moon size={18} />}</Button>
            <Button variant="ghost" size="sm" onClick={() => nav('/account')} className="md:hidden" aria-label="Account"><UserRound size={18} /></Button>
            <Button variant="ghost" size="sm" onClick={logout} aria-label="Sign out"><LogOut size={18} /></Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Landing: the dashboard for Client Services and Management (brief §7 "opens on a live operational view"). */
export function Home() {
  const { data: me } = useMe();
  if (!me) return null;
  return <Navigate to={can(me.role, 'dashboard.view') ? '/dashboard' : '/tickets'} replace />;
}
