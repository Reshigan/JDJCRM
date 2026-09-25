// POPIA minimisation: purge what is no longer needed, per the policy in Admin → Settings (retention_days).
import { rmSync } from 'node:fs';
import { audit, sql } from './db';
import { env } from './env';

export async function retentionTick() {
  const [s] = await sql`select value from settings where key = 'retention_days'`;
  const p = (s?.value ?? {}) as { bleed_photos?: number | null; attachments?: number | null; notifications?: number | null };
  const done: Record<string, number> = {};
  const purgeFiles = (ids: string[]) => ids.forEach((id) => rmSync(`${env.dataDir}/blobs/${id}`, { force: true }));

  if (p.bleed_photos) {
    const rows = await sql`delete from bleed_photos where bleed_id in (select id from bleeds where closed_at < now() - ${p.bleed_photos + ' days'}::interval) returning id`;
    purgeFiles(rows.map((r) => r.id));
    done.bleed_photos = rows.length;
  }
  if (p.attachments) {
    const rows = await sql`delete from attachments where ticket_id in (select id from tickets where closed_at < now() - ${p.attachments + ' days'}::interval) returning id`;
    purgeFiles(rows.map((r) => r.id));
    done.attachments = rows.length;
  }
  if (p.notifications) done.notifications = (await sql`delete from notifications where created_at < now() - ${p.notifications + ' days'}::interval returning 1`).length;

  if (Object.values(done).some(Boolean)) await audit(sql, { actor: null, action: 'retention.purged', entity: 'system', data: { ...done, policy: p } });
  return done;
}
