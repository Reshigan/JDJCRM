import { expect, test, type Page } from '@playwright/test';
import { totp } from './helpers';

// A fresh production install (./scripts/init.sh, no demo data, two-factor enforced). CI runs this before seeding demo data.
test.skip(!process.env.E2E_FRESH_INSTALL, 'fresh-install check: set E2E_FRESH_INSTALL=1 against a new installation');

const ADMIN_PW = process.env.ADMIN_PASSWORD ?? 'ChangeMe!2026';
let adminSecret = '';

async function password(page: Page, user: string, pw: string) {
  await page.goto('/login');
  await page.getByLabel('E-mail or username').fill(user);
  await page.getByLabel('Password').fill(pw);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function code(page: Page, secret: string) {
  await page.getByLabel('Code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
}

test('first sign-in: the administrator must enrol two-factor, then sees a healthy system', async ({ page }) => {
  await password(page, 'admin@baton.local', ADMIN_PW);
  await expect(page.getByText(/requires two-factor sign-in/)).toBeVisible();
  await expect(page.getByAltText('Authenticator QR code')).toBeVisible();
  adminSecret = (await page.locator('code').first().innerText()).trim();
  await code(page, adminSecret);
  await page.waitForURL(/\/admin/);
  await page.goto('/admin/status');
  await expect(page.getByText(/hash chain verified/)).toBeVisible();
  await expect(page.getByText(/Last heartbeat/)).toBeVisible(); // the worker is running
  await expect(page.getByText(/007_register_quality/)).toBeVisible();
});

test('the administrator creates a Client Services user, who must also enrol two-factor', async ({ browser }) => {
  const admin = await browser.newPage();
  await password(admin, 'admin@baton.local', ADMIN_PW);
  await expect(admin.getByText('Enter your code')).toBeVisible();
  await code(admin, adminSecret);
  await admin.waitForURL(/\/admin/);
  await admin.goto('/admin/users');
  await admin.getByRole('button', { name: 'Add' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel(/^Name/).fill('Launch Agent');
  await dialog.getByLabel(/^E-mail/).fill('launch.agent@jdj.local');
  await dialog.getByLabel(/^Role/).selectOption({ label: 'Client Services Agent' });
  await dialog.getByLabel(/^Department/).selectOption({ label: 'Client Services' });
  await dialog.getByLabel(/^Set password/).fill('Launch!pass2026');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByRole('cell', { name: 'launch.agent@jdj.local' })).toBeVisible();

  const agent = await browser.newPage();
  await password(agent, 'launch.agent@jdj.local', 'Launch!pass2026');
  await expect(agent.getByText(/requires two-factor sign-in/)).toBeVisible();
  await code(agent, (await agent.locator('code').first().innerText()).trim());
  await agent.waitForURL((u) => !u.pathname.startsWith('/login'));
  await expect(agent.getByRole('link', { name: 'New query' })).toBeVisible();
});
