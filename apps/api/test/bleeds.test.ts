// Module B end-to-end against a real Postgres (TEST_DATABASE_URL).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

const HOSPITAL = { lat: -25.7479, lng: 28.2293 }; // Demo General Hospital, 300 m geofence
const FAR = { lat: -25.7479, lng: 28.2793 }; // ~5 km east

function multipart(fields: Record<string, string>, files: Record<string, Buffer> = {}) {
  const B = 'batonboundary';
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const [k, v] of Object.entries(files))
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"; filename="${k}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), v, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${B}--\r\n`));
  return { payload: Buffer.concat(parts as Uint8Array[]), headers: { 'content-type': `multipart/form-data; boundary=${B}` } };
}

describe.skipIf(!url)('hospital bleed lifecycle (API + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  const { bleedEscalationTick } = await import('../src/escalation');
  let app: Awaited<ReturnType<typeof buildApp>>;
  const jar: Record<string, string> = {};
  const as = (who: string) => ({
    get: (u: string) => app.inject({ method: 'GET', url: u, headers: { cookie: jar[who] } }),
    post: (u: string, payload: object = {}) => app.inject({ method: 'POST', url: u, payload, headers: { cookie: jar[who] } }),
    form: (u: string, f: Record<string, string>, files?: Record<string, Buffer>) => {
      const m = multipart(f, files);
      return app.inject({ method: 'POST', url: u, payload: m.payload, headers: { ...m.headers, cookie: jar[who] } });
    },
  });

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    app = await buildApp();
    for (const [who, email] of Object.entries({ cs: 'agent', nurse: 'nursing', nurse2: 'nurse2', pre: 'preanalytical', ana: 'analytical' })) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${email}@baton.local`, password: 'Baton!demo2026' } });
      jar[who] = String(r.headers['set-cookie']).split(';')[0];
    }
  });
  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  let req = '';
  let b1 = '';
  let b2 = '';
  let hospitalId = 0;

  it('only Client Services opens a request; one call can carry several patients, each its own ticket', async () => {
    const lk = (await as('cs').get('/api/lookups')).json();
    hospitalId = lk.organisations.find((o: any) => o.name === 'Demo General Hospital').id;
    const body = { hospital_id: hospitalId, requested_by: 'Sister, Ward 4B', patients: [{ patient_name: 'Maria Smith', ward: '4B', bed: '12' }, { patient_name: 'John Dube' }] };
    expect((await as('nurse').post('/api/bleed-requests', body)).statusCode).toBe(403);
    const r = await as('cs').post('/api/bleed-requests', body);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().number).toMatch(/^HBR-\d{6}-0001$/);
    expect(r.json().bleeds).toHaveLength(2);
    req = r.json().id;
    const field = (await as('nurse').get('/api/field')).json();
    expect(field).toHaveLength(1);
    [b1, b2] = field[0].bleeds.map((b: any) => b.id);
    expect((await as('nurse2').get('/api/field')).json()).toHaveLength(0); // allocated to the hospital's nurse only
  });

  it('arrival is blocked outside the geofence unless a reason is given; replays are idempotent', async () => {
    const far = await as('nurse').post(`/api/bleed-requests/${req}/arrive`, { ...FAR, accuracy: 10 });
    expect(far.statusCode).toBe(422);
    expect(far.json().error).toMatch(/m from Demo General Hospital/);
    expect((await as('nurse2').post(`/api/bleed-requests/${req}/arrive`, { ...HOSPITAL, accuracy: 10 })).statusCode).toBe(403);
    expect((await as('nurse').post(`/api/bleed-requests/${req}/arrive`, { ...HOSPITAL, accuracy: 12 })).statusCode).toBe(200);
    expect((await as('nurse').post(`/api/bleed-requests/${req}/arrive`, { ...HOSPITAL, accuracy: 12 })).json().already).toBe(true);
  });

  it('interval 2 cannot complete without both photographs and the sticker details; photos are encrypted', async () => {
    const fields = { outcome: 'successful', patient_name: 'Maria Smith', folder_no: 'F-77812', ward: '4B', bed: '12', requisition_no: 'RQ-100', tubes: JSON.stringify([{ type: 'EDTA (purple)', count: 2 }]) };
    expect((await as('nurse').form(`/api/bleeds/${b1}/capture`, fields)).statusCode).toBe(422);
    const img = Buffer.from('FAKEJPEG-PATIENT-IDENTIFIABLE');
    const ok = await as('nurse').form(`/api/bleeds/${b1}/capture`, fields, { requisition: img, sticker: img });
    expect(ok.statusCode, ok.body).toBe(200);
    const [p] = await sql`select id from bleed_photos where bleed_id = ${b1} limit 1`;
    expect(readFileSync(`${process.env.DATA_DIR}/blobs/${p.id}`).toString()).not.toContain('PATIENT');
    const view = await as('cs').get(`/api/bleed-photos/${p.id}`);
    expect(view.body).toContain('FAKEJPEG');
  });

  it('an unsuccessful bleed ends with a reason and awaits Client Services closure', async () => {
    expect((await as('nurse').form(`/api/bleeds/${b2}/capture`, { outcome: 'patient_refused' })).statusCode).toBe(422);
    expect((await as('nurse').form(`/api/bleeds/${b2}/capture`, { outcome: 'patient_refused', outcome_reason: 'Refused consent' })).statusCode).toBe(200);
    const d = (await as('cs').get(`/api/bleeds/${b2}`)).json();
    expect(d.state).toBe('unsuccessful');
    expect(d.current).toBeNull();
    expect((await as('nurse').post(`/api/bleeds/${b2}/close`)).statusCode).toBe(403);
    expect((await as('cs').post(`/api/bleeds/${b2}/close`)).statusCode).toBe(200);
  });

  it('each lab stage is recorded only by its owning department, in order', async () => {
    expect((await as('ana').post(`/api/bleeds/${b1}/step`, { step: 'lab_accept' })).statusCode).toBe(409);
    expect((await as('ana').post(`/api/bleeds/${b1}/step`, { step: 'receive' })).statusCode).toBe(403);
    expect((await as('pre').post(`/api/bleeds/${b1}/step`, { step: 'receive' })).statusCode).toBe(200);
    expect((await as('pre').get('/api/samples?q=RQ-100')).json()[0].state).toBe('receiving');
    expect((await as('ana').post(`/api/bleeds/${b1}/step`, { step: 'lab_accept' })).statusCode).toBe(200);
    expect((await as('ana').post(`/api/bleeds/${b1}/step`, { step: 'release' })).statusCode).toBe(200);
    expect((await as('nurse').get('/api/field')).json()[0].bleeds[0].state).toBe('reporting');
  });

  it('filing is geofenced; a late report needs a breach reason; an override is a geolocation exception', async () => {
    await sql`update bleeds set released_at = now() - interval '3 hours' where id = ${b1}`;
    const body = { bleed_ids: [b1], ...FAR, accuracy: 900, override_reason: 'Hospital campus, GPS drift' };
    const late = await as('nurse').post('/api/bleeds/file', body);
    expect(late.statusCode).toBe(422);
    expect(late.json().error).toMatch(/Reporting time exceeded/);
    expect((await as('nurse').post('/api/bleeds/file', { ...body, breach_reason: 'Waited for ward clerk' })).statusCode).toBe(200);
    const d = (await as('cs').get(`/api/bleeds/${b1}`)).json();
    expect(d.state).toBe('filed');
    expect(d.geo_exception).toBe(true);
    expect(d.flag).toBe('red');
    expect(d.breach_reasons['5']).toBe('Waited for ward clerk');
    expect(d.total).toBeGreaterThan(0);
    expect((await as('cs').post(`/api/bleeds/${b1}/close`)).statusCode).toBe(200);
  });

  it('offline check-ins keep the device time and are flagged; cancellation closes and stops clocks', async () => {
    const r = (await as('cs').post('/api/bleed-requests', { hospital_id: hospitalId, requested_by: 'ICU', patients: [{ patient_name: 'A Patient' }] })).json();
    await sql`update bleed_requests set created_at = now() - interval '2 hours' where id = ${r.id}`;
    await sql`update bleeds set opened_at = now() - interval '2 hours' where request_id = ${r.id}`;
    expect(await bleedEscalationTick()).toBe(1);
    const device = new Date(Date.now() - 30 * 60_000).toISOString();
    const arrive = await as('nurse').post(`/api/bleed-requests/${r.id}/arrive`, { ...HOSPITAL, accuracy: 8, device_time: device });
    expect(arrive.statusCode).toBe(422); // response interval breached: reason required
    expect((await as('nurse').post(`/api/bleed-requests/${r.id}/arrive`, { ...HOSPITAL, accuracy: 8, device_time: device, breach_reason: 'Traffic' })).statusCode).toBe(200);
    const [b] = await sql`select id, arrived_at, offline_sync from bleeds where request_id = ${r.id}`;
    expect(b.offline_sync).toBe(true);
    expect(Math.abs(new Date(b.arrived_at).getTime() - new Date(device).getTime())).toBeLessThan(1000);
    expect((await as('cs').post(`/api/bleeds/${b.id}/cancel`, { reason: 'Patient discharged' })).statusCode).toBe(200);
    const d = (await as('cs').get(`/api/bleeds/${b.id}`)).json();
    expect(d.state).toBe('closed');
    expect(d.current).toBeNull();
  });

  it('closing an active bleed is impossible even via SQL; audit chain intact', async () => {
    const r = (await as('cs').post('/api/bleed-requests', { hospital_id: hospitalId, requested_by: 'ICU', patients: [{ patient_name: 'B Patient' }] })).json();
    const [agent] = await sql`select id from users where email = 'agent@baton.local'`;
    await expect(sql`update bleeds set closed_at = now(), closed_by = ${agent.id} where request_id = ${r.id}`).rejects.toThrow(/not ended/);
    const [{ broken }] = await sql`select audit_verify() as broken`;
    expect(broken).toBeNull();
  });
});
