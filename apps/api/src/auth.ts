import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { can, type Permission, type Role } from '@baton/core';
import { audit, fail, sql } from './db';
import { env } from './env';
import { hashPassword, sha256, token, totpSecret, verifyPassword, verifyTotp } from './crypto';
import { adAuthenticate } from './ldap';

export type User = { id: string; email: string; name: string; role: Role; department_id: number | null; site_id: number | null; mfa_enabled: boolean };
declare module 'fastify' {
  interface FastifyRequest { user: User; sid: string; mfaOk: boolean }
  interface FastifyContextConfig { auth?: 'public' | 'partial' }
}

const COOKIE = 'baton_sid';
const TTL_H = 12;
const secure = env.appUrl.startsWith('https');

export const requirePerm = (req: FastifyRequest, p: Permission) => can(req.user.role, p) || fail(403, 'Not permitted for your role');

async function mfaRequired(u: any) {
  if (u.mfa_enabled) return true;
  const [s] = await sql`select value from settings where key = 'mfa_enforced_roles'`;
  return ((s?.value ?? []) as string[]).includes(u.role);
}

export function authPlugin(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    const mode = req.routeOptions.config?.auth;
    if (mode === 'public' || !req.url.startsWith('/api/')) return;
    const raw = req.cookies[COOKIE];
    const [row] = raw
      ? await sql`
          update sessions s set expires_at = now() + ${TTL_H + ' hours'}::interval
          from users u where s.id = ${sha256(raw)} and u.id = s.user_id and s.expires_at > now() and u.active
          returning s.id as sid, s.mfa_ok, u.id, u.email, u.name, u.role, u.department_id, u.site_id, u.mfa_enabled`
      : [];
    if (!row) fail(401, 'Sign in required');
    req.sid = row.sid;
    req.mfaOk = row.mfa_ok;
    req.user = { id: row.id, email: row.email, name: row.name, role: row.role, department_id: row.department_id, site_id: row.site_id, mfa_enabled: row.mfa_enabled };
    if (!row.mfa_ok && mode !== 'partial') fail(401, 'Two-factor verification required');
  });

  const Login = z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(500) });

  app.post('/api/auth/login', { config: { auth: 'public' } }, async (req, reply) => {
    const { username, password } = Login.parse(req.body);
    let [u] = await sql`select * from users where email = ${username}`;

    if (u?.locked_until && new Date(u.locked_until) > new Date()) fail(423, 'Account temporarily locked. Try again later.');
    if (u && !u.active) fail(401, 'Invalid credentials');

    let ok = false;
    if (!u || u.auth === 'ad') {
      const ad = await adAuthenticate(username, password);
      if (ad) {
        const [map] = await sql`select role, department_id from ad_groups where lower(group_dn) = any(${ad.groups}) order by priority limit 1`;
        if (!map) fail(403, 'Your AD account is not in a Baton group. Ask the administrator.');
        [u] = await sql`
          insert into users (email, name, role, department_id, auth) values (${ad.email}, ${ad.name}, ${map.role}, ${map.department_id}, 'ad')
          on conflict (email) do update set name = excluded.name, role = excluded.role, department_id = excluded.department_id
            where users.auth = 'ad'
          returning *`;
        ok = !!u?.active;
      }
    } else ok = verifyPassword(password, u.password_hash);

    if (!ok || !u) {
      if (u) await sql`update users set failed_logins = failed_logins + 1,
        locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' end where id = ${u.id}`;
      await audit(sql, { actor: u?.id ?? null, action: 'auth.failed', entity: 'user', id: u?.id, data: { username }, ip: req.ip });
      fail(401, 'Invalid credentials');
    }
    const needMfa = await mfaRequired(u);
    const t = token();
    await sql`insert into sessions (id, user_id, mfa_ok, expires_at) values (${sha256(t)}, ${u.id}, ${!needMfa}, now() + ${TTL_H + ' hours'}::interval)`;
    await sql`update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = ${u.id}`;
    await audit(sql, { actor: u.id, action: 'auth.login', entity: 'user', id: u.id, data: { method: u.auth }, ip: req.ip });
    reply.setCookie(COOKIE, t, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
    return { mfa: !needMfa ? 'ok' : u.mfa_enabled ? 'verify' : 'setup' };
  });

  app.post('/api/auth/mfa/setup', { config: { auth: 'partial' } }, async (req) => {
    if (req.user.mfa_enabled) fail(409, 'Two-factor already enabled');
    const secret = totpSecret();
    await sql`update users set totp_secret = ${secret} where id = ${req.user.id}`;
    const uri = `otpauth://totp/Baton:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=Baton`;
    return { secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  });

  app.post('/api/auth/mfa/verify', { config: { auth: 'partial' } }, async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    const [u] = await sql`select totp_secret, mfa_enabled from users where id = ${req.user.id}`;
    if (!u.totp_secret || !verifyTotp(u.totp_secret, code)) {
      const [l] = await sql`update users set failed_logins = failed_logins + 1,
        locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' end where id = ${req.user.id} returning locked_until`;
      if (l.locked_until) await sql`delete from sessions where user_id = ${req.user.id}`;
      await audit(sql, { actor: req.user.id, action: 'auth.mfa_failed', entity: 'user', id: req.user.id, ip: req.ip });
      fail(401, 'Code not accepted');
    }
    await sql`update users set mfa_enabled = true, failed_logins = 0 where id = ${req.user.id}`;
    await sql`update sessions set mfa_ok = true where id = ${req.sid}`;
    if (!u.mfa_enabled) await audit(sql, { actor: req.user.id, action: 'auth.mfa_enabled', entity: 'user', id: req.user.id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/logout', { config: { auth: 'partial' } }, async (req, reply) => {
    await sql`delete from sessions where id = ${req.sid}`;
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const { current, next } = z.object({ current: z.string(), next: z.string().min(10).max(200) }).parse(req.body);
    const [u] = await sql`select auth, password_hash from users where id = ${req.user.id}`;
    if (u.auth !== 'local') fail(409, 'Your password is managed by Active Directory');
    if (!verifyPassword(current, u.password_hash)) fail(401, 'Current password is incorrect');
    await sql`update users set password_hash = ${hashPassword(next)} where id = ${req.user.id}`;
    await sql`delete from sessions where user_id = ${req.user.id} and id <> ${req.sid}`;
    await audit(sql, { actor: req.user.id, action: 'auth.password_changed', entity: 'user', id: req.user.id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/me', { config: { auth: 'partial' } }, async (req) => ({ ...req.user, mfa_ok: req.mfaOk }));
}
