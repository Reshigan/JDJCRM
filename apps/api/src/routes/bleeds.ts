// Module B — hospital bleed tickets (brief §6).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  bleedIntervals, bleedState, can, CHECKPOINTS, DEFAULT_BLEED_LIMITS, DEFAULT_THRESHOLDS, distanceM, INTERVALS, OUTCOMES,
  sastYearMonth, type Checkpoint,
} from '@baton/core';
import { requirePerm } from '../auth';
import { audit, fail, sql, type Sql } from '../db';
import { decryptFile, encryptFile } from '../crypto';
import { env } from '../env';
import { notify } from '../notify';

const text = (max = 2000) => z.string().trim().min(1).max(max);
const opt = (max = 200) => z.string().trim().max(max).optional().transform((v) => v || null);
const Geo = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100_000), override_reason: opt(1000), device_time: z.string().max(40).optional(), breach_reason: opt(1000) };

export async function bleedConfig(db: Sql) {
  const rows = await db`select key, value from settings where key in ('bleed_limits', 'escalation_thresholds')`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return { limits: (get('bleed_limits') ?? DEFAULT_BLEED_LIMITS) as number[], th: (get('escalation_thresholds') ?? DEFAULT_THRESHOLDS) as [number, number, number] };
}

/** Offline devices report when the action happened. Trust it within bounds; flag late syncs. */
function stamp(device: string | undefined, floor: Date | string | null) {
  const now = Date.now();
  let t = device ? new Date(device).getTime() : now;
  if (!Number.isFinite(t) || t > now + 120_000 || t < now - 72 * 3_600_000) t = now;
  if (floor && t < new Date(floor).getTime()) t = new Date(floor).getTime();
  return { at: new Date(t), late: now - t > 5 * 60_000 };
}

/** Completing interval k after its limit needs a reason (brief §6.5). */
function breachGate(b: any, k: number, at: Date, cfg: { limits: number[]; th: number[] }, reason: string | null) {
  const start = b[CHECKPOINTS[k]];
  const pct = ((at.getTime() - new Date(start).getTime()) / 60_000 / cfg.limits[k]) * 100;
  const reasons = { ...(b.breach_reasons ?? {}) };
  if (pct >= cfg.th[1]) {
    if (!reason && !reasons[k]) fail(422, `${INTERVALS[k].label} time exceeded — a breach reason is required`);
    if (reason) reasons[k] = reason;
  }
  return reasons;
}

async function deptCode(req: FastifyRequest) {
  if (!req.user.department_id) return null;
  const [d] = await sql`select code from departments where id = ${req.user.department_id}`;
  return (d?.code as string) ?? null;
}

/** Who may see this bleed: CS + management all; nursing their own (managers all); PRE/ANA from their stage onward. */
function visible(req: FastifyRequest, code: string | null, b: any) {
  if (can(req.user.role, 'tickets.view_all')) return true;
  if (code === 'NUR') return req.user.role === 'dept_manager' || b.nurse_id === req.user.id;
  if (code === 'PRE') return !!b.captured_at && b.outcome === 'successful';
  if (code === 'ANA') return !!b.received_at;
  return false;
}

const BASE = sql`
  select b.*, r.number as request_number, r.hospital_id, r.nurse_id, r.requested_by, r.contact_phone, r.notes, r.site_id,
    r.arrive_distance_m, r.arrive_override, r.arrive_accuracy_m, h.name as hospital, h.lat as hospital_lat, h.lng as hospital_lng,
    h.radius_m, n.name as nurse
  from bleeds b join bleed_requests r on r.id = b.request_id join organisations h on h.id = r.hospital_id
  left join users n on n.id = r.nurse_id`;

async function loadBleed(db: Sql, id: string, lock = false) {
  if (lock) await db`select 1 from bleeds where id = ${id} for update`;
  const [b] = await db`${BASE} where b.id = ${id}`;
  return b ?? fail(404, 'Bleed not found');
}

const decorate = (b: any, cfg: { limits: number[]; th: [number, number, number] }) => ({
  ...b,
  state: bleedState(b),
  ...bleedIntervals(b, cfg.limits, new Date(), cfg.th),
  geo_exception: !!(b.arrive_override || b.file_override),
});

async function nextNumber(db: Sql, kind: 'HBR' | 'BLD') {
  const prefix = `${kind}-${sastYearMonth(new Date())}`;
  const [{ n }] = await db`insert into counters values (${prefix}, 1) on conflict (prefix) do update set n = counters.n + 1 returning n`;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

function checkGeo(h: any, g: { lat: number; lng: number; override_reason: string | null }) {
  const distance = h.lat != null && h.lng != null ? distanceM({ lat: h.lat, lng: h.lng }, g) : null;
  const inside = distance != null && distance <= (h.radius_m ?? 250);
  if (!inside && !g.override_reason)
    fail(422, distance == null ? `${h.name} has no GPS position registered — give a reason to continue` : `You are ${Math.round(distance)} m from ${h.name} (geofence ${h.radius_m} m). Move closer, or give a reason.`);
  return { distance, override: inside ? null : g.override_reason };
}

export function bleedRoutes(app: FastifyInstance) {
  // --- Client Services: open a request with one or more patients (brief §6.6 multiple patients on one call) ---
  app.post('/api/bleed-requests', async (req, reply) => {
    requirePerm(req, 'bleed.open');
    const b = z
      .object({
        hospital_id: z.number().int(),
        nurse_id: z.uuid().nullable().optional(),
        requested_by: text(200),
        contact_phone: opt(50),
        notes: opt(2000),
        patients: z.array(z.object({ patient_name: text(200), folder_no: opt(50), ward: opt(50), bed: opt(20) })).min(1).max(30),
      })
      .parse(req.body);
    const out = await sql.begin(async (tx) => {
      const [h] = await tx`select * from organisations where id = ${b.hospital_id} and kind = 'hospital' and active`;
      if (!h) fail(400, 'Choose a registered hospital');
      const nurse = b.nurse_id ?? h.nurse_id;
      const number = await nextNumber(tx, 'HBR');
      const [r] = await tx`insert into bleed_requests ${tx({ number, hospital_id: h.id, site_id: h.site_id, nurse_id: nurse, requested_by: b.requested_by, contact_phone: b.contact_phone, notes: b.notes, logged_by: req.user.id })} returning id, created_at`;
      const numbers: string[] = [];
      for (const p of b.patients) {
        const bn = await nextNumber(tx, 'BLD');
        numbers.push(bn);
        const [x] = await tx`insert into bleeds ${tx({ ...p, number: bn, request_id: r.id, opened_at: r.created_at })} returning id`;
        await audit(tx, { actor: req.user.id, action: 'bleed.opened', entity: 'bleed', id: x.id, data: { number: bn, request: number } });
      }
      await audit(tx, { actor: req.user.id, action: 'bleed.requested', entity: 'bleed_request', id: r.id, data: { number, hospital: h.name, patients: b.patients.length, nurse } });
      const msg = { link: `/field/r/${r.id}`, number, title: `Bleed request · ${h.name} · ${b.patients.length} patient${b.patients.length > 1 ? 's' : ''}`, body: `${b.requested_by}${b.notes ? ` — ${b.notes}` : ''}` };
      if (nurse) await notify(tx, { users: [nurse] }, msg);
      else await notify(tx, { departments: [(await tx`select id from departments where code = 'NUR'`)[0]?.id ?? 0], deptRoles: ['dept_manager'] }, { ...msg, title: `Unallocated ${msg.title}` });
      return { id: r.id, number, bleeds: numbers };
    });
    reply.code(201);
    return out;
  });

  // --- boards ---
  app.get('/api/bleeds', async (req) => {
    requirePerm(req, 'dashboard.view');
    const q = z.object({ scope: z.enum(['open', 'closed', 'all']).default('open'), q: z.string().trim().max(100).optional() }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const rows = await sql`${BASE}
      where ${q.scope === 'open' ? sql`b.closed_at is null` : q.scope === 'closed' ? sql`b.closed_at is not null` : sql`true`}
        and (${like}::text is null or b.number ilike ${like} or r.number ilike ${like} or b.patient_name ilike ${like}
             or b.requisition_no ilike ${like} or h.name ilike ${like})
      order by b.opened_at desc limit 500`;
    const cfg = await bleedConfig(sql);
    return rows.map((b) => decorate(b, cfg));
  });

  app.get('/api/bleeds/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = await loadBleed(sql, id);
    if (!visible(req, await deptCode(req), b)) fail(404, 'Bleed not found');
    const cfg = await bleedConfig(sql);
    const [photos, siblings, timeline, people] = await Promise.all([
      sql`select id, kind, size, created_at from bleed_photos where bleed_id = ${id} order by created_at`,
      sql`select id, number, patient_name, folder_no from bleeds where request_id = ${b.request_id} and id <> ${id} order by number`,
      sql`select l.id, l.at, l.action, l.data, u.name as actor from audit_log l left join users u on u.id = l.actor_id
          where (entity = 'bleed' and entity_id = ${id}) or (entity = 'bleed_request' and entity_id = ${b.request_id}) order by l.id`,
      sql`select id, name from users where id = any(${[b.captured_by, b.received_by, b.lab_accepted_by, b.released_by, b.filed_by, b.closed_by].filter(Boolean)}::uuid[])`,
    ]);
    const who = Object.fromEntries(people.map((p) => [p.id, p.name]));
    return { ...decorate(b, cfg), photos, siblings, timeline, who };
  });

  app.get('/api/bleed-photos/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [p] = await sql`select * from bleed_photos where id = ${id}`;
    if (!p) fail(404, 'Not found');
    const b = await loadBleed(sql, p.bleed_id);
    if (!visible(req, await deptCode(req), b)) fail(404, 'Not found');
    const data = decryptFile(readFileSync(`${env.dataDir}/blobs/${id}`), p.key_wrapped);
    await audit(sql, { actor: req.user.id, action: 'photo.viewed', entity: 'bleed', id: p.bleed_id, data: { kind: p.kind }, ip: req.ip });
    reply.header('content-type', p.mime).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store');
    return data;
  });

  // --- nurse: my run (brief §6.6 multiple hospitals on one trip: each request timed on its own) ---
  app.get('/api/field', async (req) => {
    const code = await deptCode(req);
    if (code !== 'NUR') fail(403, 'The field app is for nursing staff');
    const mgr = req.user.role === 'dept_manager';
    const rows = await sql`${BASE}
      where b.closed_at is null and b.cancelled_at is null and b.filed_at is null
        and coalesce(b.outcome, 'successful') = 'successful'
        and (${mgr} or r.nurse_id = ${req.user.id})
        and (b.captured_at is null or b.released_at is not null)
      order by b.opened_at`;
    const cfg = await bleedConfig(sql);
    const byReq = new Map<string, any>();
    for (const b of rows) {
      const r = byReq.get(b.request_id) ?? { id: b.request_id, number: b.request_number, hospital: b.hospital, hospital_lat: b.hospital_lat, hospital_lng: b.hospital_lng, radius_m: b.radius_m, requested_by: b.requested_by, contact_phone: b.contact_phone, notes: b.notes, arrived: !!b.arrived_at, bleeds: [] };
      r.bleeds.push(decorate(b, cfg));
      byReq.set(b.request_id, r);
    }
    return [...byReq.values()];
  });

  app.post('/api/bleed-requests/:id/arrive', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const g = z.object(Geo).parse(req.body);
    if ((await deptCode(req)) !== 'NUR') fail(403, 'Only nursing confirms arrival');
    return sql.begin(async (tx) => {
      const [r] = await tx`select r.*, h.name, h.lat, h.lng, h.radius_m from bleed_requests r join organisations h on h.id = r.hospital_id where r.id = ${id} for update of r`;
      if (!r) fail(404, 'Request not found');
      if (r.nurse_id !== req.user.id && req.user.role !== 'dept_manager') fail(403, 'This request is allocated to another nurse');
      if (r.arrived_at) return { ok: true, already: true }; // idempotent for offline replays
      const geo = checkGeo(r, g);
      const { at, late } = stamp(g.device_time, r.created_at);
      const cfg = await bleedConfig(tx);
      const open = await tx`select * from bleeds where request_id = ${id} and cancelled_at is null and arrived_at is null`;
      for (const b of open) {
        const reasons = breachGate(b, 0, at, cfg, g.breach_reason);
        await tx`update bleeds set arrived_at = ${at}, breach_reasons = ${tx.json(reasons)}, offline_sync = offline_sync or ${late} where id = ${b.id}`;
      }
      await tx`update bleed_requests set arrived_at = ${at}, arrived_by = ${req.user.id}, arrive_lat = ${g.lat}, arrive_lng = ${g.lng},
        arrive_accuracy_m = ${g.accuracy}, arrive_distance_m = ${geo.distance}, arrive_override = ${geo.override} where id = ${id}`;
      await audit(tx, { actor: req.user.id, action: 'bleed.arrived', entity: 'bleed_request', id, ip: req.ip,
        data: { distance_m: geo.distance && Math.round(geo.distance), accuracy_m: Math.round(g.accuracy), override: geo.override, late } });
      if (geo.override)
        await notify(tx, { roles: ['cs_supervisor'] }, { link: `/bleeds/${open[0]?.id}`, number: r.number, title: `Geolocation exception · arrival at ${r.name}`, body: geo.override });
      return { ok: true };
    });
  });

  app.post('/api/bleeds/:id/capture', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if ((await deptCode(req)) !== 'NUR') fail(403, 'Only nursing captures the bleed');
    const fields: Record<string, string> = {};
    const files: Record<string, { data: Buffer; mime: string }> = {};
    for await (const part of req.parts({ limits: { fileSize: 15 * 1024 * 1024, files: 2 } })) {
      if (part.type === 'file') {
        if (!['requisition', 'sticker'].includes(part.fieldname) || !part.mimetype.startsWith('image/')) fail(400, 'Photos must be images');
        files[part.fieldname] = { data: await part.toBuffer(), mime: part.mimetype };
      } else fields[part.fieldname] = String(part.value);
    }
    const f = z
      .object({
        outcome: z.enum(Object.keys(OUTCOMES) as [string, ...string[]]),
        outcome_reason: opt(1000),
        patient_name: opt(200),
        folder_no: opt(50),
        ward: opt(50),
        bed: opt(20),
        requisition_no: opt(50),
        tubes: z.string().max(2000).optional().transform((v) => z.array(z.object({ type: text(40), count: z.number().int().min(1).max(20) })).max(12).parse(JSON.parse(v || '[]'))),
        device_time: z.string().max(40).optional(),
        breach_reason: opt(1000),
      })
      .parse(fields);
    const ok = f.outcome === 'successful';
    if (ok) {
      if (!files.requisition || !files.sticker) fail(422, 'Both photographs are required: requisition number and hospital sticker');
      if (!f.patient_name || !f.folder_no || !f.ward || !f.bed) fail(422, 'Sticker details are required: patient name, folder number, ward and bed');
      if (!f.tubes.length) fail(422, 'Record the tubes drawn');
    } else if (!f.outcome_reason) fail(422, 'Give the reason the bleed was not successful');

    return sql.begin(async (tx) => {
      const b = await loadBleed(tx, id, true);
      if (b.nurse_id !== req.user.id && req.user.role !== 'dept_manager') fail(403, 'This bleed is allocated to another nurse');
      if (b.captured_at || b.outcome) return { ok: true, already: true };
      if (!b.arrived_at) fail(409, 'Confirm arrival first');
      if (b.cancelled_at) fail(409, 'Bleed was cancelled');
      const cfg = await bleedConfig(tx);
      const { at, late } = stamp(f.device_time, b.arrived_at);
      const reasons = ok ? breachGate(b, 1, at, cfg, f.breach_reason) : b.breach_reasons;
      mkdirSync(`${env.dataDir}/blobs`, { recursive: true });
      for (const [kind, file] of Object.entries(files)) {
        const { blob, keyWrapped } = encryptFile(file.data);
        const [p] = await tx`insert into bleed_photos (bleed_id, kind, mime, size, key_wrapped, uploaded_by)
          values (${id}, ${kind}, ${file.mime}, ${file.data.length}, ${keyWrapped}, ${req.user.id}) returning id`;
        writeFileSync(`${env.dataDir}/blobs/${p.id}`, blob);
      }
      await tx`update bleeds set outcome = ${f.outcome}, outcome_reason = ${f.outcome_reason},
        patient_name = coalesce(${f.patient_name}, patient_name), folder_no = coalesce(${f.folder_no}, folder_no),
        ward = coalesce(${f.ward}, ward), bed = coalesce(${f.bed}, bed), requisition_no = ${f.requisition_no}, tubes = ${tx.json(f.tubes)},
        captured_at = ${at}, captured_by = ${req.user.id},
        breach_reasons = ${tx.json(reasons)}, offline_sync = offline_sync or ${late} where id = ${id}`;
      await audit(tx, { actor: req.user.id, action: ok ? 'bleed.captured' : 'bleed.unsuccessful', entity: 'bleed', id, ip: req.ip,
        data: { outcome: f.outcome, reason: f.outcome_reason, tubes: f.tubes.reduce((s, t) => s + t.count, 0), late } });
      if (!ok)
        await notify(tx, { roles: ['cs_agent', 'cs_supervisor'] }, { link: `/bleeds/${id}`, number: b.number, title: `Unsuccessful bleed · ${OUTCOMES[f.outcome as keyof typeof OUTCOMES]} — close required`, body: f.outcome_reason ?? undefined });
      return { ok: true };
    });
  });

  // Pre-Analytical accepts, lab accepts, lab releases (manual until the LIS interface exists).
  const STEPS = {
    receive: { dept: 'PRE', cp: 'received_at' as Checkpoint, by: 'received_by', k: 2, label: 'Accepted into Pre-Analytical' },
    lab_accept: { dept: 'ANA', cp: 'lab_accepted_at' as Checkpoint, by: 'lab_accepted_by', k: 3, label: 'Accepted into laboratory' },
    release: { dept: 'ANA', cp: 'released_at' as Checkpoint, by: 'released_by', k: 4, label: 'All results released' },
  };
  app.post('/api/bleeds/:id/step', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { step, breach_reason } = z.object({ step: z.enum(['receive', 'lab_accept', 'release']), breach_reason: opt(1000) }).parse(req.body);
    const s = STEPS[step];
    if ((await deptCode(req)) !== s.dept) fail(403, `Only ${s.dept === 'PRE' ? 'Pre-Analytical' : 'Analytical'} can do this`);
    return sql.begin(async (tx) => {
      const b = await loadBleed(tx, id, true);
      const prev = b[CHECKPOINTS[s.k]];
      if (b.cancelled_at || b.closed_at || b.outcome !== 'successful') fail(409, 'Bleed is no longer active');
      if (b[s.cp]) fail(409, 'Already recorded');
      if (!prev) fail(409, 'The previous stage is not complete');
      const at = new Date();
      const reasons = breachGate(b, s.k, at, await bleedConfig(tx), breach_reason);
      await tx`update bleeds set ${tx({ [s.cp]: at, [s.by]: req.user.id, breach_reasons: tx.json(reasons) })} where id = ${id}`;
      await audit(tx, { actor: req.user.id, action: `bleed.${step}`, entity: 'bleed', id, ip: req.ip, data: { breach_reason } });
      if (step === 'release' && b.nurse_id)
        await notify(tx, { users: [b.nurse_id] }, { link: `/field/r/${b.request_id}`, number: b.number, title: `Report ready · file at ${b.hospital}`, body: `Reporting clock is running for ${b.number}.` });
      return { ok: true };
    });
  });

  app.post('/api/bleeds/file', async (req) => {
    const g = z.object({ ...Geo, bleed_ids: z.array(z.uuid()).min(1).max(30) }).parse(req.body);
    if ((await deptCode(req)) !== 'NUR') fail(403, 'Only nursing files reports');
    return sql.begin(async (tx) => {
      const cfg = await bleedConfig(tx);
      let geo: ReturnType<typeof checkGeo> | null = null;
      for (const id of g.bleed_ids) {
        const b = await loadBleed(tx, id, true);
        if (b.nurse_id !== req.user.id && req.user.role !== 'dept_manager') fail(403, 'Allocated to another nurse');
        if (b.filed_at) continue;
        if (!b.released_at) fail(409, `${b.number}: results not released yet`);
        geo ??= checkGeo({ name: b.hospital, lat: b.hospital_lat, lng: b.hospital_lng, radius_m: b.radius_m }, g);
        const { at, late } = stamp(g.device_time, b.released_at);
        const reasons = breachGate(b, 5, at, cfg, g.breach_reason);
        await tx`update bleeds set filed_at = ${at}, filed_by = ${req.user.id}, file_lat = ${g.lat}, file_lng = ${g.lng}, file_accuracy_m = ${g.accuracy},
          file_distance_m = ${geo.distance}, file_override = ${geo.override}, breach_reasons = ${tx.json(reasons)}, offline_sync = offline_sync or ${late} where id = ${id}`;
        await audit(tx, { actor: req.user.id, action: 'bleed.filed', entity: 'bleed', id, ip: req.ip,
          data: { distance_m: geo.distance && Math.round(geo.distance), override: geo.override, late } });
        if (geo.override)
          await notify(tx, { roles: ['cs_supervisor'] }, { link: `/bleeds/${id}`, number: b.number, title: `Geolocation exception · report filing at ${b.hospital}`, body: geo.override });
      }
      return { ok: true };
    });
  });

  // --- Client Services controls ---
  app.post('/api/bleeds/:id/cancel', async (req) => {
    requirePerm(req, 'bleed.open');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { reason } = z.object({ reason: text() }).parse(req.body);
    await sql.begin(async (tx) => {
      const b = await loadBleed(tx, id, true);
      if (b.closed_at || b.cancelled_at || b.filed_at) fail(409, 'Bleed has already ended');
      // Cancelled: closed with reason; travel time kept; excluded from turnaround statistics (brief §6.6).
      await tx`update bleeds set cancelled_at = now(), cancel_reason = ${reason}, closed_at = now(), closed_by = ${req.user.id} where id = ${id}`;
      await audit(tx, { actor: req.user.id, action: 'bleed.cancelled', entity: 'bleed', id, ip: req.ip, data: { reason } });
      if (b.nurse_id && !b.captured_at)
        await notify(tx, { users: [b.nurse_id] }, { link: `/field`, number: b.number, title: `Cancelled · ${b.hospital}`, body: reason });
    });
    return { ok: true };
  });

  app.post('/api/bleeds/:id/close', async (req) => {
    requirePerm(req, 'bleed.close');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await sql.begin(async (tx) => {
      const b = await loadBleed(tx, id, true);
      if (b.closed_at) fail(409, 'Already closed');
      await tx`update bleeds set closed_at = now(), closed_by = ${req.user.id} where id = ${id}`;
      await audit(tx, { actor: req.user.id, action: 'bleed.closed', entity: 'bleed', id, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/api/bleed-requests/:id/nurse', async (req) => {
    requirePerm(req, 'bleed.open');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ nurse_id: z.uuid(), reason: text() }).parse(req.body);
    await sql.begin(async (tx) => {
      const [n] = await tx`select u.id, u.name from users u join departments d on d.id = u.department_id where u.id = ${b.nurse_id} and d.code = 'NUR' and u.active`;
      if (!n) fail(400, 'Choose an active nursing user');
      const [r] = await tx`update bleed_requests set nurse_id = ${n.id} where id = ${id} and arrived_at is null returning number`;
      if (!r) fail(409, 'The nurse has already arrived');
      await audit(tx, { actor: req.user.id, action: 'bleed.nurse_changed', entity: 'bleed_request', id, data: { nurse: n.name, reason: b.reason } });
      await notify(tx, { users: [n.id] }, { link: `/field/r/${id}`, number: r.number, title: `Bleed request reassigned to you`, body: b.reason });
    });
    return { ok: true };
  });

  // --- Pre-Analytical / Laboratory sample desk ---
  app.get('/api/samples', async (req) => {
    const code = await deptCode(req);
    if (code !== 'PRE' && code !== 'ANA') fail(403, 'The sample desk is for Pre-Analytical and the laboratory');
    const { q } = z.object({ q: z.string().trim().max(60).optional() }).parse(req.query);
    const cfg = await bleedConfig(sql);
    const rows = q
      ? await sql`${BASE} where (b.number ilike ${q} or b.requisition_no ilike ${q}) and b.closed_at is null`
      : code === 'PRE'
        ? await sql`${BASE} where b.captured_at is not null and b.outcome = 'successful' and b.lab_accepted_at is null and b.cancelled_at is null order by b.captured_at`
        : await sql`${BASE} where b.received_at is not null and b.released_at is null and b.cancelled_at is null order by b.received_at`;
    return rows.filter((b) => visible(req, code, b)).map((b) => {
      const d = decorate(b, cfg);
      return { id: d.id, number: d.number, requisition_no: d.requisition_no, patient: d.patient_name, folder_no: d.folder_no, hospital: d.hospital, tubes: d.tubes, state: d.state, current: d.current, flag: d.flag, intervals: d.intervals };
    });
  });
}
