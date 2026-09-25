// Rotate the attachment master key: MASTER_KEY(_FILE) = current, NEW_MASTER_KEY(_FILE) = replacement.
// Re-wraps every per-file key in one transaction; files on disk are unchanged. Then swap the secret and restart.
import { readFileSync } from 'node:fs';
import { audit, sql } from './db';
import { env } from './env';
import { rewrap } from './crypto';

const key = (v?: string) => {
  const k = v ? Buffer.from(v, 'base64') : null;
  if (!k || k.length !== 32) throw new Error('keys must be 32 bytes, base64');
  return k;
};
const next = process.env.NEW_MASTER_KEY_FILE ? readFileSync(process.env.NEW_MASTER_KEY_FILE, 'utf8').trim() : process.env.NEW_MASTER_KEY;
const oldK = key(env.masterKey), newK = key(next);

const n = await sql.begin(async (tx) => {
  let count = 0;
  for (const t of ['attachments', 'bleed_photos'] as const)
    for (const r of await tx`select id, key_wrapped from ${tx(t)} for update`) {
      await tx`update ${tx(t)} set key_wrapped = ${rewrap(r.key_wrapped, oldK, newK)} where id = ${r.id}`;
      count++;
    }
  await audit(tx, { actor: null, action: 'security.master_key_rotated', entity: 'system', data: { files: count } });
  return count;
});
console.log(`re-wrapped ${n} file keys — now replace the master key secret and restart api + worker`);
await sql.end();
