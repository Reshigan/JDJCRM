import { expect, test } from '@playwright/test';
import { HOSPITAL, signIn, uniq } from './helpers';

// Letters only: the register's duplicate check ignores digits and punctuation in names.
const word = () => uniq().replace(/\d/g, (d) => 'abcdefghij'[+d]);

test('client register: intake files complainants; a supervisor merges a duplicate and its tickets follow', async ({ browser }) => {
  const w = word();
  const cs = await signIn(browser, 'agent@crm.local');
  const lk = await (await cs.request.get('/api/lookups')).json();
  const org = lk.organisations.find((o: any) => o.name.startsWith('Parkview'));
  const cat = lk.categories.find((c: any) => c.name.startsWith('Compliment'));
  for (const name of [`Dr Kgomotso ${w}`, `Kgomotso ${w}`])
    expect((await cs.request.post('/api/tickets', { data: { channel: 'telephone', complainant_type: 'doctor', complainant_name: name, organisation_id: org.id, contact_email: `${w}@example.test`, site_id: org.site_id, category_id: cat.id, priority: 'normal', description: `Register ${w}` } })).ok()).toBe(true);

  // Intake suggests the existing entry, with its practice and history.
  await cs.goto('/tickets/new');
  await cs.getByPlaceholder('Start typing to search previous complainants').fill(`Kgomotso ${w}`.slice(0, 12));
  await expect(cs.getByRole('button', { name: new RegExp(`Dr Kgomotso ${w} · Parkview`) })).toBeVisible();

  const sup = await signIn(browser, 'supervisor@crm.local');
  await sup.goto('/contacts');
  await sup.getByRole('button', { name: `Keep Dr Kgomotso ${w}`, exact: true }).click();
  await sup.getByPlaceholder('Search name, practice, phone or e-mail').fill(w);
  await expect(sup.locator('tbody tr')).toHaveCount(1);
  await sup.locator('tbody tr', { hasText: `Dr Kgomotso ${w}` }).getByRole('link', { name: '2', exact: true }).click();
  await expect(sup).toHaveURL(/contact_id=\d+/);
  await expect(sup.locator('tbody tr')).toHaveCount(2); // both tickets now belong to the kept entry
});

test('mentions notify a colleague; canned responses fill the response; a saved view restores the board filter', async ({ browser }) => {
  const w = word();
  const cs = await signIn(browser, 'agent@crm.local');
  const lk = await (await cs.request.get('/api/lookups')).json();
  const org = lk.organisations.find((o: any) => o.name.startsWith('Parkview'));
  const cat = lk.categories.find((c: any) => c.name.startsWith('Sample not received'));
  const p = await signIn(browser, 'preanalytical@crm.local');
  const pre = await (await p.request.get('/api/me')).json();
  const { id } = await (await cs.request.post('/api/tickets', { data: { channel: 'telephone', complainant_type: 'doctor', complainant_name: `Dr ${w}`, organisation_id: org.id, contact_phone: '012 555 0101', site_id: org.site_id, category_id: cat.id, priority: 'high', description: `Mention ${w}` } })).json();

  await cs.goto(`/tickets/${id}`);
  const note = cs.getByPlaceholder(/Add a note/);
  await note.fill(`@${pre.name.split(' ')[0]}`);
  await cs.getByRole('option', { name: pre.name }).click();
  await note.pressSequentially(`please check the fridge log ${w}`);
  await cs.getByRole('button', { name: 'Add note' }).click();
  await expect(cs.locator('span.text-brand', { hasText: `@${pre.name}` })).toBeVisible();
  await expect(cs.getByText(`mentioned ${pre.name}`)).toBeVisible();

  await p.goto(`/tickets/${id}`);
  await p.getByRole('button', { name: 'Notifications' }).click();
  await expect(p.getByText(/mentioned you/).first()).toBeVisible();
  await p.getByRole('button', { name: 'Notifications' }).click();
  const card = p.locator('div.rounded-xl', { hasText: 'Pre-Analytical' }).first();
  await card.getByRole('button', { name: 'Acknowledge' }).click();
  await card.getByRole('button', { name: 'Submit response' }).click();
  await card.getByLabel('Insert canned response').first().selectOption({ label: 'Sample located' });
  await expect(card.locator('textarea[name=findings]')).toHaveValue(/The sample was located/);

  // Saved view
  await cs.goto(`/tickets?priority=high&q=${w}`);
  await cs.getByRole('button', { name: 'Save view' }).click();
  await cs.getByPlaceholder('View name').fill(`High ${w}`);
  await cs.getByRole('button', { name: 'Save', exact: true }).click();
  await cs.goto('/tickets');
  await cs.getByRole('button', { name: `High ${w}`, exact: true }).click();
  await expect(cs).toHaveURL(new RegExp(`priority=high&q=${w}`));
  await cs.getByRole('button', { name: `Delete view High ${w}` }).click();
  await expect(cs.getByRole('button', { name: `High ${w}`, exact: true })).toHaveCount(0);
});

test('bulk close: Client Services closes every ended bleed in one step', async ({ browser }) => {
  const w = word();
  const cs = await signIn(browser, 'agent@crm.local');
  const lk = await (await cs.request.get('/api/lookups')).json();
  const h = lk.organisations.find((o: any) => o.name === 'Demo General Hospital');
  const anne = lk.users.find((u: any) => u.name === 'Sister Anne Botha');
  const r = await (await cs.request.post('/api/bleed-requests', { data: { hospital_id: h.id, nurse_id: anne.id, requested_by: `Bulk ${w}`, patients: [{ patient_name: `Bulk ${w}` }] } })).json();
  const nurse = await signIn(browser, 'nursing@crm.local');
  expect((await nurse.request.post(`/api/bleed-requests/${r.id}/arrive`, { data: { lat: HOSPITAL.latitude, lng: HOSPITAL.longitude, accuracy: 8 } })).ok()).toBe(true);
  expect((await nurse.request.post(`/api/bleeds/${r.bleed_ids[0]}/capture`, { multipart: { outcome: 'patient_refused', outcome_reason: 'Refused' } })).ok()).toBe(true);

  await cs.goto('/bleeds');
  await cs.getByRole('button', { name: /^Close \d+ ended$/ }).click();
  await expect(cs.getByRole('dialog').getByText(r.bleeds[0])).toBeVisible();
  await cs.getByRole('button', { name: 'Close all' }).click();
  await expect(cs.getByRole('button', { name: /^Close \d+ ended$/ })).toHaveCount(0);
  const [b] = await (await cs.request.get(`/api/bleeds?scope=all&q=${encodeURIComponent(`Bulk ${w}`)}`)).json();
  expect(b.state).toBe('closed');
});
