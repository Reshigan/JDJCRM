import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { phone, signIn } from './helpers';

/** Measure settled colours: no transitions or animations mid-flight. */
const still = (page: Page) => page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

// WCAG 2.1 AA scan of every main screen. Fails on serious or critical violations.
async function scan(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('load'); // not networkidle: the live-update stream stays open
  await page.waitForTimeout(1200);
  await still(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${path} · ${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' [' + (n.any[0]?.message ?? '') + ']').join(' | ')}`);
}

test.setTimeout(180_000);

test('accessibility: login and every Client Services / management screen', async ({ browser }) => {
  const found: string[] = [];
  const anon = await (await browser.newContext()).newPage();
  found.push(...(await scan(anon, '/login')));
  const cs = await signIn(browser, 'supervisor@baton.local');
  const ticket = (await (await cs.request.get('/api/tickets?scope=all')).json())[0];
  const bleed = (await (await cs.request.get('/api/bleeds')).json())[0];
  for (const p of ['/dashboard/live', '/dashboard/performance', '/dashboard/quality', '/tickets', '/tickets/new', `/tickets/${ticket.id}`, '/bleeds', '/bleeds/new', `/bleeds/${bleed.id}`, '/nurses', '/contacts', '/search?q=Dr', '/account'])
    found.push(...(await scan(cs, p)));
  expect(found).toEqual([]);
});

test('accessibility: administration and the sample desk', async ({ browser }) => {
  const found: string[] = [];
  const admin = await signIn(browser, 'admin@baton.local');
  for (const p of ['/admin/users', '/admin/status', '/admin/audit', '/admin/canned_responses']) found.push(...(await scan(admin, p)));
  const pre = await signIn(browser, 'preanalytical@baton.local');
  found.push(...(await scan(pre, '/samples')));
  expect(found).toEqual([]);
});

test('accessibility: the nurse field app on a phone, light and dark', async ({ browser }) => {
  const nurse = await signIn(browser, 'nursing@baton.local', phone());
  const found = await scan(nurse, '/field');
  const run = await (await nurse.request.get('/api/field')).json();
  const r = run.requests?.[0] ?? run[0];
  if (r) found.push(...(await scan(nurse, `/field/r/${r.id}`)));
  await nurse.emulateMedia({ colorScheme: 'dark' });
  await nurse.evaluate(() => document.documentElement.classList.add('dark'));
  await still(nurse);
  const dark = await new AxeBuilder({ page: nurse }).withTags(['wcag2aa']).analyze();
  found.push(...dark.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `dark · ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' [' + (n.any[0]?.message ?? '') + ']').join(' | ')}`));
  expect(found).toEqual([]);
});
