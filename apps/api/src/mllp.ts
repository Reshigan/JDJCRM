// SkyLIMS HL7 v2 listener (MLLP over TCP, optionally TLS). Run as its own container: node dist/mllp.js
//   SKYLIMS_PORT (2575), SKYLIMS_ALLOW (comma-separated source IPs; empty = any), SKYLIMS_TLS_CERT / SKYLIMS_TLS_KEY (optional).
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { sql } from './db';
import { ack, DEFAULT_MAPPING, FS, frame, parse, toEvent, VT, type Hl7, type Mapping } from './hl7';
import { applyLisEvent } from './routes/integrations';

const SOURCE = 'SkyLIMS';
const MAX = 1024 * 1024;

async function mapping(): Promise<Mapping> {
  const [r] = await sql`select value from settings where key = 'skylims_mapping'`;
  return r?.value ?? DEFAULT_MAPPING;
}

const stat = (ok: boolean, detail: string) =>
  sql`insert into settings values ('skylims_last', ${sql.json({ at: new Date().toISOString(), ok, detail, errors: ok ? 0 : 1 })})
    on conflict (key) do update set value = jsonb_build_object('at', ${new Date().toISOString()}::text, 'ok', ${ok}, 'detail', ${detail}::text,
      'errors', coalesce((settings.value->>'errors')::int, 0) + ${ok ? 0 : 1}, 'last_error', case when ${ok} then settings.value->'last_error' else to_jsonb(${detail}::text) end)`;

/** One HL7 message in, one ACK out. Only the derived event is kept; the message itself (which may hold results) is discarded. */
export async function handle(text: string, ip?: string): Promise<string> {
  let m: Hl7 | null = null;
  try {
    m = parse(text);
    const e = toEvent(m, await mapping());
    if (!e.event) {
      await stat(true, `Ignored ${e.id}: not a mapped lab event`);
      return ack(m, 'AA', 'Not a Baton lab event; ignored');
    }
    if (!e.requisition_no) {
      await stat(false, `${e.id}: no requisition number in the mapped fields`);
      return ack(m, 'AE', 'No requisition number');
    }
    const r: any = await applyLisEvent({ event_id: `skylims:${e.id}`, event: e.event, requisition_no: e.requisition_no, at: e.at }, { source: SOURCE, ip });
    await stat(true, `${e.id}: ${e.event} ${r.ok ? `→ ${r.bleed}` : `not applied (${r.error})`}`);
    // Accept even when no bleed matches: most lab orders are not hospital bleeds, and a reject would make SkyLIMS resend forever.
    return ack(m, 'AA', r.ok ? `Recorded on ${r.bleed}` : r.error);
  } catch (err: any) {
    await stat(false, String(err.message)).catch(() => {});
    return ack(m, m ? 'AE' : 'AR', String(err.message));
  }
}

export function startMllp(port = Number(process.env.SKYLIMS_PORT ?? 2575)) {
  const allow = (process.env.SKYLIMS_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const onConn = (sock: net.Socket) => {
    const ip = (sock.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (allow.length && !allow.includes(ip)) return sock.destroy();
    let buf = Buffer.alloc(0);
    let chain = Promise.resolve(); // answer in order on one connection
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > MAX) return sock.destroy();
      for (let end; (end = buf.indexOf(FS)) >= 0; ) {
        const start = buf.indexOf(VT);
        const msg = buf.subarray(start >= 0 && start < end ? start + 1 : 0, end).toString('utf8');
        buf = buf.subarray(end + (buf[end + 1] === 0x0d ? 2 : 1));
        chain = chain.then(async () => { if (!sock.destroyed) sock.write(frame(await handle(msg, ip))); });
      }
    });
    sock.on('error', () => {});
    sock.setTimeout(10 * 60_000, () => sock.destroy());
  };
  const cert = process.env.SKYLIMS_TLS_CERT, key = process.env.SKYLIMS_TLS_KEY;
  const server = cert && key ? tls.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, onConn) : net.createServer(onConn);
  return server.listen(port);
}

if (/[\/]mllp\.[jt]s$/.test(process.argv[1] ?? '')) {
  startMllp();
  console.log(`[skylims] HL7 listener on :${process.env.SKYLIMS_PORT ?? 2575}${process.env.SKYLIMS_TLS_CERT ? ' (TLS)' : ''}`);
}
