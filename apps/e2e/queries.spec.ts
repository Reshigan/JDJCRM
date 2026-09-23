import { expect, test } from '@playwright/test';
import { signIn, uniq } from './helpers';

test('query journey: CS logs → two departments respond → CS reviews, calls, and closes', async ({ browser }) => {
  const tag = uniq();
  const cs = await signIn(browser, 'agent@baton.local');
  await cs.goto('/tickets/new');
  await cs.getByPlaceholder('Start typing to search previous complainants').fill(`Dr E2E ${tag}`);
  await cs.getByPlaceholder('Search practices and hospitals').fill('Parkview Medical Centre');
  await cs.getByLabel('Contact number').fill('012 555 0199');
  await cs.locator('select').filter({ hasText: 'Choose a category' }).selectOption({ label: 'Sample not received / sample lost' });
  await expect(cs.getByText('Routes to')).toBeVisible();
  await cs.getByRole('button', { name: 'High', exact: true }).click();
  await cs.locator('select').filter({ hasText: 'Choose a site' }).selectOption({ label: 'South Depot' });
  await cs.getByPlaceholder('What the complainant said, in their words.').fill(`E2E ${tag}: sample not received`);
  await cs.getByRole('button', { name: /Log and route/ }).click();
  await cs.waitForURL(/\/tickets\/[0-9a-f-]{36}$/);
  const ticketUrl = cs.url();
  await expect(cs.getByText('Pre-Analytical').first()).toBeVisible();

  for (const [email, dept] of [['preanalytical@baton.local', 'Pre-Analytical'], ['logistics@baton.local', 'Logistics']]) {
    const d = await signIn(browser, email);
    await d.goto(ticketUrl);
    const card = d.locator('div.rounded-xl', { hasText: dept }).first();
    await card.getByRole('button', { name: 'Acknowledge' }).click();
    await card.getByRole('button', { name: 'Submit response' }).click();
    await card.locator('textarea[name=findings]').fill(`${dept} investigated`);
    await card.locator('textarea[name=corrective_action]').fill('Corrected');
    await card.getByRole('button', { name: 'Return to Client Services' }).click();
    await expect(card.getByText('Responded', { exact: true })).toBeVisible();
    await d.context().close();
  }

  await cs.reload();
  await cs.getByRole('button', { name: 'Start review' }).click();
  const accept = cs.getByRole('button', { name: 'Accept', exact: true });
  for (const left of [1, 0]) {
    await accept.first().click();
    await expect(accept).toHaveCount(left);
  }
  await expect(cs.getByText('Verification call', { exact: true })).toBeVisible();
  await cs.locator('textarea[name=summary]').fill('Explained the corrective action');
  await cs.getByRole('button', { name: 'Satisfied', exact: true }).click();
  await cs.getByRole('button', { name: 'Record call' }).click();
  const close = cs.getByRole('button', { name: 'Close ticket' });
  await expect(close).toBeDisabled(); // gate: reason + root cause still missing
  await cs.getByLabel(/^Closure reason/).selectOption({ label: 'Resolved with corrective action' });
  await cs.getByLabel(/^Root cause/).selectOption({ label: 'Logistics' });
  await close.click();
  await expect(cs.getByText('Closed').first()).toBeVisible();
});
