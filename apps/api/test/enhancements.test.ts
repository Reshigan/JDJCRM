// Enhancements: worker heartbeat + watchdog, live stream, dispatch, LIS webhook + requisition check, photo sharpness.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';
process.env.LIS_WEBHOOK_SECRET = 'lis-test-secret';

describe.skipIf(!url)('enhancements (API + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  const { heartbeat, watchdog, status } = await import('../src/ops');
  const { sign } = await import('../src/routes/integrations');
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = '';
  let lis: Server;
  const jar: Record<string, string> = {};
  const req = (who: string | null, method: string, u: string, payload?: object) =>
    app.inject({ method: method as any, url: u, payload, headers: who ? { cookie: jar[who] } : {} });
  let hospital: any;

  const lisPost = (body: object, { ts = Math.floor(Date.now() / 1000), secret = 'lis-test-secret' } = {}) => {
    const raw = JSON.stringify(body);
    return app.inject({ method: 'POST', url: '/api/integrations/lis/events', payload: raw,
      headers: { 'content-type': 'application/json', 'x-baton-timestamp': String(ts), 'x-baton-signature': `sha256=${sign(secret, String(ts), raw)}` } });
  };
  /** A bleed captured successfully (checkpoints set directly), ready for the lab stages. */
  async function captured(requisition: string, minutesAgo = 5) {
    const r = (await req('cs', 'POST', '/api/bleed-requests', { hospital_id: hospital.id, requested_by: 'W', patients: [{ patient_name: 'Lab Patient' }] })).json();
    const t = (m: number) => new Date(Date.now() - m * 60_000);
    await sql`update bleeds set opened_at = ${t(minutesAgo + 20)}, arrived_at = ${t(minutesAgo + 10)}, captured_at = ${t(minutesAgo)},
      outcome = 'successful', requisition_no = ${requisition} where id = ${r.bleed_ids[0]}`;
    return r.bleed_ids[0] as string;
  }

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    for (const [who, email, pw] of [['cs', 'agent', 'Demo!crm2026'], ['nurse', 'nursing', 'Demo!crm2026'], ['ana', 'analytical', 'Demo!crm2026'], ['admin', 'admin', 'ChangeMe!2026'], ['pre', 'preanalytical', 'Demo!crm2026']]) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${email}@crm.local`, password: pw } });
      jar[who] = String(r.headers['set-cookie']).split(';')[0];
    }
    [hospital] = await sql`select * from organisations where name = 'Demo General Hospital'`;
    lis = createServer((rq, rs) => {
      const known = rq.url?.endsWith('/RQ-KNOWN');
      rs.writeHead(known ? 200 : 404, { 'content-type': 'application/json' }).end(known ? JSON.stringify({ patient_name: 'Maria  Smith' }) : '{}');
    }).listen(0);
    process.env.LIS_VALIDATE_URL = `http://127.0.0.1:${(lis.address() as any).port}/requisitions/{requisition}`;
  });
  afterAll(async () => {
    lis?.close();
    await app?.close();
    await sql.end();
  });

  it('worker heartbeat drives the status page; a stale worker alerts admins once per hour', async () => {
    await heartbeat({ escalated: 0 });
    let s = await status();
    expect(s.worker.healthy).toBe(true);
    expect(s.database.audit_intact).toBe(true);
    expect((await req('cs', 'GET', '/api/system/status')).statusCode).toBe(403);
    expect((await req('admin', 'GET', '/api/system/status')).json().worker.healthy).toBe(true);
    await sql`update settings set value = jsonb_set(value, '{at}', to_jsonb((now() - interval '10 minutes')::text)) where key = 'worker_heartbeat'`;
    s = await status();
    expect(s.worker.healthy).toBe(false);
    expect(await watchdog()).toBe(true);
    expect(await watchdog()).toBe(false); // claimed: no repeat within the hour
    const [{ n }] = await sql`select count(*)::int as n from notifications n join users u on u.id = n.user_id where u.role = 'admin' and n.title like 'Pelo CRM worker has stopped%'`;
    expect(n).toBe(1);
  });

  it('live stream pushes a change event (ids only) and a personal notification event', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { headers: { cookie: jar.nurse }, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    const read = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (text.includes('event: notification')) break; } })();
    await new Promise((r) => setTimeout(r, 300));
    await req('cs', 'POST', '/api/bleed-requests', { hospital_id: hospital.id, requested_by: 'W', nurse_id: (await sql`select id from users where email = 'nursing@crm.local'`)[0].id, patients: [{ patient_name: 'Streamed Patient' }] });
    await Promise.race([read, new Promise((r) => setTimeout(r, 3000))]);
    ctrl.abort();
    expect(text).toContain('event: change');
    expect(text).toContain('"entity":"bleed"');
    expect(text).toContain('event: notification');
    expect(text).not.toContain('Streamed Patient');
    expect((await fetch(`${base}/api/stream`)).status).toBe(401);
  });

  it('dispatch ranks by workload and distance, with reasons; runs show every nurse', async () => {
    const ranked = (await req('cs', 'GET', `/api/dispatch?hospital_id=${hospital.id}`)).json();
    expect(ranked[0].suggested).toBe(true);
    expect(ranked[0].name).toBe('Sister Zanele Nkosi'); // Sister Anne Botha already has open requests
    expect(ranked.find((n: any) => n.name === 'Sister Anne Botha').reasons.join(' ')).toMatch(/Allocated to Demo General Hospital.*open request/);
    expect(ranked.some((n: any) => 'last_lat' in n || 'lat' in n)).toBe(false); // no coordinates disclosed
    expect((await req('nurse', 'GET', `/api/dispatch?hospital_id=${hospital.id}`)).statusCode).toBe(403);
    const runs = (await req('cs', 'GET', '/api/dispatch/runs')).json();
    expect(runs.nurses.find((n: any) => n.name === 'Sister Anne Botha').stops.length).toBeGreaterThan(0);
  });

  it('LIS webhook: signed, timestamped, idempotent; records stages as the LIS; late stage leaves a pending reason', async () => {
    const id = await captured('RQ-LIS-1', 150); // logistics already 150 min — over the 120 min limit
    expect((await lisPost({ event_id: 'e0', event: 'sample_received', requisition_no: 'RQ-LIS-1' }, { secret: 'wrong' })).statusCode).toBe(401);
    expect((await lisPost({ event_id: 'e0', event: 'sample_received', requisition_no: 'RQ-LIS-1' }, { ts: Math.floor(Date.now() / 1000) - 900 })).statusCode).toBe(401);
    const early = (await lisPost({ event_id: 'e1', event: 'results_released', requisition_no: 'RQ-LIS-1' })).json();
    expect(early.ok).toBe(false);
    expect(early.error).toMatch(/previous stage/);
    const r = (await lisPost({ event_id: 'e2', event: 'sample_received', requisition_no: 'rq-lis-1' })).json();
    expect(r.ok).toBe(true);
    expect((await lisPost({ event_id: 'e2', event: 'sample_received', requisition_no: 'RQ-LIS-1' })).json().replay).toBe(true);
    const [b] = await sql`select received_at, received_by, breach_reasons from bleeds where id = ${id}`;
    expect(b.received_at).not.toBeNull();
    expect(b.received_by).toBeNull();
    expect(b.breach_reasons['2']).toMatch(/^Pending/);
    const [n] = await sql`select count(*)::int as n from notifications where title like 'Breach reason needed%'`;
    expect(n.n).toBe(1);
    // logistics is owned by Pre-Analytical (it ends when PRE accepts): the lab may not answer for it
    expect((await req('ana', 'POST', `/api/bleeds/${id}/breach-reason`, { interval: 2, reason: 'x' })).statusCode).toBe(403);
    expect((await req('pre', 'POST', `/api/bleeds/${id}/breach-reason`, { interval: 2, reason: 'Courier van breakdown' })).statusCode).toBe(200);
    expect((await sql`select breach_reasons from bleeds where id = ${id}`)[0].breach_reasons['2']).toBe('Courier van breakdown');
    const [{ c }] = await sql`select count(*)::int as c from audit_log where action = 'bleed.receive' and data->>'source' = 'LIS'`;
    expect(c).toBe(1);
  });

  it('requisition check discloses only found/unknown and whether the patient matches', async () => {
    const ok = (await req('cs', 'GET', '/api/integrations/requisition/RQ-KNOWN?patient=maria%20smith')).json();
    expect(ok).toEqual({ status: 'valid', patient_match: true });
    expect((await req('cs', 'GET', '/api/integrations/requisition/RQ-KNOWN?patient=John')).json().patient_match).toBe(false);
    expect((await req('cs', 'GET', '/api/integrations/requisition/RQ-NOPE')).json().status).toBe('unknown');
    expect((await req('admin', 'GET', '/api/integrations/requisition/RQ-KNOWN')).statusCode).toBe(403);
  });

  it('stores photo sharpness measured on the phone', async () => {
    const r = (await req('cs', 'POST', '/api/bleed-requests', { hospital_id: hospital.id, requested_by: 'W', nurse_id: (await sql`select id from users where email = 'nursing@crm.local'`)[0].id, patients: [{ patient_name: 'Sharp Patient' }] })).json();
    await req('nurse', 'POST', `/api/bleed-requests/${r.id}/arrive`, { lat: hospital.lat, lng: hospital.lng, accuracy: 5 });
    const B = 'b', f: Record<string, string> = { outcome: 'successful', patient_name: 'Sharp Patient', folder_no: 'F1', ward: '1', bed: '2', tubes: '[{"type":"EDTA (purple)","count":1}]', requisition_sharpness: '12', sticker_sharpness: '240' };
    const parts = Object.entries(f).map(([k, v]) => `--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')
      + ['requisition', 'sticker'].map((k) => `--${B}\r\nContent-Disposition: form-data; name="${k}"; filename="${k}.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n`).join('') + `--${B}--\r\n`;
    const res = await app.inject({ method: 'POST', url: `/api/bleeds/${r.bleed_ids[0]}/capture`, payload: parts, headers: { cookie: jar.nurse, 'content-type': `multipart/form-data; boundary=${B}` } });
    expect(res.statusCode, res.body).toBe(200);
    const photos = (await req('cs', 'GET', `/api/bleeds/${r.bleed_ids[0]}`)).json().photos;
    expect(Object.fromEntries(photos.map((p: any) => [p.kind, p.sharpness]))).toEqual({ requisition: 12, sticker: 240 });
  });
});
