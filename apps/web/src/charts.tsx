// Chart kit. One series per chart in the brand hue (validated ≥3:1 on both surfaces); limits are neutral ink
// markers; values live in text tokens. Every chart has a hover/focus tooltip and a table view.
import { useRef, useState, type ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import { cx } from './ui';

type Tip = { x: number; y: number; body: ReactNode } | null;
function useTip() {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const show = (e: { clientX: number; clientY: number } | Element, body: ReactNode) => {
    const r = box.current!.getBoundingClientRect();
    const p = 'clientX' in e ? e : (() => { const b = e.getBoundingClientRect(); return { clientX: b.left + b.width / 2, clientY: b.top }; })();
    setTip({ x: p.clientX - r.left, y: p.clientY - r.top, body });
  };
  const layer = tip && (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg" style={{ left: tip.x, top: tip.y }}>
      {tip.body}
    </div>
  );
  return { box, show, hide: () => setTip(null), layer };
}

export function ChartCard({ title, sub, children, table, action, dim }: { title: string; sub?: ReactNode; children: ReactNode; table: ReactNode; action?: ReactNode; dim?: boolean }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card">
      <header className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
        </div>
        <div className="flex items-center gap-1">
          {action}
          <button onClick={() => setAsTable(!asTable)} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" aria-label={asTable ? 'Show chart' : 'Show table'} title={asTable ? 'Show chart' : 'Show table'}>
            {asTable ? <BarChart3 size={16} /> : <Table2 size={16} />}
          </button>
        </div>
      </header>
      <div className={cx('p-5 transition-opacity', dim && 'opacity-50')}>{asTable ? <div className="-mx-5 overflow-x-auto">{table}</div> : children}</div>
    </section>
  );
}

export const DataTable = ({ head, rows, onPick, text }: { head: string[]; rows: { key: string | number; cells: ReactNode[] }[]; onPick?: (k: string | number) => void; text?: boolean }) => (
  <table className="w-full min-w-[420px] text-sm">
    <thead className="border-y border-line bg-surface-2/60 text-left text-xs text-muted">
      <tr>{head.map((h, i) => <th key={h} className={cx('px-5 py-2 font-medium', i > 0 && !text && 'text-right')}>{h}</th>)}</tr>
    </thead>
    <tbody>
      {rows.map((r) => (
        <tr key={r.key} onClick={onPick && (() => onPick(r.key))} className={cx('border-b border-line last:border-0', onPick && 'cursor-pointer hover:bg-surface-2/60')}>
          {r.cells.map((c, i) => <td key={i} className={cx('px-5 py-2', i > 0 && !text && 'num text-right')}>{c}</td>)}
        </tr>
      ))}
      {!rows.length && <tr><td colSpan={head.length} className="px-5 py-6 text-center text-muted">No data in this period.</td></tr>}
    </tbody>
  </table>
);

/** Horizontal bars. Optional neutral limit marker per row. Rows are buttons: hover, focus and click-to-drill. */
export function BarList({ rows, fmt = String, onPick, markerLabel = 'Limit' }: {
  rows: { id: string | number; label: string; value: number | null; marker?: number; tip?: ReactNode }[];
  fmt?: (v: number) => string; onPick?: (id: string | number) => void; markerLabel?: string;
}) {
  const t = useTip();
  const max = Math.max(1, ...rows.flatMap((r) => [r.value ?? 0, r.marker ?? 0])) * 1.08;
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">No data in this period.</p>;
  return (
    <div ref={t.box} className="relative space-y-1.5" onPointerLeave={t.hide}>
      {rows.map((r) => {
        const body = <><b className="num text-sm">{r.value == null ? '—' : fmt(r.value)}</b> <span className="text-muted">{r.label}</span>{r.marker != null && <div className="text-muted">{markerLabel} {fmt(r.marker)}</div>}{r.tip}</>;
        return (
          <button
            key={r.id} type="button" disabled={!onPick}
            onClick={() => onPick?.(r.id)}
            onPointerMove={(e) => t.show(e, body)} onFocus={(e) => t.show(e.currentTarget, body)} onBlur={t.hide}
            aria-label={`${r.label}: ${r.value == null ? 'no data' : fmt(r.value)}${r.marker != null ? `, ${markerLabel.toLowerCase()} ${fmt(r.marker)}` : ''}`}
            className="group grid w-full grid-cols-[minmax(90px,34%)_1fr_64px] items-center gap-3 rounded-md px-1 py-1 text-left enabled:cursor-pointer enabled:hover:bg-surface-2/60 disabled:cursor-default"
          >
            <span className="truncate text-[13px]">{r.label}</span>
            <span className="relative h-5">
              <span className="absolute inset-y-0 left-0 my-auto h-2.5 rounded-r-[4px] bg-brand transition-opacity group-hover:opacity-80" style={{ width: `${((r.value ?? 0) / max) * 100}%` }} />
              {r.marker != null && <span className="absolute inset-y-0 w-px bg-text/70" style={{ left: `${(r.marker / max) * 100}%` }} aria-hidden />}
            </span>
            <span className="num text-right text-[13px]">{r.value == null ? '—' : fmt(r.value)}</span>
          </button>
        );
      })}
      {rows.some((r) => r.marker != null) && <div className="flex items-center gap-1.5 pl-1 text-[11px] text-muted"><span className="inline-block h-3 w-px bg-text/70" />{markerLabel}</div>}
      {t.layer}
    </div>
  );
}

const W = 640, H = 160, PAD = { l: 34, r: 12, t: 12, b: 22 };

/** Daily columns (counts). */
export function Columns({ data, label, fmtDay = (d: string) => d.slice(5) }: { data: { day: string; n: number }[]; label: string; fmtDay?: (d: string) => string }) {
  const t = useTip();
  const max = Math.max(1, ...data.map((d) => d.n));
  const top = Math.ceil(max / 5) * 5 || 5;
  const band = (W - PAD.l - PAD.r) / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.7);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  return (
    <div ref={t.box} className="relative" onPointerLeave={t.hide}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} per day`}>
        {[0, top / 2, top].map((v) => (
          <g key={v}><line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" className="fill-[var(--muted)] text-[10px]">{v}</text></g>
        ))}
        {data.map((d, i) => {
          const x = PAD.l + i * band + (band - bw) / 2, h = y(0) - y(d.n), r = Math.min(4, h);
          return (
            <g key={d.day} tabIndex={0} aria-label={`${d.day}: ${d.n}`} className="outline-none"
              onPointerMove={(e) => t.show(e, <><b className="num text-sm">{d.n}</b> <span className="text-muted">{label} · {d.day}</span></>)}
              onFocus={(e) => t.show(e.currentTarget, <><b className="num text-sm">{d.n}</b> <span className="text-muted">{label} · {d.day}</span></>)} onBlur={t.hide}>
              <rect x={PAD.l + i * band} y={PAD.t} width={band} height={H - PAD.t - PAD.b} fill="transparent" />
              {d.n > 0 && <path d={`M${x},${y(0)} V${y(d.n) + r} q0,-${r} ${r},-${r} h${bw - 2 * r} q${r},0 ${r},${r} V${y(0)} Z`} fill="var(--brand)" />}
            </g>
          );
        })}
        {[0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i && data[v]).map((i) => (
          <text key={i} x={PAD.l + i * band + band / 2} y={H - 6} textAnchor={i === 0 && data.length > 1 ? 'start' : i === data.length - 1 && data.length > 1 ? 'end' : 'middle'} className="fill-[var(--muted)] text-[10px]">{fmtDay(data[i].day)}</text>
        ))}
      </svg>
      {t.layer}
    </div>
  );
}

/** Percentage over time (0–100). Crosshair snaps to the nearest day; gaps where there is no data. */
export function PctLine({ data, label }: { data: { day: string; v: number | null }[]; label: string }) {
  const t = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const step = (W - PAD.l - PAD.r) / Math.max(1, data.length - 1);
  const x = (i: number) => PAD.l + i * step;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / 100);
  const path = data.reduce((p, d, i) => (d.v == null ? p : p + `${p && data[i - 1]?.v != null ? 'L' : 'M'}${x(i)},${y(d.v)}`), '');
  const lastI = data.reduce((acc, d, i) => (d.v != null ? i : acc), -1);
  const pick = (clientX: number) => {
    const svg = t.box.current!.querySelector('svg')!.getBoundingClientRect();
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((clientX - svg.left) / svg.width * W - PAD.l) / step)));
    setHover(i);
    return i;
  };
  return (
    <div ref={t.box} className="relative" onPointerLeave={() => { t.hide(); setHover(null); }}
      onPointerMove={(e) => { const i = pick(e.clientX); const d = data[i]; t.show(e, <><b className="num text-sm">{d.v == null ? '—' : `${d.v}%`}</b> <span className="text-muted">{label} · {d.day}</span></>); }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} per day`}>
        {[0, 50, 100].map((v) => (
          <g key={v}><line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" className="fill-[var(--muted)] text-[10px]">{v}%</text></g>
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth="1" />}
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => d.v != null && (data[i - 1]?.v == null && data[i + 1]?.v == null || i === hover || i === lastI) && (
          <circle key={i} cx={x(i)} cy={y(d.v)} r="4" fill="var(--brand)" stroke="var(--surface)" strokeWidth="2" />
        ))}
        {lastI >= 0 && data[lastI].v != null && <text x={x(lastI) > W - 60 ? x(lastI) - 8 : x(lastI) + 8} y={y(data[lastI].v!) < PAD.t + 14 ? y(data[lastI].v!) + 16 : y(data[lastI].v!) - 8} textAnchor={x(lastI) > W - 60 ? 'end' : 'start'} className="fill-[var(--text)] text-[11px] font-semibold">{data[lastI].v}%</text>}
        {[0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i && data[v]).map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} className="fill-[var(--muted)] text-[10px]">{data[i].day.slice(5)}</text>
        ))}
      </svg>
      {t.layer}
    </div>
  );
}

/** Stat tile: label, value, optional context line. */
export const Stat = ({ label, value, sub, tone, hero }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'bad' | 'warn' | 'ok'; hero?: boolean }) => (
  <div className="card px-4 py-3">
    <div className="text-xs font-medium text-muted">{label}</div>
    <div className={cx('mt-1 font-semibold tabular-nums tracking-tight', hero ? 'text-5xl' : 'text-3xl', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>{value}</div>
    {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
  </div>
);
