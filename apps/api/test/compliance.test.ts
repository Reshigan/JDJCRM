// Phase 4 hardening: insights, GPS plausibility, read audit, POPIA subject export, retention, key rotation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
const MASTER = randomBytes(32);
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = MASTER.toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

describe.skipIf(!url)('hardening (API + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  const { retentionTick } = await import('../src/retention');
  const { encryptFile, decryptFile, rewrap } = await import('../src/crypto');
  let app: Awaited<ReturnType<typeof buildApp>>;
  const jar: Record<string, string> = {};
  const get = (who: string, u: string) => app.inject({ method: 'GET', url: u, headers: { cookie: jar[who] } });
  const post = (who: string, u: string, payload: object) => app.inject({ method: 'POST', url: u, payload, headers: { cookie: jar[who] } });
  let hospital: any, coastal: any, nurse: any;

  /** A complete bleed with the given interval minutes, opened `daysAgo`. */
  async function bleed(daysAgo: number, minutes: number[], nurseId = nurse.id) {
    const t0 = Date.now() - daysAgo * 86_400_000;
    const at = (k: number) => new Date(t0 + minutes.slice(0, k).reduce((s, x) => s + x, 0) * 60_000);
    const [r] = await sql`insert into bleed_requests (number, hospital_id, nurse_id, requested_by, logged_by, created_at, arrived_at)
      values (${'HBR-T-' + randomBytes(4).toString('hex')}, ${hospital.id}, ${nurseId}, 'Ward', ${nurseId}, ${at(0)}, ${at(1)}) returning id`;
    await sql`insert into bleeds (number, request_id, patient_name, outcome, opened_at, arrived_at, captured_at, received_at, lab_accepted_at, released_at, filed_at)
      values (${'BLD-T-' + randomBytes(4).toString('hex')}, ${r.id}, 'Test Patient', 'successful', ${at(0)}, ${at(1)}, ${at(2)}, ${at(3)}, ${at(4)}, ${at(5)}, ${at(6)})`;
  }

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    app = await buildApp();
    for (const [who, email] of Object.entries({ cs: 'agent', sup: 'supervisor', nurse: 'nursing', admin: 'admin' })) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${email}@crm.local`, password: who === 'admin' ? 'ChangeMe!2026' : 'Demo!crm2026' } });
      jar[who] = String(r.headers['set-cookie']).split(';')[0];
    }
    [hospital] = await sql`select * from organisations where name = 'Demo General Hospital'`;
    [coastal] = await sql`select * from organisations where name = 'Demo Coastal Hospital'`;
    [nurse] = await sql`select id from users where email = 'nursing@crm.local'`;
  });
  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  it('insights flag a stage drifting from its 4-week median, and repeat failures', async () => {
    for (const d of [10, 12, 15, 20, 25]) await bleed(d, [20, 15, 60, 20, 120, 40]); // baseline receiving 20m
    for (const d of [1, 2, 3, 4]) await bleed(d, [20, 15, 60, 50, 120, 40]); // this week receiving 50m
    const lk = (await get('cs', '/api/lookups')).json();
    const cat = lk.categories[0];
    for (let i = 0; i < 3; i++)
      await post('cs', '/api/tickets', { channel: 'telephone', complainant_type: 'doctor', complainant_name: 'Dr Repeat', organisation_id: hospital.id, contact_phone: '1', site_id: lk.sites[0].id, category_id: cat.id, priority: 'normal', description: 'again' });
    const ins = (await get('cs', '/api/insights')).json();
    expect(ins.find((i: any) => i.title.startsWith('Receiving time up'))?.tone).toBe('warn');
    expect(ins.some((i: any) => i.title.includes('Dr Repeat') && i.title.includes('3 times'))).toBe(true);
    expect((await get('nurse', '/api/insights')).statusCode).toBe(403);
  });

  it('flags a physically implausible location as a geolocation exception', async () => {
    const mk = async (h: any) => (await post('cs', '/api/bleed-requests', { hospital_id: h.id, requested_by: 'Ward', nurse_id: nurse.id, patients: [{ patient_name: 'P' }] })).json();
    const a = await mk(hospital), b = await mk(coastal);
    expect((await post('nurse', `/api/bleed-requests/${a.id}/arrive`, { lat: hospital.lat, lng: hospital.lng, accuracy: 8 })).statusCode).toBe(200);
    // ~1,300 km away moments later
    expect((await post('nurse', `/api/bleed-requests/${b.id}/arrive`, { lat: coastal.lat, lng: coastal.lng, accuracy: 8 })).statusCode).toBe(200);
    const [r] = await sql`select arrive_suspect from bleed_requests where id = ${b.id}`;
    expect(r.arrive_suspect).toMatch(/km\/h/);
    expect((await get('cs', `/api/bleeds/${b.bleed_ids[0]}`)).json().geo_exception).toBe(true);
    const [a2] = await sql`select arrive_suspect from bleed_requests where id = ${a.id}`;
    expect(a2.arrive_suspect).toBeNull();
  });

  it('logs who viewed a patient record, once per 15 minutes, and exports it for a POPIA access request', async () => {
    const [t] = await sql`select id from tickets limit 1`;
    await sql`update tickets set patient_name = 'Nomsa Popia' where id = ${t.id}`;
    await get('cs', `/api/tickets/${t.id}`);
    await get('cs', `/api/tickets/${t.id}`);
    const [{ n }] = await sql`select count(*)::int as n from audit_log where action = 'viewed' and entity_id = ${t.id}`;
    expect(n).toBe(1);
    expect((await get('cs', '/api/popia/subject?q=Nomsa')).statusCode).toBe(403);
    const r = await get('sup', '/api/popia/subject?q=Nomsa');
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    const body = r.json();
    expect(body.tickets).toHaveLength(1);
    expect(body.access_log[0].by).toBe('Thandi Mokoena');
  });

  it('retention purges photos of long-closed bleeds (rows and encrypted files) per policy', async () => {
    const [b] = await sql`select id from bleeds where filed_at is not null limit 1`;
    const { blob, keyWrapped } = encryptFile(Buffer.from('photo'));
    const [p] = await sql`insert into bleed_photos (bleed_id, kind, mime, size, key_wrapped, uploaded_by) values (${b.id}, 'sticker', 'image/jpeg', 5, ${keyWrapped}, ${nurse.id}) returning id`;
    mkdirSync(`${process.env.DATA_DIR}/blobs`, { recursive: true });
    writeFileSync(`${process.env.DATA_DIR}/blobs/${p.id}`, blob);
    const [cs] = await sql`select id from users where email = 'agent@crm.local'`;
    await sql`update bleeds set closed_at = now() - interval '40 days', closed_by = ${cs.id} where id = ${b.id}`;
    expect((await retentionTick()).bleed_photos).toBeUndefined(); // policy off by default
    await sql`update settings set value = '{"bleed_photos": 30}' where key = 'retention_days'`;
    expect((await retentionTick()).bleed_photos).toBe(1);
    expect(existsSync(`${process.env.DATA_DIR}/blobs/${p.id}`)).toBe(false);
  });

  it('master-key rotation re-wraps file keys without touching the files', () => {
    const { blob, keyWrapped } = encryptFile(Buffer.from('secret'));
    const next = randomBytes(32);
    const back = rewrap(rewrap(keyWrapped, MASTER, next), next, MASTER);
    expect(decryptFile(blob, back).toString()).toBe('secret');
    expect(() => rewrap(keyWrapped, next, MASTER)).toThrow();
  });
});
