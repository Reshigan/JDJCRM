// End-to-end Module A lifecycle against a real Postgres (TEST_DATABASE_URL).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

describe.skipIf(!url)('query lifecycle (API + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  const { escalationTick } = await import('../src/escalation');
  let app: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {};

  const as = (who: string) => ({
    get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookies[who] } }),
    post: (url: string, payload?: object) => app.inject({ method: 'POST', url, payload: payload ?? {}, headers: { cookie: cookies[who] } }),
  });
  const login = async (who: string, email: string, password = 'Demo!crm2026') => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: email, password } });
    expect(r.statusCode, r.body).toBe(200);
    cookies[who] = String(r.headers['set-cookie']).split(';')[0];
  };

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    app = await buildApp();
    await login('agent', 'agent@crm.local');
    await login('pre', 'preanalytical@crm.local');
    await login('log', 'logistics@crm.local');
    await login('ana', 'analytical@crm.local');
    await login('exec', 'exec@crm.local');
  });
  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  let id = '';
  let cat: any;
  let site: any;
  let org: any;

  it('only Client Services can open a ticket, which is auto-numbered and routed', async () => {
    const lk = (await as('agent').get('/api/lookups')).json();
    cat = lk.categories.find((c: any) => c.name.startsWith('Sample not received'));
    site = lk.sites[0];
    org = lk.organisations.find((o: any) => o.kind === 'practice');
    const body = {
      channel: 'telephone', complainant_type: 'doctor', complainant_name: 'Dr A. Naidoo', organisation_id: org.id,
      contact_phone: '012 555 0101', site_id: site.id, category_id: cat.id, priority: 'high', description: 'Sample for J. Smith not received',
    };
    expect((await as('pre').post('/api/tickets', body)).statusCode).toBe(403);
    expect((await as('exec').post('/api/tickets', body)).statusCode).toBe(403);
    const r = await as('agent').post('/api/tickets', body);
    expect(r.statusCode, r.body).toBe(201);
    id = r.json().id;
    const t = (await as('agent').get(`/api/tickets/${id}`)).json();
    expect(t.number).toMatch(/^QRY-\d{6}-0001$/);
    expect(t.state).toBe('assigned');
    expect(t.assignments.map((a: any) => a.department_code).sort()).toEqual(['LOG', 'PRE']);
  });

  it('departments only see tickets routed to them', async () => {
    expect((await as('ana').get(`/api/tickets/${id}`)).statusCode).toBe(404);
    expect((await as('ana').get('/api/tickets')).json()).toHaveLength(0);
    expect((await as('pre').get('/api/tickets')).json()).toHaveLength(1);
  });

  const assignment = async (who: string, code: string) =>
    (await as(who).get(`/api/tickets/${id}`)).json().assignments.find((a: any) => a.department_code === code);

  it('each department acknowledges and responds independently', async () => {
    const pre = await assignment('pre', 'PRE');
    expect(pre.actions).toEqual(['acknowledge']);
    expect((await as('log').post(`/api/tickets/${id}/actions`, { action: 'acknowledge', assignment_id: pre.id })).statusCode).toBe(409);
    expect((await as('pre').post(`/api/tickets/${id}/actions`, { action: 'acknowledge', assignment_id: pre.id })).statusCode).toBe(200);
    expect((await as('agent').get(`/api/tickets/${id}`)).json().state).toBe('in_progress');
    const r = await as('pre').post(`/api/tickets/${id}/actions`, { action: 'respond', assignment_id: pre.id, findings: 'Sample found in cold room', corrective_action: 'Retrained receiving' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await as('agent').get(`/api/tickets/${id}`)).json().state).toBe('in_progress');
  });

  it('breach reason is required once the time limit is exceeded, and escalation notifies', async () => {
    const log = await assignment('log', 'LOG');
    await sql`update assignments set started_at = now() - interval '30 days' where id = ${log.id}`;
    expect(await escalationTick()).toBe(1);
    const [{ escalation_level }] = await sql`select escalation_level from assignments where id = ${log.id}`;
    expect(escalation_level).toBe(3);
    await as('log').post(`/api/tickets/${id}/actions`, { action: 'acknowledge', assignment_id: log.id });
    const payload = { action: 'respond', assignment_id: log.id, findings: 'Courier delay', corrective_action: 'Route changed' };
    const r = await as('log').post(`/api/tickets/${id}/actions`, payload);
    expect(r.statusCode).toBe(422);
    expect((await as('log').post(`/api/tickets/${id}/actions`, { ...payload, breach_reason: 'Vehicle breakdown' })).statusCode).toBe(200);
    expect((await as('agent').get(`/api/tickets/${id}`)).json().state).toBe('response_submitted');
  });

  it('closure is impossible until review, verification call and satisfaction are recorded', async () => {
    const close = { action: 'close', closure_reason: 'resolved_corrective', root_cause: 'logistics' };
    expect((await as('agent').post(`/api/tickets/${id}/actions`, close)).statusCode).toBe(409);
    // direct SQL bypass is blocked by the DB trigger too
    const [agent] = await sql`select id from users where email = 'agent@crm.local'`;
    await expect(sql`update tickets set state = 'closed', closure_reason = 'resolved', root_cause = 'other', closed_at = now(), closed_by = ${agent.id} where id = ${id}`).rejects.toThrow();

    expect((await as('agent').post(`/api/tickets/${id}/actions`, { action: 'review' })).statusCode).toBe(200);
    const t = (await as('agent').get(`/api/tickets/${id}`)).json();
    for (const a of t.assignments) await as('agent').post(`/api/tickets/${id}/actions`, { action: 'accept', assignment_id: a.id });

    const call = { action: 'log_call', called_at: new Date().toISOString(), spoken_to: 'Dr Naidoo', number_used: '012 555 0101', summary: 'Explained', satisfied: false };
    expect((await as('agent').post(`/api/tickets/${id}/actions`, call)).statusCode).toBe(200);
    const back = (await as('agent').get(`/api/tickets/${id}`)).json();
    expect(back.state).toBe('in_progress');
    expect(back.cycle).toBe(1);

    for (const code of ['PRE', 'LOG']) {
      const who = code === 'PRE' ? 'pre' : 'log';
      const a = await assignment(who, code);
      expect(a.state).toBe('in_progress');
      await as(who).post(`/api/tickets/${id}/actions`, { action: 'respond', assignment_id: a.id, findings: 'Recollected', corrective_action: 'Done' });
    }
    await as('agent').post(`/api/tickets/${id}/actions`, { action: 'review' });
    for (const a of (await as('agent').get(`/api/tickets/${id}`)).json().assignments)
      await as('agent').post(`/api/tickets/${id}/actions`, { action: 'accept', assignment_id: a.id });
    expect((await as('agent').post(`/api/tickets/${id}/actions`, { ...call, satisfied: true })).statusCode).toBe(200);
    expect((await as('pre').post(`/api/tickets/${id}/actions`, close)).statusCode).toBe(409);
    const r = await as('agent').post(`/api/tickets/${id}/actions`, close);
    expect(r.statusCode, r.body).toBe(200);
    expect((await as('agent').get(`/api/tickets/${id}`)).json().state).toBe('closed');
  });

  it('reopen returns to In Progress with a reason; audit chain stays intact', async () => {
    expect((await as('agent').post(`/api/tickets/${id}/actions`, { action: 'reopen', reason: 'Recurred', department_ids: [] })).statusCode).toBe(200);
    expect((await as('agent').get(`/api/tickets/${id}`)).json().state).toBe('in_progress');
    const [{ broken }] = await sql`select audit_verify() as broken`;
    expect(broken).toBeNull();
    await expect(sql`delete from audit_log`).rejects.toThrow(/append-only/);
  });

  it('attachments are stored encrypted and reads are audited', async () => {
    const boundary = 'x';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nPATIENT SECRET\r\n--${boundary}--\r\n`;
    const up = await app.inject({ method: 'POST', url: `/api/tickets/${id}/attachments`, payload, headers: { cookie: cookies.agent, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode, up.body).toBe(200);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(`${process.env.DATA_DIR}/blobs/${up.json().id}`).toString()).not.toContain('PATIENT SECRET');
    const dl = await as('agent').get(`/api/attachments/${up.json().id}`);
    expect(dl.body).toBe('PATIENT SECRET');
    const [{ n }] = await sql`select count(*)::int as n from audit_log where action = 'attachment.viewed'`;
    expect(n).toBe(1);
  });
});
