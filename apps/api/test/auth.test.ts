// Sign-in as it runs in production: enforced two-factor, lockouts, sessions, password changes, Active Directory.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

const ad = vi.hoisted(() => ({ result: null as null | { email: string; name: string; groups: string[] } }));
vi.mock('../src/ldap', () => ({ ldapEnabled: () => true, adAuthenticate: async (_u: string, pw: string) => (pw === 'ad-pass' ? ad.result : null) }));

describe.skipIf(!url)('authentication (API + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  const { totp } = await import('../src/crypto');
  let app: Awaited<ReturnType<typeof buildApp>>;
  const PW = 'Demo!crm2026';

  const login = async (username: string, password = PW) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    return { status: r.statusCode, body: r.json(), cookie: r.headers['set-cookie'] ? String(r.headers['set-cookie']).split(';')[0] : '' };
  };
  const as = (cookie: string, method: string, u: string, payload?: object) => app.inject({ method: method as any, url: u, payload, headers: { cookie } });
  const enrol = async (cookie: string) => {
    const { secret } = (await as(cookie, 'POST', '/api/auth/mfa/setup')).json();
    expect((await as(cookie, 'POST', '/api/auth/mfa/verify', { code: totp(secret) })).statusCode).toBe(200);
    return secret as string;
  };

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    await sql`update settings set value = '["cs_agent","cs_supervisor","management","admin"]' where key = 'mfa_enforced_roles'`; // production policy
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  it('an enforced role must enrol two-factor before any data is reachable, then verifies at every sign-in', async () => {
    const first = await login('agent@crm.local');
    expect(first.body.mfa).toBe('setup');
    expect((await as(first.cookie, 'GET', '/api/tickets')).statusCode).toBe(401);
    expect((await as(first.cookie, 'GET', '/api/me')).json().mfa_ok).toBe(false);
    expect((await as(first.cookie, 'POST', '/api/auth/mfa/verify', { code: '000000' })).statusCode).toBe(401);
    const secret = await enrol(first.cookie);
    expect((await as(first.cookie, 'GET', '/api/tickets')).statusCode).toBe(200);
    expect((await as(first.cookie, 'POST', '/api/auth/mfa/setup')).statusCode).toBe(409); // cannot silently re-enrol

    const next = await login('agent@crm.local');
    expect(next.body.mfa).toBe('verify');
    expect((await as(next.cookie, 'GET', '/api/tickets')).statusCode).toBe(401);
    expect((await as(next.cookie, 'POST', '/api/auth/mfa/verify', { code: totp(secret) })).statusCode).toBe(200);
    expect((await as(next.cookie, 'GET', '/api/tickets')).statusCode).toBe(200);
    // Department roles are not enforced by default.
    expect((await login('preanalytical@crm.local')).body.mfa).toBe('ok');
  });

  it('five wrong two-factor codes lock the account and end the session', async () => {
    const s = await login('supervisor@crm.local');
    await enrol(s.cookie);
    const t = await login('supervisor@crm.local');
    for (let i = 0; i < 5; i++) await as(t.cookie, 'POST', '/api/auth/mfa/verify', { code: '123456' });
    expect((await as(t.cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await login('supervisor@crm.local')).status).toBe(423);
  });

  it('five wrong passwords lock the account, even against the right password, until the lock expires', async () => {
    for (let i = 0; i < 5; i++) expect((await login('logistics@crm.local', 'wrong')).status).toBe(401);
    expect((await login('logistics@crm.local')).status).toBe(423);
    await sql`update users set locked_until = now() - interval '1 second' where email = 'logistics@crm.local'`;
    const r = await login('logistics@crm.local');
    expect(r.status).toBe(200);
    expect((await sql`select failed_logins from users where email = 'logistics@crm.local'`)[0].failed_logins).toBe(0);
    const [{ n }] = await sql`select count(*)::int as n from audit_log where action = 'auth.failed'`;
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('sign-out ends the session; a password change ends every other session', async () => {
    const a = await login('analytical@crm.local');
    const b = await login('analytical@crm.local');
    expect((await as(a.cookie, 'POST', '/api/auth/password', { current: 'wrong', next: 'Another!pass2026' })).statusCode).toBe(401);
    expect((await as(a.cookie, 'POST', '/api/auth/password', { current: PW, next: 'short' })).statusCode).toBe(400);
    expect((await as(a.cookie, 'POST', '/api/auth/password', { current: PW, next: 'Another!pass2026' })).statusCode).toBe(200);
    expect((await as(b.cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await as(a.cookie, 'GET', '/api/me')).statusCode).toBe(200);
    expect((await login('analytical@crm.local')).status).toBe(401);
    expect((await as(a.cookie, 'POST', '/api/auth/logout')).statusCode).toBe(200);
    expect((await as(a.cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('expired sessions and deactivated users are refused', async () => {
    const s = await login('nursing@crm.local');
    await sql`update sessions set expires_at = now() - interval '1 minute' where user_id = (select id from users where email = 'nursing@crm.local')`;
    expect((await as(s.cookie, 'GET', '/api/me')).statusCode).toBe(401);
    const t = await login('nursing@crm.local');
    await sql`update users set active = false where email = 'nursing@crm.local'`;
    expect((await as(t.cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await login('nursing@crm.local')).status).toBe(401);
    await sql`update users set active = true where email = 'nursing@crm.local'`;
  });

  it('Active Directory: group membership sets role and department; no group, no access; a local account cannot be taken over', async () => {
    const [pre] = await sql`select id from departments where code = 'PRE'`;
    await sql`insert into ad_groups (group_dn, role, department_id, priority) values ('cn=baton-pre,ou=groups,dc=jdj,dc=local', 'dept_responder', ${pre.id}, 10)`;
    ad.result = { email: 'thabo@jdj.local', name: 'Thabo Nkosi', groups: ['cn=baton-pre,ou=groups,dc=jdj,dc=local'] };
    const r = await login('thabo', 'ad-pass');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [u] = await sql`select role, department_id, auth, password_hash from users where email = 'thabo@jdj.local'`;
    expect(u).toMatchObject({ role: 'dept_responder', department_id: pre.id, auth: 'ad', password_hash: null });
    expect((await login('thabo', 'wrong')).status).toBe(401);

    ad.result = { email: 'stranger@jdj.local', name: 'Not In The CRM', groups: ['cn=finance,ou=groups,dc=jdj,dc=local'] };
    expect((await login('stranger', 'ad-pass')).status).toBe(403);

    ad.result = { email: 'agent@crm.local', name: 'Impostor', groups: ['cn=baton-pre,ou=groups,dc=jdj,dc=local'] };
    expect((await login('agent', 'ad-pass')).status).toBe(401);
    expect((await sql`select auth, role from users where email = 'agent@crm.local'`)[0]).toMatchObject({ auth: 'local', role: 'cs_agent' });

    await sql`update users set locked_until = now() + interval '15 minutes' where email = 'thabo@jdj.local'`;
    ad.result = { email: 'thabo@jdj.local', name: 'Thabo Nkosi', groups: ['cn=baton-pre,ou=groups,dc=jdj,dc=local'] };
    expect((await login('thabo', 'ad-pass')).status).toBe(423);
    expect((await login('thabo@jdj.local', 'ad-pass')).status).toBe(423);
  });
});
