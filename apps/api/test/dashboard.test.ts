// Dashboard, analytics, Excel export and search against a real Postgres, using the full demo data set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

describe.skipIf(!url)('dashboard and analytics (API + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  const { reportTick } = await import('../src/reports');
  const { SAST_OFFSET } = await import('@baton/core');
  let app: Awaited<ReturnType<typeof buildApp>>;
  const jar: Record<string, string> = {};
  const get = (who: string, u: string) => app.inject({ method: 'GET', url: u, headers: { cookie: jar[who] } });
  const today = new Date(Date.now() + SAST_OFFSET).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() + SAST_OFFSET - 7 * 86_400_000).toISOString().slice(0, 10);
  const period = `from=${weekAgo}&to=${today}`;

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, true); // full demo: queries + bleeds driven through the API
    app = await buildApp();
    for (const [who, email] of Object.entries({ cs: 'agent', sup: 'supervisor', exec: 'exec', mgr: 'manager.pre', nurse: 'nursing' })) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `${email}@baton.local`, password: 'Baton!demo2026' } });
      jar[who] = String(r.headers['set-cookie']).split(';')[0];
    }
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await sql.end();
  });

  it('live view: today at a glance and a breach register with reasons', async () => {
    // Working-hours clocks depend on when the suite runs (nights, weekends, public holidays): make one query certainly late.
    await sql`update assignments set started_at = now() - interval '30 days'
      where id = (select id from assignments where state in ('assigned', 'in_progress') order by created_at limit 1)`;
    expect((await get('nurse', '/api/dashboard/live')).statusCode).toBe(403);
    const r = (await get('cs', '/api/dashboard/live')).json();
    expect(r.tiles.bleeds_requested).toBeGreaterThanOrEqual(8);
    expect(r.tiles.queries_logged).toBeGreaterThanOrEqual(5);
    expect(r.tiles.breaches).toBe(r.register.length);
    expect(r.register.some((x: any) => x.kind === 'bleed' && x.stage === 'Logistics' && x.reason)).toBe(true);
    expect(r.register.some((x: any) => x.kind === 'query' && x.running)).toBe(true);
  });

  it('analytics: stage times, compliance, cancelled excluded, volumes, repeats', async () => {
    const a = (await get('exec', `/api/analytics?${period}`)).json();
    expect(a.bleeds.stages).toHaveLength(6);
    const logistics = a.bleeds.stages.find((s: any) => s.key === 'logistics');
    expect(logistics.n).toBeGreaterThan(0);
    expect(logistics.compliance).toBeLessThan(100); // the demo coastal run overran logistics
    expect(a.bleeds.completed).toBe(1);
    expect(a.bleeds.geo_exceptions).toBe(1);
    expect(a.queries.by_category.reduce((s: number, c: any) => s + c.n, 0)).toBe(a.queries.logged);
    expect(a.queries.by_department.find((d: any) => d.label === 'Pre-Analytical').n).toBeGreaterThan(0);
    expect(a.queries.by_complainant[0].n).toBeGreaterThanOrEqual(2); // Dr A. Naidoo appears twice
    expect(a.bleeds.trend).toHaveLength(8);
  });

  it('department managers see only their own department; others are refused', async () => {
    const a = (await get('mgr', `/api/analytics?${period}`)).json();
    expect(a.bleeds).toBeNull();
    expect(a.queries.by_department.map((d: any) => d.label)).toEqual(['Pre-Analytical']);
    expect((await get('nurse', `/api/analytics?${period}`)).statusCode).toBe(403);
  });

  it('exports any view to Excel (supervisor and management only), and the export is audited', async () => {
    expect((await get('cs', `/api/export.xlsx?${period}`)).statusCode).toBe(403);
    const r = await get('sup', `/api/export.xlsx?${period}`);
    expect(r.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as any);
    expect(wb.worksheets.map((w) => w.name)).toContain('Bleed stages');
    expect(wb.getWorksheet('Queries')!.rowCount).toBeGreaterThan(5);
    expect(String(wb.getWorksheet('Bleeds')!.getRow(2).getCell(5).value)).not.toMatch(/\s[a-z]+\s/i); // patient reference, not full name
    const [{ n }] = await sql`select count(*)::int as n from audit_log where action = 'export.xlsx'`;
    expect(n).toBe(1);
  });

  it('search finds tickets and bleeds by patient, number or hospital, within the caller’s scope', async () => {
    const r = (await get('cs', '/api/search?q=Demo%20Coastal')).json();
    expect(r.bleeds.length).toBeGreaterThan(0);
    expect((await get('cs', '/api/search?q=Sarah')).json().bleeds[0].patient_name).toBe('Sarah Jacobs');
    expect((await get('mgr', '/api/search?q=Demo')).json().bleeds).toHaveLength(0);
  });

  it('scheduled reports go out once per day to the distribution list', async () => {
    await sql`update settings set value = '["ops@jdj.local"]' where key = 'report_daily_recipients'`;
    const nine = new Date(`${today}T09:00:00Z`.replace('Z', '+02:00'));
    await reportTick(nine);
    await reportTick(nine);
    const [{ n }] = await sql`select count(*)::int as n from audit_log where action = 'report.daily'`;
    expect(n).toBe(1);
  });
});
