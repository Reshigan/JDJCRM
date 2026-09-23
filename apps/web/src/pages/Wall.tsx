// Wall mode: full-screen, dark, high-contrast live board for the Client Services TV. No navigation, auto-refresh.
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { BLEED_STATES, can, formatMinutes, patientRef, type BleedState } from '@baton/core';
import { useMe } from '../api';
import { BatonBar, BatonMark, cx, DeptClock, FlagPill } from '../ui';
import { TILES, useLive } from './Dashboard';

export function Wall() {
  const { data: me, isLoading } = useMe();
  const { live, active, open } = useLive();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    document.documentElement.classList.add('dark');
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  if (isLoading) return null;
  if (!me || !can(me.role, 'dashboard.view')) return <Navigate to="/login" replace />;
  const breachedQ = open.filter((t) => t.flag === 'red');
  return (
    <div className="flex h-dvh flex-col gap-4 overflow-hidden bg-bg p-6 text-text">
      <header className="flex items-center gap-4">
        <BatonMark size={40} />
        <div className="text-2xl font-semibold tracking-tight">Baton · Live operations</div>
        <div className="num ml-auto text-3xl font-semibold">{now.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' })}</div>
      </header>
      <div className="grid grid-cols-6 gap-4">
        {TILES.map(([k, l]) => (
          <div key={k} className="card px-5 py-4">
            <div className="text-sm text-muted">{l}</div>
            <div className={cx('num text-5xl font-semibold', k === 'breaches' && live?.tiles[k] ? 'text-bad' : '')}>{live?.tiles[k] ?? '–'}</div>
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1.4fr_1fr] gap-4">
        <section className="card min-h-0 overflow-hidden p-5">
          <h2 className="mb-3 text-lg font-semibold">Active bleeds · {active.length}</h2>
          <ul className="space-y-3">
            {active.slice(0, 9).map((b) => (
              <li key={b.id} className={cx('grid grid-cols-[1fr_300px_110px] items-center gap-4 rounded-lg px-3 py-2', b.flag === 'red' && 'bg-bad-soft')}>
                <div className="min-w-0">
                  <div className="truncate text-lg font-medium">{b.hospital}</div>
                  <div className="truncate text-sm text-muted">{patientRef(b.patient_name, b.folder_no)} · {b.nurse ?? 'Unallocated'} · {BLEED_STATES[b.state as BleedState]}</div>
                </div>
                <div>
                  <BatonBar intervals={b.intervals} />
                  {b.current && <div className={cx('num mt-1 text-right text-sm', b.current.flag === 'red' ? 'text-bad' : 'text-muted')}>{b.current.label} {formatMinutes(b.current.used)} / {formatMinutes(b.current.limit)}</div>}
                </div>
                <FlagPill flag={b.flag} />
              </li>
            ))}
          </ul>
        </section>
        <div className="flex min-h-0 flex-col gap-4">
          <section className="card min-h-0 flex-1 overflow-hidden p-5">
            <h2 className="mb-3 text-lg font-semibold">Breach register · today</h2>
            <ul className="space-y-2">
              {(live?.register ?? []).slice(0, 7).map((r: any, i: number) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate"><span className="num font-medium">{r.number}</span> · {r.where} · {r.stage}</span>
                  <span className={cx('num shrink-0', r.running ? 'text-bad' : 'text-muted')}>{formatMinutes(r.used)} / {formatMinutes(r.limit)}</span>
                </li>
              ))}
              {!live?.register.length && <li className="text-muted">No stage has gone red today.</li>}
            </ul>
          </section>
          <section className="card p-5">
            <h2 className="mb-3 text-lg font-semibold">Queries over time limit · {breachedQ.length}</h2>
            <ul className="space-y-2">
              {breachedQ.slice(0, 4).map((t) => (
                <li key={t.id} className="flex items-center gap-3 text-sm">
                  <div className="flex gap-1">{t.assignments.map((a: any) => <DeptClock key={a.id} a={a} size={30} />)}</div>
                  <span className="min-w-0 truncate"><span className="num font-medium">{t.number}</span> · {t.category}</span>
                </li>
              ))}
              {!breachedQ.length && <li className="text-muted">All queries within time.</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
