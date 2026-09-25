import { expect, test } from '@playwright/test';
import { signIn, uniq } from './helpers';

test('live push: a new bleed appears on the board without a reload', async ({ browser }) => {
  const board = await signIn(browser, 'supervisor@crm.local');
  await board.goto('/bleeds');
  await expect(board.getByRole('heading', { name: 'Bleed board' })).toBeVisible();
  await board.waitForTimeout(1000); // stream connected
  const tag = uniq();
  const cs = await signIn(browser, 'agent@crm.local');
  const lk = await (await cs.request.get('/api/lookups')).json();
  const h = lk.organisations.find((o: any) => o.name === 'Demo Private Clinic');
  const r = await cs.request.post('/api/bleed-requests', { data: { hospital_id: h.id, requested_by: `Live ${tag}`, patients: [{ patient_name: `Live ${tag}` }] } });
  expect(r.ok()).toBe(true);
  const { bleeds } = await r.json();
  // Polling is 60 s; seeing it within 5 s proves the push path.
  await expect(board.getByText(bleeds[0])).toBeVisible({ timeout: 5_000 });
});

test('dashboard: live view, performance with drill-down, Excel export, wall mode', async ({ browser }) => {
  const sup = await signIn(browser, 'supervisor@crm.local');
  await expect(sup).toHaveURL(/\/dashboard/);
  await expect(sup.getByText('Breach register · today')).toBeVisible();
  await sup.getByRole('link', { name: 'Performance' }).click();
  await expect(sup.getByText('Median time per stage')).toBeVisible();
  const [download] = await Promise.all([sup.waitForEvent('download'), sup.getByRole('button', { name: 'Export to Excel' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^baton-.*\.xlsx$/);
  await sup.getByRole('button', { name: /^Sample not received/ }).first().click();
  await expect(sup).toHaveURL(/\/tickets\?.*category_id=/);
  await sup.goto('/wall');
  await expect(sup.getByText('CRM · Live operations')).toBeVisible();
});

test('roles: a department responder has no dashboard, admin or dispatch', async ({ browser }) => {
  const pre = await signIn(browser, 'preanalytical@crm.local');
  await expect(pre.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await expect(pre.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  expect((await pre.request.get('/api/dispatch/runs')).status()).toBe(403);
  expect((await pre.request.get('/api/%61dmin/users')).status()).toBe(403);
});

test('admin: system status shows the worker and audit chain', async ({ browser }) => {
  const admin = await signIn(browser, 'admin@crm.local');
  await admin.goto('/admin/status');
  await expect(admin.getByText('Background worker')).toBeVisible();
  await expect(admin.getByText(/hash chain verified/)).toBeVisible();
});
