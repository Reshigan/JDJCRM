import postgres from 'postgres';
import { env } from './env';

export const sql = postgres(env.databaseUrl, { max: 10, onnotice: () => {}, transform: { undefined: null } });
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
