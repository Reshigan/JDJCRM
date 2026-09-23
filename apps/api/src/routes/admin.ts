// System Administrator configuration (brief §4 firm requirement): no developer, no release.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES } from '@baton/core';
import { requirePerm } from '../auth';
import { audit, fail, sql } from '../db';
import { hashPassword } from '../crypto';

type Res = { pk?: string; cols: string[]; json?: string[]; del?: boolean; order: string };
const R: Record<string, Res> = {
  departments: { cols: ['code', 'name', 'active'], order: 'name' },
  sites: { cols: ['code', 'name', 'region', 'hours', 'active'], json: ['hours'], order: 'name' },
  holidays: { pk: 'day', cols: ['day', 'name'], del: true, order: 'day' },
  organisations: { cols: ['kind', 'name', 'address', 'phone', 'email', 'lat', 'lng', 'radius_m', 'site_id', 'active'], order: 'name' },
  categories: { cols: ['name', 'department_ids', 'clock', 'limit_critical', 'limit_high', 'limit_normal', 'active'], order: 'name' },
  ad_groups: { cols: ['group_dn', 'role', 'department_id', 'priority'], del: true, order: 'priority' },
  settings: { pk: 'key', cols: ['key', 'value'], json: ['value'], order: 'key' },
  users: { cols: ['email', 'name', 'role', 'department_id', 'site_id', 'auth', 'active'], order: 'name' },
};

const Params = z.object({ res: z.enum(Object.keys(R) as [string, ...string[]]), id: z.string().max(100).optional() });
const UserExtra = z.object({
  role: z.enum(Object.keys(ROLES) as [string, ...string[]]).optional(),
  password: z.string().min(10).max(200).optional(),
  reset_mfa: z.boolean().optional(),
});

function pick(r: Res, body: any) {
  const out: Record<string, unknown> = {};
  for (const c of r.cols) if (c in body) out[c] = r.json?.includes(c) ? sql.json(body[c]) : body[c] === '' ? null : body[c];
  return out;
}

export function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/admin/')) requirePerm(req, 'admin.configure');
  });

  app.get('/api/admin/:res', async (req) => {
    const { res } = Params.parse(req.params);
    const r = R[res];
    const cols = res === 'users' ? sql`id, email, name, role, department_id, site_id, auth, active, mfa_enabled, last_login_at, locked_until` : sql`*`;
    return sql`select ${cols} from ${sql(res)} order by ${sql(r.order)}`;
  });

  app.post('/api/admin/:res', async (req) => {
    const { res } = Params.parse(req.params);
    const b = req.body as any;
    const row = pick(R[res], b);
    if (res === 'users') {
      const x = UserExtra.parse(b);
      if (row.auth !== 'ad' && !x.password) fail(400, 'Local users need an initial password (min 10 characters)');
      if (x.password) row.password_hash = hashPassword(x.password);
    }
    const [out] = await sql`insert into ${sql(res)} ${sql(row)} returning ${sql(R[res].pk ?? 'id')} as id`;
    await audit(sql, { actor: req.user.id, action: `admin.${res}.created`, entity: res, id: out.id, data: { ...row, password_hash: undefined } });
    return out;
  });

  app.put('/api/admin/:res/:id', async (req) => {
    const { res, id } = Params.parse(req.params);
    const b = req.body as any;
    const row = pick(R[res], b);
    delete row[R[res].pk ?? 'id'];
    if (res === 'users') {
      const x = UserExtra.parse(b);
      if (x.password) row.password_hash = hashPassword(x.password);
      if (x.reset_mfa) Object.assign(row, { mfa_enabled: false, totp_secret: null });
      if (b.unlock) Object.assign(row, { failed_logins: 0, locked_until: null });
      if (x.password || x.reset_mfa || row.active === false) await sql`delete from sessions where user_id = ${id!}`;
    }
    if (!Object.keys(row).length) fail(400, 'Nothing to update');
    const [out] = await sql`update ${sql(res)} set ${sql(row)} where ${sql(R[res].pk ?? 'id')} = ${id!} returning 1`;
    if (!out) fail(404, 'Not found');
    await audit(sql, { actor: req.user.id, action: `admin.${res}.updated`, entity: res, id, data: { ...row, password_hash: row.password_hash ? '***' : undefined } });
    return { ok: true };
  });

  app.delete('/api/admin/:res/:id', async (req) => {
    const { res, id } = Params.parse(req.params);
    if (!R[res].del) fail(405, 'Deactivate instead of deleting');
    await sql`delete from ${sql(res)} where ${sql(R[res].pk ?? 'id')} = ${id!}`;
    await audit(sql, { actor: req.user.id, action: `admin.${res}.deleted`, entity: res, id });
    return { ok: true };
  });

  app.get('/api/admin-audit', async (req) => {
    requirePerm(req, 'admin.configure');
    const [{ broken }] = await sql`select audit_verify() as broken`;
    const rows = await sql`select l.id, l.at, l.action, l.entity, l.entity_id, l.ip, u.name as actor, l.hash
      from audit_log l left join users u on u.id = l.actor_id order by l.id desc limit 200`;
    return { intact: broken == null, broken_at: broken, rows };
  });
}
