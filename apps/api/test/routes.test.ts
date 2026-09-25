// Route guard: every API route refuses anonymous callers and half-signed-in (two-factor pending) sessions,
// except the short, reviewed list below. A new public route fails this test until it is added here on purpose.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

const PUBLIC = ['GET /api/health', 'POST /api/auth/login', 'POST /api/integrations/lis/events']; // LIS: HMAC-signed instead
const PARTIAL = ['GET /api/me', 'POST /api/auth/logout', 'POST /api/auth/mfa/setup', 'POST /api/auth/mfa/verify'];

describe.skipIf(!url)('route guard', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp, ROUTES } = await import('../src/app');
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pending = '';
  const fill = (u: string) => u.replace(/:id\b/g, '00000000-0000-4000-8000-000000000000').replace(/:(\w+)\??/g, (_, k) => (k === 'res' ? 'users' : 'x'));

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    await sql`update settings set value = '["cs_agent"]' where key = 'mfa_enforced_roles'`;
    app = await buildApp();
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'agent@baton.local', password: 'Baton!demo2026' } });
    expect(r.json().mfa).toBe('setup');
    pending = String(r.headers['set-cookie']).split(';')[0];
  });
  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  it('only the reviewed routes are public or reachable before two-factor', () => {
    const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
    expect(ROUTES.filter((r) => r.auth === 'public').map(key).sort()).toEqual([...PUBLIC].sort());
    expect(ROUTES.filter((r) => r.auth === 'partial').map(key).sort()).toEqual([...PARTIAL].sort());
    expect(ROUTES.length).toBeGreaterThan(50); // the sweep below really covers the API
  });

  it('every other route answers 401 without a session and with a two-factor-pending session', async () => {
    const leaks: string[] = [];
    for (const r of ROUTES.filter((x) => x.auth !== 'public' && x.url.startsWith('/api'))) {
      const u = fill(r.url);
      const anon = await app.inject({ method: r.method as any, url: u, payload: r.method === 'GET' ? undefined : {} });
      if (anon.statusCode !== 401) leaks.push(`${r.method} ${r.url} anonymous → ${anon.statusCode}`);
      if (r.auth === 'partial') continue;
      const half = await app.inject({ method: r.method as any, url: u, payload: r.method === 'GET' ? undefined : {}, headers: { cookie: pending } });
      if (half.statusCode !== 401) leaks.push(`${r.method} ${r.url} two-factor pending → ${half.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });
});
