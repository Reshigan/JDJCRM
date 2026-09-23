import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db';

export function miscRoutes(app: FastifyInstance) {
  app.get('/api/health', { config: { auth: 'public' } }, async () => {
    await sql`select 1`;
    return { ok: true };
  });

  // Reference data for forms and filters.
  app.get('/api/lookups', async (req) => {
    const [departments, sites, categories, organisations, users, [th]] = await Promise.all([
      sql`select id, code, name from departments where active order by name`,
      sql`select id, code, name, region from sites where active order by name`,
      sql`select id, name, department_ids, clock, limit_critical, limit_high, limit_normal from categories where active order by name`,
      sql`select id, kind, name, site_id, nurse_id from organisations where active order by name`,
      sql`select id, name, role, department_id from users where active and department_id is not null order by name`,
      sql`select value from settings where key = 'escalation_thresholds'`,
    ]);
    const [[bl], canned] = await Promise.all([
      sql`select value from settings where key = 'bleed_limits'`,
      sql`select id, title, body from canned_responses where active and (department_id is null or department_id = ${req.user.department_id}) order by title`,
    ]);
    return { departments, sites, categories, organisations, users, thresholds: th?.value, bleed_limits: bl?.value, canned };
  });

  app.get('/api/notifications', async (req) => {
    const rows = await sql`select n.id, n.ticket_id, n.link, n.title, n.body, n.read_at, n.created_at, t.number
      from notifications n left join tickets t on t.id = n.ticket_id
      where user_id = ${req.user.id} order by n.id desc limit 50`;
    const [{ unread }] = await sql`select count(*)::int as unread from notifications where user_id = ${req.user.id} and read_at is null`;
    return { unread, rows };
  });

  // Saved board views: a name for a filter query string, per user.
  const Page = z.enum(['tickets', 'bleeds']);
  app.get('/api/views', async (req) => {
    const { page } = z.object({ page: Page }).parse(req.query);
    return sql`select id, name, query from saved_views where user_id = ${req.user.id} and page = ${page} order by name`;
  });
  app.post('/api/views', async (req) => {
    const b = z.object({ page: Page, name: z.string().trim().min(1).max(60), query: z.string().max(1000) }).parse(req.body);
    const [v] = await sql`insert into saved_views ${sql({ ...b, user_id: req.user.id })}
      on conflict (user_id, page, name) do update set query = excluded.query returning id`;
    return v;
  });
  app.delete('/api/views/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    await sql`delete from saved_views where id = ${id} and user_id = ${req.user.id}`;
    return { ok: true };
  });

  app.post('/api/notifications/read', async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {});
    await sql`update notifications set read_at = now() where user_id = ${req.user.id} and read_at is null
      and (${ids ?? null}::bigint[] is null or id = any(${ids ?? null}::bigint[]))`;
    return { ok: true };
  });
}
