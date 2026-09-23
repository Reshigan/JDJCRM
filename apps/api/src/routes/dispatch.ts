// Dispatch assist: rank nurses for a new bleed request, and show every nurse's live run.
// Location use is minimal: only the hospital of each nurse's last checkpoint (already recorded), never coordinates.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bleedIntervals, distanceM } from '@baton/core';
import { requirePerm } from '../auth';
import { fail, sql } from '../db';
import { bleedConfig } from './bleeds';

async function nurses() {
  return sql`
    select u.id, u.name,
      (select count(distinct r.id)::int from bleed_requests r join bleeds b on b.request_id = r.id
        where r.nurse_id = u.id and b.closed_at is null and b.cancelled_at is null and b.captured_at is null) as open_requests,
      (select count(*)::int from bleeds b join bleed_requests r on r.id = b.request_id
        where r.nurse_id = u.id and b.released_at is not null and b.filed_at is null and b.closed_at is null) as reports_to_file,
      last.at as last_at, last.hospital_id as last_hospital_id, h.name as last_hospital, h.lat as last_lat, h.lng as last_lng
    from users u join departments d on d.id = u.department_id
    left join lateral (
      select at, hospital_id from (
        select r.arrived_at as at, r.hospital_id from bleed_requests r where r.arrived_by = u.id and r.arrived_at is not null
        union all
        select b.filed_at, r.hospital_id from bleeds b join bleed_requests r on r.id = b.request_id where b.filed_by = u.id and b.filed_at is not null
      ) x order by at desc limit 1
    ) last on true
    left join organisations h on h.id = last.hospital_id
    where d.code = 'NUR' and u.role = 'dept_responder' and u.active
    order by u.name`;
}

export function dispatchRoutes(app: FastifyInstance) {
  app.get('/api/dispatch', async (req) => {
    requirePerm(req, 'bleed.open');
    const { hospital_id } = z.object({ hospital_id: z.coerce.number().int() }).parse(req.query);
    const [target] = await sql`select id, name, lat, lng, nurse_id from organisations where id = ${hospital_id} and kind = 'hospital'`;
    if (!target) fail(404, 'Hospital not found');
    const recent = (at: Date | null) => at && Date.now() - new Date(at).getTime() < 8 * 3_600_000;
    return (await nurses())
      .map((n) => {
        const km = recent(n.last_at) && n.last_lat != null && target.lat != null ? distanceM({ lat: n.last_lat, lng: n.last_lng }, { lat: target.lat, lng: target.lng }) / 1000 : null;
        const allocated = n.id === target.nurse_id;
        const reasons: string[] = [];
        if (allocated) reasons.push(`Allocated to ${target.name}`);
        if (km != null) reasons.push(n.last_hospital_id === target.id ? `Last at this hospital` : `Last at ${n.last_hospital} · ${km < 1 ? '<1' : Math.round(km)} km away`);
        reasons.push(n.open_requests ? `${n.open_requests} open request${n.open_requests > 1 ? 's' : ''}` : 'No open requests');
        if (n.reports_to_file) reasons.push(`${n.reports_to_file} report${n.reports_to_file > 1 ? 's' : ''} to file`);
        // Lower is better: workload dominates, then distance (unknown ≈ 30 km), allocation is a tie-breaker bonus.
        const score = n.open_requests * 60 + n.reports_to_file * 15 + (km ?? 30) - (allocated ? 20 : 0);
        return { id: n.id, name: n.name, allocated, km, last_at: n.last_at, last_hospital: n.last_hospital, open_requests: n.open_requests, reports_to_file: n.reports_to_file, score, reasons };
      })
      .sort((a, b) => a.score - b.score)
      .map((n, i) => ({ ...n, suggested: i === 0 }));
  });

  // Every nurse's live run (brief §6.6: several hospitals on one trip).
  app.get('/api/dispatch/runs', async (req) => {
    requirePerm(req, 'dashboard.view');
    const cfg = await bleedConfig(sql);
    const [people, bleeds] = await Promise.all([
      nurses(),
      sql`select b.*, r.nurse_id, r.number as request_number, r.id as request_id, h.name as hospital from bleeds b
        join bleed_requests r on r.id = b.request_id join organisations h on h.id = r.hospital_id
        where b.closed_at is null and b.cancelled_at is null and b.filed_at is null and coalesce(b.outcome, 'successful') = 'successful'
          and (b.captured_at is null or b.released_at is not null)
        order by b.opened_at`,
    ]);
    const rank = { green: 0, amber: 1, red: 2 } as const;
    const stops = (nurseId: string | null) => {
      const byReq = new Map<string, any>();
      for (const b of bleeds.filter((x) => x.nurse_id === nurseId)) {
        const iv = bleedIntervals(b, cfg.limits, new Date(), cfg.th);
        const s = byReq.get(b.request_id) ?? { id: b.request_id, number: b.request_number, hospital: b.hospital, first_bleed: b.id, opened_at: b.opened_at, patients: 0, to_bleed: 0, to_file: 0, arrived: !!b.arrived_at, flag: 'green' };
        s.patients++;
        if (!b.captured_at) s.to_bleed++;
        if (b.released_at) s.to_file++;
        if (rank[iv.flag] > rank[s.flag as keyof typeof rank]) s.flag = iv.flag;
        byReq.set(b.request_id, s);
      }
      return [...byReq.values()];
    };
    return {
      nurses: people.map((n) => ({ id: n.id, name: n.name, last_at: n.last_at, last_hospital: n.last_hospital, stops: stops(n.id) })),
      unallocated: stops(null),
    };
  });
}
