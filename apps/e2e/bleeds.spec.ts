import { expect, test } from '@playwright/test';
import { phone, png, signIn, uniq } from './helpers';

test('bleed journey: dispatch → nurse arrives in the geofence → captures OFFLINE → syncs → lab stages → report filed → closed', async ({ browser }) => {
  const tag = uniq();
  const cs = await signIn(browser, 'agent@crm.local');
  await cs.goto('/bleeds/new');
  await cs.locator('select').first().selectOption({ label: 'Demo General Hospital' });
  await expect(cs.getByText('Suggested')).toBeVisible();
  await cs.getByRole('radio', { name: /Sister Anne Botha/ }).click();
  await cs.getByPlaceholder('Sister Naidoo, Ward 4B').fill(`Ward 7 ${tag}`);
  await cs.getByLabel('Patient 1').fill(`Patient ${tag}`);
  await cs.getByRole('button', { name: /Log and dispatch/ }).click();
  await cs.waitForURL(/\/bleeds\/[0-9a-f-]{36}$/);
  const bleedUrl = cs.url();

  // Nurse, on a phone at the hospital.
  const nurse = await signIn(browser, 'nursing@crm.local', phone());
  await nurse.goto('/field');
  await nurse.locator('a', { hasText: `Ward 7 ${tag}` }).first().click();
  await expect(nurse.getByText('You are at Demo General Hospital')).toBeVisible();
  await nurse.getByRole('button', { name: "I've arrived" }).click();
  await expect(nurse.getByText('Arrival confirmed')).toBeVisible();
  await nurse.locator('.card', { hasText: `Patient ${tag}` }).getByRole('button', { name: 'Capture bleed' }).click();

  // A flat photo is flagged as blurry; a sharp retake clears the warning.
  await nurse.locator('input[type=file]').nth(0).setInputFiles({ name: 'req.png', mimeType: 'image/png', buffer: png(false) });
  await expect(nurse.getByRole('alert')).toContainText('looks blurry');
  await nurse.locator('input[type=file]').nth(0).setInputFiles({ name: 'req.png', mimeType: 'image/png', buffer: png(true) });
  await expect(nurse.getByRole('alert')).toHaveCount(0);
  await nurse.locator('input[type=file]').nth(1).setInputFiles({ name: 'sticker.png', mimeType: 'image/png', buffer: png(true) });
  await nurse.getByLabel('Hospital / folder no.').fill(`F-${tag}`);
  await nurse.getByLabel(/^Ward/).fill('7');
  await nurse.getByLabel(/^Bed/).fill('3');
  await nurse.getByLabel('Requisition no.').fill(`RQ-${tag}`);

  // Dead zone: no network at all.
  await nurse.context().setOffline(true);
  await nurse.getByRole('button', { name: 'Complete bleed' }).click();
  await expect(nurse.getByText('Saved on this phone')).toBeVisible();
  await expect(nurse.getByText('1 to sync')).toBeVisible();
  await expect(nurse.getByText('Offline')).toBeVisible();
  await nurse.waitForTimeout(1500);
  await nurse.context().setOffline(false);
  await expect(nurse.getByText('1 to sync')).toHaveCount(0, { timeout: 20_000 });

  // CS sees the capture with a late-sync flag.
  await cs.goto(bleedUrl);
  await expect(cs.getByText('In transit to lab').first()).toBeVisible();

  // Pre-Analytical and the laboratory, via the sample desk.
  const pre = await signIn(browser, 'preanalytical@crm.local');
  await pre.goto('/samples');
  await pre.getByPlaceholder(/Scan or type/).fill(`RQ-${tag}`);
  await pre.keyboard.press('Enter');
  await pre.locator('.card', { hasText: `RQ-${tag}` }).getByRole('button', { name: 'Accept sample in' }).click();
  const ana = await signIn(browser, 'analytical@crm.local');
  await ana.goto('/samples');
  await ana.getByPlaceholder(/Scan or type/).fill(`RQ-${tag}`);
  await ana.keyboard.press('Enter');
  await ana.locator('.card', { hasText: `RQ-${tag}` }).getByRole('button', { name: 'Accept into lab' }).click();
  await ana.getByPlaceholder(/Scan or type/).fill(`RQ-${tag}`);
  await ana.keyboard.press('Enter');
  await ana.locator('.card', { hasText: `RQ-${tag}` }).getByRole('button', { name: 'Results released' }).click();

  // Nurse files the report at the hospital.
  await nurse.goto('/field');
  await nurse.locator('a', { hasText: `Ward 7 ${tag}` }).first().click();
  await nurse.getByLabel('Report is in the patient folder').check();
  await nurse.getByRole('button', { name: /Confirm 1 report filed/ }).click();
  await expect(nurse.getByText('Reports filed')).toBeVisible();

  await cs.reload();
  await expect(cs.getByText('Report filed').first()).toBeVisible();
  await cs.getByRole('button', { name: 'Close ticket' }).click();
  await expect(cs.getByText('Closed').first()).toBeVisible();
  await expect(cs.getByText('Total turnaround')).toBeVisible();
});

test('a nurse outside the geofence cannot arrive until she gives a reason', async ({ browser }) => {
  const tag = uniq();
  const cs = await signIn(browser, 'agent@crm.local');
  const lk = await (await cs.request.get('/api/lookups')).json();
  const h = lk.organisations.find((o: any) => o.name === 'Demo General Hospital');
  const anne = lk.users.find((u: any) => u.name === 'Sister Anne Botha');
  expect((await cs.request.post('/api/bleed-requests', { data: { hospital_id: h.id, nurse_id: anne.id, requested_by: `Far ${tag}`, patients: [{ patient_name: `Far ${tag}` }] } })).ok()).toBe(true);

  const nurse = await signIn(browser, 'nursing@crm.local', phone({ latitude: -25.76, longitude: 28.26 })); // ~3.4 km away
  await nurse.goto('/field');
  await nurse.locator('a', { hasText: `Far ${tag}` }).click();
  await expect(nurse.getByText(/km/).first()).toBeVisible();
  const arrive = nurse.getByRole('button', { name: "I've arrived" });
  await expect(arrive).toBeDisabled();
  await nurse.getByText("I'm on site but outside the geofence").click();
  await expect(arrive).toBeDisabled();
  await nurse.getByPlaceholder(/Large campus/).fill('Main entrance closed, parked at block F');
  await expect(arrive).toBeEnabled();
  await arrive.click();
  await expect(nurse.getByText('Arrival confirmed')).toBeVisible();
  // Client Services sees it flagged as a geolocation exception.
  const bleed = (await (await cs.request.get(`/api/bleeds?q=${encodeURIComponent(`Far ${tag}`)}`)).json())[0];
  expect(bleed.geo_exception).toBe(true);
});
