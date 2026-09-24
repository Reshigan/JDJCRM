#!/usr/bin/env node
// Send one harmless HL7 status message to Baton's SkyLIMS listener and print the ACK.
// Usage: node scripts/hl7-ping.mjs [host] [port]   — exits 0 on MSA|AA.
import net from 'node:net';
const [host = '127.0.0.1', port = '2575'] = process.argv.slice(2);
const id = `PING${Date.now()}`;
const msg = `MSH|^~\\&|SKYLIMS|JDJLAB|BATON|JDJ|20260101000000||OML^O21|${id}|P|2.5\rORC|SC|RQ-PING|||SC`;
const s = net.connect(+port, host, () => s.write(Buffer.concat([Buffer.from([0x0b]), Buffer.from(msg), Buffer.from([0x1c, 0x0d])])));
s.setTimeout(5000, () => { console.error('no ACK within 5 s'); process.exit(3); });
s.on('error', (e) => { console.error(e.message); process.exit(2); });
s.on('data', (d) => {
  const ack = d.toString().replace(/[\x0b\x1c]/g, '').trim();
  console.log(ack.replace(/\r/g, '\n'));
  process.exit(new RegExp(`MSA\\|AA\\|${id}`).test(ack) ? 0 : 1);
});
