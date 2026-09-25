import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes, businessMinutesBetween, closureChecklist, deriveState, DEFAULT_HOURS, escalationLevel,
  flagFor, sast, ticketActions, assignmentActions, can, type Calendar,
} from '../src';

const cal: Calendar = { hours: DEFAULT_HOURS, holidays: new Set(['2026-09-24']) }; // Heritage Day (Thu)
const at = (s: string) => new Date(s + '+02:00');

describe('business clock (SAST, Mon–Fri 08:00–17:00)', () => {
  it('counts only working minutes', () => {
    expect(businessMinutesBetween(at('2026-09-22T16:00'), at('2026-09-23T09:00'), cal)).toBe(120);
  });
  it('skips weekends and public holidays', () => {
    // Wed 16:00 + 4h → Wed 1h, Thu holiday, Fri 3h → Fri 11:00
    expect(sast(addBusinessMinutes(at('2026-09-23T16:00'), 240, cal))).toBe('2026-09-25 11:00');
    // Fri 16:30 + 1h → Mon 08:30
    expect(sast(addBusinessMinutes(at('2026-09-25T16:30'), 60, cal))).toBe('2026-09-28 08:30');
  });
  it('starting before opening begins at opening', () => {
    expect(sast(addBusinessMinutes(at('2026-09-22T06:00'), 30, cal))).toBe('2026-09-22 08:30');
  });
  it('add and between are inverse', () => {
    const from = at('2026-09-18T13:17');
    expect(businessMinutesBetween(from, addBusinessMinutes(from, 1000, cal), cal)).toBe(1000);
  });
});

describe('escalation thresholds', () => {
  it('maps percentage to flag and level', () => {
    expect([79, 80, 100, 150].map((p) => flagFor(p))).toEqual(['green', 'amber', 'red', 'red']);
    expect([79, 80, 100, 150].map((p) => escalationLevel(p))).toEqual([0, 1, 2, 3]);
  });
});

describe('query lifecycle', () => {
  const A = (state: any, department_id = 1) => ({ state, department_id });
  it('derives ticket state from department assignments', () => {
    expect(deriveState('assigned', [A('assigned'), A('assigned', 2)])).toBe('assigned');
    expect(deriveState('assigned', [A('in_progress'), A('assigned', 2)])).toBe('in_progress');
    expect(deriveState('in_progress', [A('responded'), A('cancelled', 2)])).toBe('response_submitted');
    expect(deriveState('under_review', [A('accepted'), A('responded', 2)])).toBe('under_review');
    expect(deriveState('under_review', [A('accepted'), A('in_progress', 2)])).toBe('in_progress');
    expect(deriveState('closed', [A('in_progress')])).toBe('closed');
  });
  it('only Client Services may open or close', () => {
    for (const r of ['dept_responder', 'dept_manager', 'management', 'admin'] as const) {
      expect(can(r, 'ticket.open')).toBe(false);
      expect(can(r, 'ticket.close')).toBe(false);
    }
    expect(ticketActions({ state: 'client_contacted' }, [A('accepted')], { role: 'dept_manager', department_id: 1 })).toEqual([]);
    expect(ticketActions({ state: 'client_contacted' }, [A('accepted')], { role: 'cs_agent', department_id: 9 })).toContain('close');
  });
  it('departments act only on their own assignment', () => {
    const t = { state: 'assigned' as const };
    expect(assignmentActions(t, A('assigned', 1), { role: 'dept_responder', department_id: 1 })).toEqual(['acknowledge']);
    expect(assignmentActions(t, A('assigned', 1), { role: 'dept_responder', department_id: 2 })).toEqual([]);
  });
  it('closure gate needs a satisfied call in the current cycle', () => {
    const base = { state: 'client_contacted' as const, assignments: [A('accepted')], closure_reason: 'resolved', root_cause: 'analytical' };
    const ok = (p: any) => closureChecklist({ ...base, ...p }).every((i) => i.ok);
    expect(ok({ calls: [], cycle: 0 })).toBe(false);
    expect(ok({ calls: [{ cycle: 0, satisfied: false }], cycle: 0 })).toBe(false);
    expect(ok({ calls: [{ cycle: 0, satisfied: true }], cycle: 1 })).toBe(false);
    expect(ok({ calls: [{ cycle: 1, satisfied: true }], cycle: 1 })).toBe(true);
    expect(ok({ calls: [{ cycle: 1, satisfied: true }], cycle: 1, root_cause: null })).toBe(false);
  });
});
