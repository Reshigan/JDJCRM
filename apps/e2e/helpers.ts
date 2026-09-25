import { deflateSync, crc32 } from 'node:zlib';
import { createHmac } from 'node:crypto';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

export const PASSWORD = 'Demo!crm2026';
export const HOSPITAL = { latitude: -25.7479, longitude: 28.2293 }; // Demo General Hospital

export async function signIn(browser: Browser, email: string, opts: BrowserContextOptions = {}): Promise<Page> {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('E-mail or username').fill(email);
  await page.getByLabel('Password').fill(email === 'admin@crm.local' ? 'ChangeMe!2026' : PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return page;
}

export const phone = (geo = HOSPITAL): BrowserContextOptions => ({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  permissions: ['geolocation'], geolocation: { ...geo, accuracy: 8 },
});

/** A real PNG. striped=true gives hard edges (sharp); false is a flat grey card (blurry by any measure). */
export function png(striped: boolean, w = 480, h = 320) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = striped ? ((x >> 2) % 2 ? 20 : 235) : 180;
      raw.set([v, v, v], y * (w * 3 + 1) + 1 + x * 3);
    }
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d] as Uint8Array[]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c] as Uint8Array[]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))] as Uint8Array[]);
}

export const uniq = () => Math.random().toString(36).slice(2, 7).toUpperCase();

/** RFC 6238 code for a base32 secret, as an authenticator app shows it. */
export function totp(secret: string, t = Date.now()) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
