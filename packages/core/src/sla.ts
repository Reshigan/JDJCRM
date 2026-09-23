// SLA clocks. All timestamps are UTC instants; business hours are evaluated in SAST (UTC+2, no DST).
const MIN = 60_000;
const DAY = 1440 * MIN;
export const SAST_OFFSET = 120 * MIN;

export type Clock = 'business' | 'wall';
/** hours[dow] = [openMinute, closeMinute] in SAST, dow 0 = Sunday; null = closed. holidays = SAST 'YYYY-MM-DD'. */
export type Calendar = { hours: ([number, number] | null)[]; holidays: Set<string> };

export const DEFAULT_HOURS: Calendar['hours'] = [null, [480, 1020], [480, 1020], [480, 1020], [480, 1020], [480, 1020], null];

const dayWindow = (day: number, cal: Calendar): [number, number] | null => {
  const d = new Date(day * DAY);
  const h = cal.hours[d.getUTCDay()];
  if (!h || cal.holidays.has(d.toISOString().slice(0, 10))) return null;
  return [day * DAY + h[0] * MIN, day * DAY + h[1] * MIN];
};

export function businessMinutesBetween(from: Date, to: Date, cal: Calendar): number {
  const a = from.getTime() + SAST_OFFSET;
  const b = to.getTime() + SAST_OFFSET;
  let sum = 0;
  for (let day = Math.floor(a / DAY); day <= Math.floor(b / DAY); day++) {
    const w = dayWindow(day, cal);
    if (w) sum += Math.max(0, Math.min(w[1], b) - Math.max(w[0], a));
  }
  return sum / MIN;
}

export function addBusinessMinutes(from: Date, minutes: number, cal: Calendar): Date {
  let t = from.getTime() + SAST_OFFSET;
  let left = minutes * MIN;
  for (let day = Math.floor(t / DAY), n = 0; n < 3660; day++, n++) {
    const w = dayWindow(day, cal);
    if (!w) continue;
    const start = Math.max(w[0], t);
    if (w[1] - start >= left) return new Date(start + left - SAST_OFFSET);
    if (w[1] > start) left -= w[1] - start;
  }
  throw new Error('calendar has no working time');
}

export const elapsedMinutes = (from: Date, to: Date, clock: Clock, cal: Calendar) =>
  clock === 'wall' ? Math.max(0, (to.getTime() - from.getTime()) / MIN) : businessMinutesBetween(from, to, cal);

export const dueAt = (from: Date, limit: number, clock: Clock, cal: Calendar) =>
  clock === 'wall' ? new Date(from.getTime() + limit * MIN) : addBusinessMinutes(from, limit, cal);

export type Flag = 'green' | 'amber' | 'red';
export const DEFAULT_THRESHOLDS: [number, number, number] = [80, 100, 150];

/** 0 = fine, 1 = amber, 2 = red (breach), 3 = management escalation. Brief §5.5. */
export const escalationLevel = (pct: number, th = DEFAULT_THRESHOLDS) => th.filter((t) => pct >= t).length;
export const flagFor = (pct: number, th = DEFAULT_THRESHOLDS): Flag =>
  pct >= th[1] ? 'red' : pct >= th[0] ? 'amber' : 'green';

export function formatMinutes(m: number): string {
  const neg = m < 0;
  m = Math.round(Math.abs(m));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const s = d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
  return neg ? `-${s}` : s;
}

/** 'YYYY-MM-DD HH:mm' in SAST */
export const sast = (d: Date | string) => new Date(new Date(d).getTime() + SAST_OFFSET).toISOString().slice(0, 16).replace('T', ' ');
export const sastYearMonth = (d: Date) => sast(d).slice(0, 7).replace('-', '');
