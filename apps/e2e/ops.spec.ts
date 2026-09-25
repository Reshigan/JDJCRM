import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// Run after ./scripts/backup.sh → restore.sh → rotate-key.sh (CI: E2E_AFTER_OPS=1).
test.skip(!process.env.E2E_AFTER_OPS, 'post-operations check: set E2E_AFTER_OPS=1 after a restore and key rotation');

test('after restore and key rotation: records, encrypted photos and the audit chain are intact', async ({ browser }) => {
  const cs = await signIn(browser, 'agent@baton.local');
  const bleeds = await (await cs.request.get('/api/bleeds?scope=all&limit=200')).json();
  expect(bleeds.length).toBeGreaterThan(5);
  let photo: string | undefined;
  for (const b of bleeds) {
    const d = await (await cs.request.get(`/api/bleeds/${b.id}`)).json();
    if (d.photos?.length) { photo = d.photos[0].id; break; }
  }
  expect(photo, 'a bleed with photos').toBeTruthy();
  const r = await cs.request.get(`/api/bleed-photos/${photo}`);
  expect(r.status()).toBe(200);
  expect((await r.body()).subarray(0, 4).toString('hex')).toMatch(/^(89504e47|ffd8ff)/); // decrypts to a real PNG / JPEG with the new key

  const admin = await signIn(browser, 'admin@baton.local');
  const s = await (await admin.request.get('/api/system/status')).json();
  expect(s.database.audit_intact).toBe(true);
  const audit = await (await admin.request.get('/api/admin-audit')).json();
  expect(audit.rows.some((x: any) => x.action === 'security.master_key_rotated')).toBe(true);
});
