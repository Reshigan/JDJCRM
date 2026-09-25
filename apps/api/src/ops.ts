// Operations: worker heartbeat, stale-worker watchdog, system status.
import { statfsSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { sql } from './db';
import { env } from './env';
import { notify } from './notify';
import { BRAND } from '@baton/core';

const setJson = (key: string, value: unknown) =>
  sql`insert into settings values (${key}, ${sql.json(value as any)}) on conflict (key) do update set value = excluded.value`;

/** Called at the end of every worker tick. */
export const heartbeat = (info: { escalated: number; error?: string }) =>
  setJson('worker_heartbeat', { at: new Date().toISOString(), host: hostname(), pid: process.pid, ...info });

/** Run by every API instance; the first to claim the alert sends it (at most hourly). */
export async function watchdog(now = new Date()) {
  const [hb] = await sql`select value from settings where key = 'worker_heartbeat'`;
  const age = hb ? (now.getTime() - new Date(hb.value.at).getTime()) / 60_000 : Infinity;
  if (age < 5) return false;
  const [claimed] = await sql`insert into settings values ('worker_alerted_at', ${sql.json(now.toISOString())})
    on conflict (key) do update set value = excluded.value
    where (settings.value #>> '{}')::timestamptz < ${now} - interval '1 hour' returning 1`;
  if (!claimed) return false;
  await notify(sql, { roles: ['admin', 'cs_supervisor'] }, {
    title: `${BRAND.product} worker has stopped — escalations and reports are paused`,
    body: hb ? `Last heartbeat ${Math.round(age)} min ago from ${hb.value.host}. Run: docker compose ps worker; docker compose logs worker.` : 'The worker has never reported.',
    link: '/admin/status',
  });
  return true;
}

function dirSize(dir: string) {
  let bytes = 0, files = 0;
  try {
    for (const f of readdirSync(dir)) { bytes += statSync(`${dir}/${f}`).size; files++; }
  } catch { /* not created yet */ }
  return { bytes, files };
}

export async function status() {
  const rows = await sql`select key, value from settings where key in ('worker_heartbeat', 'last_backup', 'report_last_daily', 'report_last_monthly', 'skylims_last')`;
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const [db] = await sql`select pg_database_size(current_database())::bigint as bytes, version() as version,
    (select count(*)::int from tickets) as tickets, (select count(*)::int from bleeds) as bleeds,
    (select count(*)::int from users where active) as users, (select count(*)::int from audit_log) as audit_entries,
    (select audit_verify()) as audit_broken_at,
    (select count(*)::int from sessions where expires_at > now()) as sessions`;
  const migrations = await sql`select name, at from schema_migrations order by name`;
  let disk: { free: number; total: number } | null = null;
  try { const f = statfsSync(env.dataDir); disk = { free: f.bavail * f.bsize, total: f.blocks * f.bsize }; } catch { /* ignore */ }
  const hbAge = s.worker_heartbeat ? (Date.now() - new Date(s.worker_heartbeat.at).getTime()) / 60_000 : null;
  return {
    worker: { ...s.worker_heartbeat, age_minutes: hbAge, healthy: hbAge != null && hbAge < 5 },
    last_backup: s.last_backup ?? null,
    skylims: s.skylims_last ?? null,
    reports: { daily: s.report_last_daily ?? null, monthly: s.report_last_monthly ?? null },
    database: { ...db, bytes: Number(db.bytes), audit_intact: db.audit_broken_at == null },
    files: { ...dirSize(`${env.dataDir}/blobs`), disk },
    migrations,
    api: { host: hostname(), uptime_s: Math.round(process.uptime()), node: process.version },
  };
}
