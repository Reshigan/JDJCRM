// Tier 2: client register + merge, corrective-action effectiveness, @mentions, saved views, canned responses, bulk close, pagination.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

describe.skipIf(!url)('tier 2 (API + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  const { effectivenessTick } = await import('../src/escalation');
  let app: Awaited<ReturnType<typeof buildApp>>;
  const jar: Record<string, string> = {};
  const req = (who: string, method: string, u: string, payload?: object) =>
    app.inject({ method: method as any, url: u, payload, headers: { cookie: jar[who] } });
  let lk: any;

  const open = async (name: string, extra: object = {}) => {
    const org = lk.organisations.find((o: any) => o.name.startsWith('Parkview'));
    const cat = lk.categories.find((c: any) => c.name.startsWith('Compliment'));
    const r = await req('cs', 'POST', '/api/tickets', {
      channel: 'telephone', complainant_type: 'doctor', complainant_name: name, organisation_id: org.id, contact_phone: '012 555 0199',
      site_id: org.site_id, category_id: cat.id, priority: 'normal', description: 'Tier 2 test', ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  /** Drive a ticket to client_contacted (ready to close). */
  const readyToClose = async (id: string) => {
    for (const a of (await req('cs', 'GET', `/api/tickets/${id}`)).json().assignments) {
      const who = { PRE: 'pre', LOG: 'log', ANA: 'ana', CS: 'cs' }[a.department_code as string] ?? 'cs';
      await req(who, 'POST', `/api/tickets/${id}/actions`, { action: 'acknowledge', assignment_id: a.id });
      await req(who, 'POST', `/api/tickets/${id}/actions`, { action: 'respond', assignment_id: a.id, findings: 'f', corrective_action: 'c' });
    }
    await req('cs', 'POST', `/api/tickets/${id}/actions`, { action: 'review' });
    for (const a of (await req('cs', 'GET', `/api/tickets/${id}`)).json().assignments) await req('cs', 'POST', `/api/tickets/${id}/actions`, { action: 'accept', assignment_id: a.id });
    const r = await req('cs', 'POST', `/api/tickets/${id}/actions`, { action: 'log_call', called_at: new Date().toISOString(), spoken_to: 'x', number_used: '1', summary: 's', satisfied: true });
    expect(r.statusCode, r.body).toBe(200);
  };

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    app = await buildApp();
    for (const [who, email] of [['cs', 'agent'], ['sup', 'supervisor'], ['pre', 'preanalytical'], ['log', 'logistics'], ['ana', 'analytical'], ['nurse', 'nursing']]) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${email}@baton.local`, password: 'Baton!demo2026' } });
      jar[who] = String(r.headers['set-cookie']).split(';')[0];
    }
    lk = (await req('cs', 'GET', '/api/lookups')).json();
  });
  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  it('intake files each complainant in the register once, and the lookup shows their history', async () => {
    const a = await open('Dr Priya Govender');
    await open('dr priya govender');
    const [t] = await sql`select contact_id from tickets where id = ${a}`;
    expect(t.contact_id).not.toBeNull();
    const hits = (await req('cs', 'GET', '/api/complainants?q=govender')).json();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: t.contact_id, total: 2, organisation: expect.stringMatching(/^Parkview/) });
    // Picking the entry at intake links to it even when the typed name differs.
    const b = await open('Dr P. Govender (locum)', { contact_id: t.contact_id });
    expect((await sql`select contact_id from tickets where id = ${b}`)[0].contact_id).toBe(t.contact_id);
    expect((await req('cs', 'GET', `/api/tickets?scope=all&contact_id=${t.contact_id}`)).json()).toHaveLength(3);
  });

  it('duplicates are found by name (ignoring titles); only a CS supervisor merges, and tickets follow', async () => {
    await open('Priya Govender');
    const groups = (await req('sup', 'GET', '/api/contacts/duplicates')).json();
    const dup = groups.find((g: any) => g.some((c: any) => c.name === 'Priya Govender'));
    expect(dup.map((c: any) => c.name).sort()).toEqual(['Dr Priya Govender', 'Priya Govender']);
    expect(groups.every((g: any) => g.length > 1)).toBe(true); // shared phone numbers alone never group people
    const keep = dup.find((c: any) => c.name === 'Dr Priya Govender');
    const drop = dup.find((c: any) => c.name === 'Priya Govender');
    expect((await req('cs', 'POST', `/api/contacts/${drop.id}/merge`, { into: keep.id })).statusCode).toBe(403);
    const m = (await req('sup', 'POST', `/api/contacts/${drop.id}/merge`, { into: keep.id })).json();
    expect(m).toEqual({ ok: true, tickets: 1 });
    expect((await req('sup', 'POST', `/api/contacts/${drop.id}/merge`, { into: keep.id })).statusCode).toBe(404);
    const reg = (await req('cs', 'GET', '/api/contacts?q=govender')).json();
    expect(reg).toHaveLength(1);
    expect(reg[0].total).toBe(4);
    expect((await req('pre', 'GET', '/api/contacts')).statusCode).toBe(403);
    const [{ n }] = await sql`select count(*)::int as n from audit_log where action = 'contact.merged'`;
    expect(n).toBe(1);
  });

  it('closure can set an effectiveness check; it is reminded once when due, then recorded', async () => {
    const id = await open('Dr Effective');
    await readyToClose(id);
    const close = (due: string) => req('cs', 'POST', `/api/tickets/${id}/actions`, { action: 'close', closure_reason: 'resolved_corrective', root_cause: 'logistics', effectiveness_due: due });
    expect((await close('2020-01-01')).statusCode).toBe(400);
    expect((await close('2099-01-01')).statusCode).toBe(200);
    let t = (await req('cs', 'GET', `/api/tickets/${id}`)).json();
    expect(t.actions).toContain('check_effectiveness');
    await sql`update tickets set effectiveness_due = current_date - 1 where id = ${id}`;
    expect(await effectivenessTick()).toBe(1);
    expect(await effectivenessTick()).toBe(0);
    const q = (await req('cs', 'GET', '/api/quality/effectiveness')).json();
    expect(q.due.map((x: any) => x.id)).toContain(id);
    const r = await req('cs', 'POST', `/api/tickets/${id}/actions`, { action: 'check_effectiveness', result: 'not_effective', note: 'Same failure recurred' });
    expect(r.statusCode, r.body).toBe(200);
    t = (await req('cs', 'GET', `/api/tickets/${id}`)).json();
    expect(t.effectiveness_result).toBe('not_effective');
    expect(t.actions).not.toContain('check_effectiveness');
    expect((await req('cs', 'GET', '/api/quality/effectiveness')).json().not_effective).toBe(1);
    const [{ n }] = await sql`select count(*)::int as n from notifications where title like 'Corrective action not effective%'`;
    expect(n).toBeGreaterThan(0);
  });

  it('@mentions notify only colleagues who can see the ticket', async () => {
    const id = await open('Dr Mention');
    const pre = (await sql`select name from users where email = 'preanalytical@baton.local'`)[0].name;
    const ana = (await sql`select name from users where email = 'analytical@baton.local'`)[0].name;
    const r = (await req('cs', 'POST', `/api/tickets/${id}/notes`, { body: `@${pre} and @${ana} please check the fridge log` })).json();
    const routed = (await req('cs', 'GET', `/api/tickets/${id}`)).json().assignments.map((a: any) => a.department_code);
    expect(r.mentioned).toEqual(routed.includes('PRE') ? [pre] : []);
    if (!routed.includes('ANA')) expect(r.mentioned).not.toContain(ana);
  });

  it('saved views are per user; canned responses come with lookups', async () => {
    const v = (await req('cs', 'POST', '/api/views', { page: 'tickets', name: 'My high', query: 'priority=high' })).json();
    await req('cs', 'POST', '/api/views', { page: 'tickets', name: 'My high', query: 'priority=critical' }); // same name: updated
    expect((await req('cs', 'GET', '/api/views?page=tickets')).json()).toEqual([{ id: v.id, name: 'My high', query: 'priority=critical' }]);
    expect((await req('sup', 'GET', '/api/views?page=tickets')).json()).toEqual([]);
    await req('sup', 'DELETE', `/api/views/${v.id}`);
    expect((await req('cs', 'GET', '/api/views?page=tickets')).json()).toHaveLength(1);
    await req('cs', 'DELETE', `/api/views/${v.id}`);
    expect((await req('cs', 'GET', '/api/views?page=tickets')).json()).toHaveLength(0);
    expect(lk.canned.length).toBeGreaterThan(0);
  });

  it('bulk close closes only bleeds that have ended', async () => {
    const h = lk.organisations.find((o: any) => o.kind === 'hospital');
    const r = (await req('cs', 'POST', '/api/bleed-requests', { hospital_id: h.id, requested_by: 'W', patients: [{ patient_name: 'A' }, { patient_name: 'B' }] })).json();
    await sql`update bleeds set arrived_at = now(), captured_at = now(), outcome = 'patient_refused' where id = ${r.bleed_ids[0]}`; // ended: unsuccessful
    expect((await req('nurse', 'POST', '/api/bleeds/close', { ids: r.bleed_ids })).statusCode).toBe(403);
    expect((await req('cs', 'POST', '/api/bleeds/close', { ids: r.bleed_ids })).json()).toEqual({ closed: 1, skipped: 1 });
  });

  it('closed boards page by date with a cursor', async () => {
    const all = (await req('cs', 'GET', '/api/tickets?scope=all&limit=2')).json();
    expect(all).toHaveLength(2);
    const next = (await req('cs', 'GET', `/api/tickets?scope=all&limit=2&before=${encodeURIComponent(all[1].created_at)}`)).json();
    expect(next.length).toBeGreaterThan(0);
    expect(next.some((t: any) => all.some((x: any) => x.id === t.id))).toBe(false);
    expect(new Date(next[0].created_at) < new Date(all[1].created_at)).toBe(true);
  });
});
