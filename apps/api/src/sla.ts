import { DEFAULT_THRESHOLDS, dueAt, elapsedMinutes, escalationLevel, flagFor, type Calendar, type Clock } from '@baton/core';
import type { Sql } from './db';

/** Site calendars + escalation thresholds, loaded once per request/tick. */
export async function slaContext(db: Sql) {
  const [sites, hols, [th]] = await Promise.all([
    db`select id, hours from sites`,
    db`select to_char(day, 'YYYY-MM-DD') as day from holidays`,
    db`select value from settings where key = 'escalation_thresholds'`,
  ]);
  const holidays = new Set(hols.map((h) => h.day as string));
  const cals = new Map<number, Calendar>(sites.map((s) => [s.id, { hours: s.hours, holidays }]));
  const thresholds = (th?.value ?? DEFAULT_THRESHOLDS) as [number, number, number];
  const cal = (siteId: number) => cals.get(siteId)!;

  return {
    thresholds,
    due: (siteId: number, from: Date, limit: number, clock: Clock) => dueAt(from, limit, clock, cal(siteId)),
    /** Live clock for an assignment; stops at response. */
    measure(siteId: number, a: any, now = new Date()) {
      const used = elapsedMinutes(new Date(a.started_at), a.responded_at ? new Date(a.responded_at) : now, a.clock, cal(siteId));
      const pct = (used / a.limit_minutes) * 100;
      return { used, remaining: a.limit_minutes - used, pct, flag: flagFor(pct, thresholds), level: escalationLevel(pct, thresholds) };
    },
  };
}
export type SlaContext = Awaited<ReturnType<typeof slaContext>>;

export const limitFor = (cat: any, priority: string): number =>
  priority === 'critical' ? cat.limit_critical : priority === 'high' ? cat.limit_high : cat.limit_normal;
