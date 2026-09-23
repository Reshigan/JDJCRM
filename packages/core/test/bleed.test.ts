import { describe, expect, it } from 'vitest';
import { bleedIntervals, bleedState, distanceM, patientRef } from '../src';

const t0 = new Date('2026-09-23T08:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000).toISOString();

describe('bleed intervals', () => {
  it('are contiguous: each interval ends exactly where the next starts', () => {
    const b = { opened_at: at(0), arrived_at: at(40), captured_at: at(60), received_at: at(150), lab_accepted_at: at(180), released_at: at(400), filed_at: at(460) };
    const r = bleedIntervals(b, [60, 30, 120, 60, 240, 90], new Date(at(500)));
    expect(r.intervals.map((i) => i.used)).toEqual([40, 20, 90, 30, 220, 60]);
    expect(r.total).toBe(460);
    expect(r.intervals.reduce((s, i) => s + i.used, 0)).toBe(r.total);
    expect(r.flag).toBe('amber'); // processing at 92%
    expect(bleedState(b)).toBe('filed');
  });
  it('runs the current interval live and flags red past the limit; overall = worst', () => {
    const r = bleedIntervals({ opened_at: at(0), arrived_at: at(20) }, [60, 30, 120, 60, 240, 90], new Date(at(55)));
    expect(r.current?.key).toBe('bleed');
    expect(r.current?.used).toBe(35);
    expect(r.flag).toBe('red');
    expect(r.intervals[2].status).toBe('pending');
  });
  it('stops all clocks on cancellation or an unsuccessful bleed', () => {
    const r = bleedIntervals({ opened_at: at(0), cancelled_at: at(10) }, undefined, new Date(at(999)));
    expect(r.current).toBeNull();
    expect(bleedState({ opened_at: at(0), arrived_at: at(5), outcome: 'patient_refused' })).toBe('unsuccessful');
  });
});

describe('geofence helpers', () => {
  it('measures distance in metres', () => {
    const d = distanceM({ lat: -25.7479, lng: 28.2293 }, { lat: -25.7479, lng: 28.2393 });
    expect(Math.round(d)).toBeGreaterThan(990);
    expect(Math.round(d)).toBeLessThan(1010);
  });
  it('boards show a minimal patient reference', () => {
    expect(patientRef('Maria van der Merwe', 'F123')).toBe('MVDM · F123');
  });
});
