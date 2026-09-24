// SkyLIMS HL7 v2 feed: parsing, mapping to lab stages over a real MLLP socket, idempotency, minimisation, allow-list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const url = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL = url;
process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/baton-`);
process.env.NODE_ENV = 'test';

const msg = (id: string, type: string, segs: string[]) =>
  [`MSH|^~\\&|SKYLIMS|JDJLAB|BATON|JDJ|20260923101500||${type}|${id}|P|2.5`, ...segs].join('\r');
const status = (id: string, rq: string, orc5: string, at = '202609231000') =>
  msg(id, 'OML^O21', [`PID|1||F123^^^JDJ||Smith^Maria`, `ORC|SC|${rq}^HIS|L77^SKYLIMS||${orc5}`, `OBR|1|${rq}^HIS|L77^SKYLIMS|FBC^Full blood count||||||||||${at}`]);
const result = (id: string, rq: string, ...st: string[]) =>
  msg(id, 'ORU^R01', [`PID|1||F123^^^JDJ||Smith^Maria`, ...st.flatMap((s, i) => [`OBR|${i + 1}|${rq}^HIS|L77^SKYLIMS|K^Potassium||||||||||||||||||202609231130||CH|${s}`, `OBX|1|NM|K^Potassium||7.2|mmol/L`])]);

describe('SkyLIMS HL7 (unit)', async () => {
  const { parse, get, all, dtm, toEvent, DEFAULT_MAPPING } = await import('../src/hl7');
  it('reads fields, components and SAST timestamps', () => {
    const m = parse(result('M1', 'RQ-9', 'F', 'P'));
    expect(get(m, 'MSH-9')).toBe('ORU');
    expect(get(m, 'MSH-9.2')).toBe('R01');
    expect(get(m, 'OBR-2')).toBe('RQ-9');
    expect(all(m, 'OBR-25')).toEqual(['F', 'P']);
    expect(dtm('202609231130')?.toISOString()).toBe('2026-09-23T09:30:00.000Z');
    expect(dtm('20260923113000+0000')?.toISOString()).toBe('2026-09-23T11:30:00.000Z');
  });
  it('maps status and results; partial results are not "released"', () => {
    expect(toEvent(parse(status('M2', 'RQ-9', 'SC')), DEFAULT_MAPPING)).toMatchObject({ event: 'sample_received', requisition_no: 'RQ-9' });
    expect(toEvent(parse(status('M3', 'RQ-9', 'IP')), DEFAULT_MAPPING).event).toBe('lab_accepted');
    expect(toEvent(parse(result('M4', 'RQ-9', 'F', 'P')), DEFAULT_MAPPING).event).toBeNull();
    expect(toEvent(parse(result('M5', 'RQ-9', 'F', 'F')), DEFAULT_MAPPING).event).toBe('results_released');
  });
});

describe.skipIf(!url)('SkyLIMS feed (MLLP + DB)', async () => {
  const { sql } = await import('../src/db');
  const { seed } = await import('../src/seed');
  const { buildApp } = await import('../src/app');
  const { startMllp } = await import('../src/mllp');
  let app: Awaited<ReturnType<typeof buildApp>>;
  let server: net.Server;
  let port = 0;
  let cs = '';

  /** Send framed messages (optionally split mid-frame) and collect one ACK per message. */
  function send(messages: string[], split = false) {
    return new Promise<string[]>((resolve, reject) => {
      const acks: string[] = [];
      let buf = '';
      const s = net.connect(port, '127.0.0.1', () => {
        const wire = Buffer.concat(messages.map((m) => Buffer.concat([Buffer.from([0x0b]), Buffer.from(m), Buffer.from([0x1c, 0x0d])])));
        if (split) { s.write(wire.subarray(0, 7)); setTimeout(() => s.write(wire.subarray(7)), 50); } else s.write(wire);
      });
      s.on('data', (d) => {
        buf += d.toString();
        for (let i; (i = buf.indexOf('\x1c\r')) >= 0; ) { acks.push(buf.slice(1, i)); buf = buf.slice(i + 2); }
        if (acks.length === messages.length) { s.end(); resolve(acks); }
      });
      s.on('error', reject);
      s.on('close', () => acks.length < messages.length && resolve(acks));
    });
  }
  const msa = (a: string) => a.split('\r')[1].split('|');

  beforeAll(async () => {
    await sql.unsafe('drop schema public cascade; create schema public');
    await seed(true, false);
    app = await buildApp();
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'agent@baton.local', password: 'Baton!demo2026' } });
    cs = String(r.headers['set-cookie']).split(';')[0];
    server = startMllp(0);
    await new Promise((r) => server.once('listening', r));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    server?.close();
    await app?.close();
    await sql.end();
  });

  it('records received → accepted → released from SkyLIMS, once each, keeping no results', async () => {
    const [h] = await sql`select id from organisations where name = 'Demo General Hospital'`;
    const r = (await app.inject({ method: 'POST', url: '/api/bleed-requests', headers: { cookie: cs }, payload: { hospital_id: h.id, requested_by: 'W', patients: [{ patient_name: 'Maria Smith' }] } })).json();
    const id = r.bleed_ids[0];
    await sql`update bleeds set opened_at = now() - interval '60 min', arrived_at = now() - interval '50 min', captured_at = now() - interval '40 min',
      outcome = 'successful', requisition_no = 'RQ-SKY-1' where id = ${id}`;
    const t = (min: number) => new Date(Date.now() + 2 * 3_600_000 - min * 60_000).toISOString().replace(/\D/g, '').slice(0, 12);

    const acks = await send([status('S1', 'rq-sky-1', 'SC', t(30)), status('S1', 'RQ-SKY-1', 'SC'), result('S2', 'RQ-SKY-1', 'F', 'P')], true);
    expect(acks.map((a) => msa(a)[1])).toEqual(['AA', 'AA', 'AA']);
    expect(msa(acks[0])[3]).toMatch(/Recorded on BLD-/);
    expect(msa(acks[2])[3]).toMatch(/ignored/);
    let [b] = await sql`select received_at, lab_accepted_at, released_at from bleeds where id = ${id}`;
    expect((Date.now() - new Date(b.received_at).getTime()) / 60_000).toBeGreaterThan(29.9);
    expect((Date.now() - new Date(b.received_at).getTime()) / 60_000).toBeLessThan(31.1); // the time from OBR-14, not arrival
    expect(b.lab_accepted_at).toBeNull();

    await send([status('S3', 'RQ-SKY-1', 'IP'), result('S4', 'RQ-SKY-1', 'F', 'F')]);
    [b] = await sql`select lab_accepted_at, released_at from bleeds where id = ${id}`;
    expect(b.lab_accepted_at).not.toBeNull();
    expect(b.released_at).not.toBeNull();

    const audits = await sql`select action, data->>'source' as source from audit_log where entity = 'bleed' and entity_id = ${id} and action like 'bleed.%' and action <> 'bleed.opened'`;
    expect(audits.filter((a) => a.source === 'SkyLIMS').map((a) => a.action).sort()).toEqual(['bleed.lab_accept', 'bleed.receive', 'bleed.release']);
    const stored = JSON.stringify(await sql`select payload, result from lis_events where event_id like 'skylims:%'`);
    expect(stored).not.toMatch(/7\.2|Potassium|Smith|OBX/); // no results, no patient details
    const st = (await app.inject({ method: 'GET', url: '/api/system/status', headers: { cookie: (await login('admin@baton.local', 'ChangeMe!2026')) } })).json();
    expect(st.skylims.ok).toBe(true);
  });

  it('accepts unknown requisitions (not every order is a bleed) and rejects malformed input', async () => {
    const [a, bad, noReq] = await send([status('U1', 'RQ-NOPE', 'SC'), 'garbage', msg('U2', 'OML^O21', ['ORC|SC||||SC'])]);
    expect(msa(a).slice(1, 2)).toEqual(['AA']);
    expect(msa(a)[3]).toMatch(/No active bleed/);
    expect(msa(bad)[1]).toBe('AR');
    expect(msa(noReq)[1]).toBe('AE');
  });

  it('drops connections from addresses outside SKYLIMS_ALLOW', async () => {
    process.env.SKYLIMS_ALLOW = '10.9.9.9';
    const guarded = startMllp(0);
    await new Promise((r) => guarded.once('listening', r));
    const p = port;
    port = (guarded.address() as net.AddressInfo).port;
    expect(await send([status('X1', 'RQ-SKY-1', 'SC')])).toEqual([]);
    port = p;
    guarded.close();
    delete process.env.SKYLIMS_ALLOW;
  });

  async function login(u: string, p: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
    return String(r.headers['set-cookie']).split(';')[0];
  }
});
