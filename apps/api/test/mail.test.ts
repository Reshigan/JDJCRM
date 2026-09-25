// E-mail as sent in production: over STARTTLS to a relay whose certificate comes from an internal CA,
// with only a title and a link in the message (POPIA minimisation).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SMTPServer } from 'smtp-server';

const url = process.env.TEST_DATABASE_URL;
const dir = mkdtempSync(`${tmpdir()}/baton-mail-`);
let openssl = true;
try {
  // A private CA and a relay certificate it signed, like an on-prem Exchange / Postfix relay.
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=JDJ Test CA" -keyout ca.key -out ca.pem 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout relay.key -out relay.csr 2>/dev/null
    printf "subjectAltName=DNS:localhost" > ext.cnf
    openssl x509 -req -in relay.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile ext.cnf -out relay.pem 2>/dev/null`, { cwd: dir, shell: '/bin/sh' });
} catch { openssl = false; }

const PORT = 20000 + Math.floor(Math.random() * 20000);
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = String(PORT);
process.env.SMTP_CA_FILE = `${dir}/ca.pem`;
process.env.APP_URL = 'https://baton.jdj.local';

describe.skipIf(!url || !openssl)('e-mail delivery (SMTP + STARTTLS + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  let app: Awaited<ReturnType<typeof buildApp>>;
  const inbox: { to: string[]; secure: boolean; raw: string }[] = [];
  let relay: SMTPServer;

  beforeAll(async () => {
    relay = new SMTPServer({
      key: readFileSync(`${dir}/relay.key`), cert: readFileSync(`${dir}/relay.pem`), authOptional: true,
      onData(stream, session, done) {
        let raw = '';
        stream.on('data', (d) => (raw += d));
        stream.on('end', () => { inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), secure: session.secure, raw }); done(); });
      },
    });
    await new Promise<void>((r) => relay.listen(PORT, '127.0.0.1', r));
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await sql.end();
    relay?.close();
  });

  it('a routed query e-mails the department over STARTTLS with a title and link, never the details', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'agent@baton.local', password: 'Baton!demo2026' } });
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    const lk = (await app.inject({ method: 'GET', url: '/api/lookups', headers: { cookie } })).json();
    const cat = lk.categories.find((c: any) => c.name.startsWith('Sample not received'));
    const org = lk.organisations.find((o: any) => o.kind === 'practice');
    const t = await app.inject({ method: 'POST', url: '/api/tickets', headers: { cookie }, payload: {
      channel: 'telephone', complainant_type: 'doctor', complainant_name: 'Dr Mail Test', organisation_id: org.id, contact_phone: '012 555 0100',
      patient_name: 'Johanna Secret', site_id: org.site_id, category_id: cat.id, priority: 'high', description: 'FBC for Johanna Secret lost in transit' } });
    expect(t.statusCode, t.body).toBe(201);
    for (let i = 0; i < 50 && !inbox.length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(inbox.length).toBe(1);
    const m = inbox[0];
    expect(m.secure).toBe(true); // upgraded with STARTTLS, trusting the relay via SMTP_CA_FILE
    expect(m.to).toContain('preanalytical@baton.local');
    const cut = m.raw.indexOf('\r\n\r\n');
    const head = m.raw.slice(0, cut), body = m.raw.slice(cut + 4);
    const subject = /^Subject: (.*(?:\r\n .*)*)/m.exec(head)![1].replace(/\r\n /g, '')
      .replace(/=\?UTF-8\?Q\?(.*?)\?=/g, (_, q) => Buffer.from(q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/g, (_x: string, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
    expect(subject).toBe('QRY-202609-0001 · New high query · Sample not received / sample lost'.replace('202609', subject.slice(4, 10)));
    const text = body.replace(/=\r?\n/g, ''); // quoted-printable soft breaks
    expect(text).toContain(`https://baton.jdj.local/tickets/${t.json().id}`);
    expect(m.raw).not.toMatch(/Johanna|Secret|lost in transit/);
  });
});
