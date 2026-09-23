import postgres from 'postgres';
import { env } from './env';

export const sql = postgres(env.databaseUrl, { max: 10, pass: env.dbPassword, onnotice: () => {}, transform: { undefined: null },
  types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } }, // keep SQL dates as 'YYYY-MM-DD'
});
export type Sql = typeof sql | postgres.TransactionSql;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

export function audit(
  db: Sql,
  e: { actor: string | null; action: string; entity: string; id?: string | number | null; data?: object; ip?: string },
) {
  return db`insert into audit_log (actor_id, action, entity, entity_id, data, ip)
    values (${e.actor}, ${e.action}, ${e.entity}, ${e.id == null ? null : String(e.id)}, ${db.json((e.data ?? {}) as any)}, ${e.ip ?? null})`;
}

/** Read audit for patient-identifiable records: one entry per user per record per 15 minutes. */
export async function auditView(db: Sql, actor: string, entity: string, id: string, ip?: string) {
  const [recent] = await db`select 1 from audit_log where actor_id = ${actor} and action = 'viewed' and entity = ${entity}
    and entity_id = ${id} and at > now() - interval '15 minutes' limit 1`;
  if (!recent) await audit(db, { actor, action: 'viewed', entity, id, ip });
}
