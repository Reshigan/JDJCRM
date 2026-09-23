// LIS integration (brief §5.2 requisition validation, §6.2 "results released").
//  Inbound:  POST /api/integrations/lis/events — HMAC-SHA256 signed, timestamped, idempotent by event_id.
//  Outbound: GET  /api/integrations/requisition/:no — asks the LIS whether a requisition exists.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, fail, sql } from '../db';
import { applyStep, type Step } from './bleeds';

const secret = () => (process.env.LIS_WEBHOOK_SECRET_FILE ? readFileSync(process.env.LIS_WEBHOOK_SECRET_FILE, 'utf8').trim() : process.env.LIS_WEBHOOK_SECRET);
const EVENTS: Record<string, Step> = { sample_received: 'receive', lab_accepted: 'lab_accept', results_released: 'release' };

const Event = z.object({
  event_id: z.string().min(1).max(100),
  event: z.enum(Object.keys(EVENTS) as [string, ...string[]]),
  bleed_number: z.string().max(40).optional(),
  requisition_no: z.string().max(60).optional(),
  at: z.coerce.date().optional(),
  breach_reason: z.string().max(1000).optional(),
}).refine((e) => e.bleed_number || e.requisition_no, 'bleed_number or requisition_no is required');

/** Signature = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)); timestamp in Unix seconds, ±5 min. */
export const sign = (key: string, ts: string, body: string) => createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');

export async function integrationRoutes(app: FastifyInstance) {
  await app.register(async (lis) => {
    lis.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
    });

    lis.post('/api/integrations/lis/events', { config: { auth: 'public' } }, async (req) => {
      const key = secret();
      if (!key) fail(404, 'Not found');
      const ts = String(req.headers['x-baton-timestamp'] ?? '');
      const sig = String(req.headers['x-baton-signature'] ?? '').replace(/^sha256=/, '');
      const expected = sign(key!, ts, (req as any).rawBody ?? '');
      const ok = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) fail(401, 'Invalid signature');
      const e = Event.parse(req.body);

      const [seen] = await sql`select result from lis_events where event_id = ${e.event_id}`;
      if (seen) return { ...seen.result, replay: true };

      return sql.begin(async (tx) => {
        const [b] = await tx`select id, number from bleeds where closed_at is null and cancelled_at is null and outcome = 'successful'
          and (${e.bleed_number ?? null}::text is not null and number = ${e.bleed_number ?? null}
               or ${e.requisition_no ?? null}::text is not null and requisition_no ilike ${e.requisition_no ?? null})
          order by opened_at desc limit 1`;
        let result: object;
        if (!b) result = { ok: false, error: 'No active bleed matches' };
        else {
          try {
            result = { ...(await applyStep(tx, b.id, EVENTS[e.event], { actor: null, ip: req.ip, breach_reason: e.breach_reason, at: e.at, source: 'LIS' })), bleed: b.number };
          } catch (err: any) {
            result = { ok: false, bleed: b.number, error: err.message };
          }
        }
        await tx`insert into lis_events (event_id, payload, result) values (${e.event_id}, ${tx.json(e as any)}, ${tx.json(result as any)})`;
        await audit(tx, { actor: null, action: 'integration.lis_event', entity: 'integration', id: e.event_id, data: { event: e.event, ...result }, ip: req.ip });
        return result;
      });
    });
  });

  // Requisition check at intake and at the bleed. Discloses only found / not found and whether the patient matches.
  app.get('/api/integrations/requisition/:no', async (req) => {
    if (['admin', 'management'].includes(req.user.role)) fail(403, 'Not available for your role');
    const { no } = z.object({ no: z.string().trim().min(3).max(60) }).parse(req.params);
    const { patient } = z.object({ patient: z.string().trim().max(200).optional() }).parse(req.query);
    const url = process.env.LIS_VALIDATE_URL; // e.g. https://lis.jdj.local/api/requisitions/{requisition}
    if (!url) return { status: 'unavailable' };
    try {
      const r = await fetch(url.replace('{requisition}', encodeURIComponent(no)), {
        headers: process.env.LIS_TOKEN ? { authorization: `Bearer ${process.env.LIS_TOKEN}` } : undefined,
        signal: AbortSignal.timeout(3000),
      });
      if (r.status === 404) return { status: 'unknown' };
      if (!r.ok) return { status: 'unavailable' };
      const d = (await r.json().catch(() => ({}))) as { patient_name?: string };
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
      return { status: 'valid', patient_match: patient && d.patient_name ? norm(patient) === norm(d.patient_name) : null };
    } catch {
      return { status: 'unavailable' };
    }
  });
}
