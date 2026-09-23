import { forwardRef, useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Circle, OctagonAlert } from 'lucide-react';
import { formatMinutes, QUERY_STATES, type QueryState } from '@baton/core';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Six segments: the six measured intervals of a bleed; every handover owned. */
export function BatonMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="14" fill="#0E1726" />
      {[0.35, 0.5, 0.65, 0.8, 0.9, 1].map((o, i) => (
        <rect key={i} x={8 + i * 8.4} y="26" width="6" height="12" rx="3" fill="#7482FF" opacity={o} />
      ))}
    </svg>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'outline'; size?: 'sm' | 'md' };
export const Button = forwardRef<HTMLButtonElement, BtnProps>(({ variant = 'primary', size = 'md', className, ...p }, ref) => (
  <button
    ref={ref}
    {...p}
    className={cx(
      'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-sm',
      variant === 'primary' && 'bg-brand text-brand-ink hover:opacity-90',
      variant === 'outline' && 'border border-line bg-surface hover:bg-surface-2',
      variant === 'ghost' && 'hover:bg-surface-2',
      variant === 'danger' && 'bg-bad text-white hover:opacity-90',
      className,
    )}
  />
));

const field = 'w-full rounded-lg border border-line bg-surface px-3 text-sm placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((p, ref) => (
  <input ref={ref} {...p} className={cx(field, 'h-10', p.className)} />
));
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(field, 'h-10 pr-8', p.className)} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={4} {...p} className={cx(field, 'py-2', p.className)} />;

export function Field({ label, hint, children, required, className }: { label: string; hint?: ReactNode; children: ReactNode; required?: boolean; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-[13px] font-medium">
        {label}
        {required && <span className="text-bad"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const Card = ({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={cx('card', className)}>
    {title && (
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </header>
    )}
    <div className="p-5">{children}</div>
  </section>
);

export type Flag = 'green' | 'amber' | 'red';
const FLAG = {
  green: { cls: 'bg-ok-soft text-ok', label: 'On time', Icon: CheckCircle2 },
  amber: { cls: 'bg-warn-soft text-warn', label: 'At risk', Icon: AlertTriangle },
  red: { cls: 'bg-bad-soft text-bad', label: 'Breached', Icon: OctagonAlert },
};
/** Status is never colour alone: icon + label too. */
export function FlagPill({ flag, compact }: { flag: Flag; compact?: boolean }) {
  const f = FLAG[flag];
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', f.cls)} title={f.label}>
      <f.Icon size={13} strokeWidth={2.4} />
      {!compact && f.label}
    </span>
  );
}

export const Badge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' | Flag | 'geo' }) => (
  <span
    className={cx(
      'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
      tone === 'neutral' && 'bg-surface-2 text-muted',
      tone === 'brand' && 'bg-brand-soft text-brand',
      tone === 'green' && 'bg-ok-soft text-ok',
      tone === 'amber' && 'bg-warn-soft text-warn',
      tone === 'red' && 'bg-bad-soft text-bad',
      tone === 'geo' && 'bg-geo-soft text-geo',
    )}
  >
    {children}
  </span>
);

export const PRIORITY_TONE = { critical: 'red', high: 'amber', normal: 'neutral' } as const;

export function StatePill({ state }: { state: QueryState }) {
  const tone = state === 'closed' ? 'green' : state === 'response_submitted' || state === 'under_review' || state === 'client_contacted' ? 'brand' : 'neutral';
  return <Badge tone={tone}>{QUERY_STATES[state]}</Badge>;
}

/** Dept Clock: one ring per routed department, each running its own SLA. */
export function DeptClock({ a, size = 44 }: { a: any; size?: number }) {
  const done = ['responded', 'accepted'].includes(a.state);
  const pct = Math.min(a.sla.pct, 100);
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const color = done ? 'var(--muted)' : a.sla.flag === 'red' ? 'var(--red)' : a.sla.flag === 'amber' ? 'var(--amber)' : 'var(--green)';
  const tip = done
    ? `${a.department}: responded in ${formatMinutes(a.sla.used)}`
    : `${a.department}: ${a.sla.remaining >= 0 ? formatMinutes(a.sla.remaining) + ' left' : formatMinutes(-a.sla.remaining) + ' over'} (${Math.round(a.sla.pct)}%)`;
  return (
    <span className="relative inline-grid place-items-center" style={{ width: size, height: size }} title={tip} aria-label={tip}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`} className={cx(!done && a.sla.flag === 'red' && 'pulse')}
        />
      </svg>
      <span className="absolute text-[10px] font-semibold tracking-tight">{a.code ?? a.department_code}</span>
    </span>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className={cx('card m-auto w-[calc(100%-2rem)] p-0 text-text', wide ? 'max-w-2xl' : 'max-w-md')}>
      {open && (
        <>
          <header className="border-b border-line px-5 py-3.5 text-sm font-semibold">{title}</header>
          <div className="p-5">{children}</div>
        </>
      )}
    </dialog>
  );
}

export const ErrorText = ({ error }: { error: unknown }) =>
  error ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{(error as Error).message}</p> : null;

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted">
    <Circle size={20} className="opacity-40" />
    {children}
  </div>
);

export const ago = (d: string | Date) => formatMinutes((Date.now() - new Date(d).getTime()) / 60_000, true);
