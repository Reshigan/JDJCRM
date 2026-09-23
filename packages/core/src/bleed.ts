// Module B (brief §6). A bleed is timed by 7 checkpoints; the 6 intervals are derived, so no gaps are possible.
import { DEFAULT_THRESHOLDS, flagFor, type Flag } from './sla';

export const CHECKPOINTS = ['opened_at', 'arrived_at', 'captured_at', 'received_at', 'lab_accepted_at', 'released_at', 'filed_at'] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

export const INTERVALS = [
  { key: 'response', label: 'Response', owner: 'Client Services / Nursing', dept: 'NUR' },
  { key: 'bleed', label: 'Bleed', owner: 'Nursing', dept: 'NUR' },
  { key: 'logistics', label: 'Logistics', owner: 'Nursing / Logistics', dept: 'PRE' },
  { key: 'receiving', label: 'Receiving', owner: 'Pre-Analytical', dept: 'PRE' },
  { key: 'processing', label: 'Processing', owner: 'Analytical', dept: 'ANA' },
  { key: 'reporting', label: 'Reporting', owner: 'Analytical / Nursing', dept: 'NUR' },
] as const;

/** Minutes, 24/7. Brief fixes reporting at 90; the rest are TBC and editable in Admin → Settings (bleed_limits). */
export const DEFAULT_BLEED_LIMITS = [60, 30, 120, 60, 240, 90];

export const OUTCOMES = {
  successful: 'Successful',
  patient_unavailable: 'Patient unavailable',
  patient_refused: 'Patient refused',
  difficult_draw: 'Difficult draw, repeat required',
  cancelled_by_hospital: 'Cancelled by hospital',
} as const;
export type Outcome = keyof typeof OUTCOMES;

export const TUBE_TYPES = ['EDTA (purple)', 'SST (gold)', 'Citrate (blue)', 'Heparin (green)', 'Fluoride (grey)', 'Blood culture', 'Other'] as const;

export const BLEED_STATES = {
  awaiting_arrival: 'Nurse en route',
  on_site: 'Nurse on site',
  in_transit: 'In transit to lab',
  receiving: 'At Pre-Analytical',
  processing: 'In laboratory',
  reporting: 'Report to be filed',
  filed: 'Report filed',
  unsuccessful: 'Unsuccessful',
  cancelled: 'Cancelled',
  closed: 'Closed',
} as const;
export type BleedState = keyof typeof BLEED_STATES;

type Stamps = Partial<Record<Checkpoint, string | Date | null>> & {
  outcome?: string | null;
  cancelled_at?: string | Date | null;
  closed_at?: string | Date | null;
};

export function bleedState(b: Stamps): BleedState {
  if (b.closed_at) return 'closed';
  if (b.cancelled_at) return 'cancelled';
  if (b.outcome && b.outcome !== 'successful') return 'unsuccessful';
  const order: [Checkpoint, BleedState][] = [
    ['filed_at', 'filed'], ['released_at', 'reporting'], ['lab_accepted_at', 'processing'],
    ['received_at', 'receiving'], ['captured_at', 'in_transit'], ['arrived_at', 'on_site'],
  ];
  return order.find(([c]) => b[c])?.[1] ?? 'awaiting_arrival';
}

export type IntervalStatus = { key: string; label: string; owner: string; index: number; status: 'done' | 'running' | 'pending'; used: number; limit: number; pct: number; flag: Flag };

/** Brief §6.5: each interval scored independently; overall = worst. Stopped bleeds stop every clock. */
export function bleedIntervals(b: Stamps, limits = DEFAULT_BLEED_LIMITS, now = new Date(), th = DEFAULT_THRESHOLDS) {
  const stoppedAt = b.cancelled_at ?? (b.outcome && b.outcome !== 'successful' ? b.captured_at ?? null : null);
  const intervals: IntervalStatus[] = INTERVALS.map((iv, i) => {
    const start = b[CHECKPOINTS[i]];
    const end = b[CHECKPOINTS[i + 1]];
    const status = end ? 'done' : start && !stoppedAt ? 'running' : 'pending';
    const stop = end ?? (status === 'running' ? now : null);
    const used = start && stop ? Math.max(0, (new Date(stop).getTime() - new Date(start).getTime()) / 60_000) : 0;
    const pct = (used / limits[i]) * 100;
    return { key: iv.key, label: iv.label, owner: iv.owner, index: i, status, used, limit: limits[i], pct, flag: status === 'pending' ? 'green' : flagFor(pct, th) };
  });
  const rank = { green: 0, amber: 1, red: 2 };
  const flag = intervals.reduce<Flag>((w, x) => (rank[x.flag] > rank[w] ? x.flag : w), 'green');
  const current = intervals.find((x) => x.status === 'running') ?? null;
  const total = b.filed_at ? (new Date(b.filed_at).getTime() - new Date(b.opened_at!).getTime()) / 60_000 : null;
  return { intervals, flag, current, total };
}

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Patient reference for boards: initials + folder, never the full name (POPIA minimisation). */
export const patientRef = (name?: string | null, folder?: string | null) =>
  [name ? name.split(/\s+/).map((p) => p[0]?.toUpperCase()).join('') : null, folder].filter(Boolean).join(' · ') || '—';
