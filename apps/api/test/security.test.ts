// Regression tests for the security review findings.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

describe.skipIf(!url)('security regressions (API + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  let app: Awaited<ReturnType<typeof buildApp>>;
  const jar: Record<string, string> = {};
  const req = (who: string | null, method: string, u: string, payload?: object) =>
    app.inject({ method: method as any, url: u, payload, headers: who ? { cookie: jar[who] } : {} });

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    app = await buildApp();
    for (const [who, email, pw] of [['cs', 'agent', 'Baton!demo2026'], ['pre', 'preanalytical', 'Baton!demo2026'], ['nurse', 'nursing', 'Baton!demo2026'], ['admin', 'admin', 'ChangeMe!2026']]) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${email}@baton.local`, password: pw } });
      jar[who] = String(r.headers['set-cookie']).split(';')[0];
    }
  });
  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  it('percent-encoded paths cannot skip the admin check or sign-in', async () => {
    const [me] = await sql`select id from users where email = 'preanalytical@baton.local'`;
    for (const path of ['/api/%61dmin/users', '/api/admin%2Fusers', '/api/Admin/users'])
      expect([403, 404]).toContain((await req('pre', 'GET', path)).statusCode);
    expect((await req('pre', 'PUT', `/api/%61dmin/users/${me.id}`, { role: 'admin' })).statusCode).toBe(403);
    const [still] = await sql`select role from users where id = ${me.id}`;
    expect(still.role).toBe('dept_responder');
    expect([401, 404]).toContain((await req(null, 'GET', '/%61pi/lookups')).statusCode);
    expect((await req(null, 'GET', '/api/lookups')).statusCode).toBe(401);
    expect((await req('admin', 'GET', '/api/%61dmin/users')).statusCode).toBe(200); // legit admin still works either way
  });

  it('admin and management can never be given department-scoped access', async () => {
    const [me] = await sql`select id from users where email = 'admin@baton.local'`;
    const [pre] = await sql`select id from departments where code = 'PRE'`;
    expect((await req('admin', 'PUT', `/api/admin/users/${me.id}`, { department_id: pre.id })).statusCode).toBe(400);
    expect((await req('admin', 'GET', '/api/tickets')).json()).toEqual([]);
  });

  it('Pre-Analytical sees only the bleed it holds, not the other patients on the request', async () => {
    const [h] = await sql`select id, lat, lng from organisations where name = 'Demo General Hospital'`;
    const r = (await req('cs', 'POST', '/api/bleed-requests', { hospital_id: h.id, requested_by: 'W', patients: [{ patient_name: 'Visible Person' }, { patient_name: 'Hidden Person' }] })).json();
    await req('nurse', 'POST', `/api/bleed-requests/${r.id}/arrive`, { lat: h.lat, lng: h.lng, accuracy: 5 });
    await sql`update bleeds set captured_at = now(), outcome = 'successful' where id = ${r.bleed_ids[0]}`;
    const d = (await req('pre', 'GET', `/api/bleeds/${r.bleed_ids[0]}`)).json();
    expect(d.siblings).toEqual([]);
    expect(JSON.stringify(d)).not.toContain('Hidden Person');
    expect((await req('pre', 'GET', `/api/bleeds/${r.bleed_ids[1]}`)).statusCode).toBe(404);
  });

  it('a closed bleed cannot be captured afterwards', async () => {
    const [h] = await sql`select id, lat, lng from organisations where name = 'Demo General Hospital'`;
    const r = (await req('cs', 'POST', '/api/bleed-requests', { hospital_id: h.id, requested_by: 'W', patients: [{ patient_name: 'X' }] })).json();
    await req('nurse', 'POST', `/api/bleed-requests/${r.id}/arrive`, { lat: h.lat, lng: h.lng, accuracy: 5 });
    await req('cs', 'POST', `/api/bleeds/${r.bleed_ids[0]}/cancel`, { reason: 'Discharged' });
    const B = 'b';
    const body = `--${B}\r\nContent-Disposition: form-data; name="outcome"\r\n\r\npatient_refused\r\n--${B}\r\nContent-Disposition: form-data; name="outcome_reason"\r\n\r\nx\r\n--${B}--\r\n`;
    const res = await app.inject({ method: 'POST', url: `/api/bleeds/${r.bleed_ids[0]}/capture`, payload: body, headers: { cookie: jar.nurse, 'content-type': `multipart/form-data; boundary=${B}` } });
    expect(res.statusCode).toBe(409);
  });

  it('repeated failed sign-ins from one address are throttled', async () => {
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await req(null, 'POST', '/api/auth/login', { username: `nobody${i}@x`, password: 'wrong' })).statusCode;
    expect(last).toBe(429);
  });
});
