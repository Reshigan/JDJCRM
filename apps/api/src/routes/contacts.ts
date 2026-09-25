// Client register (brief §5.2 "lookup against existing client register"): complainants under their practice / hospital.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COMPLAINANT_TYPES } from '@baton/core';
import { requirePerm } from '../auth';
import { audit, fail, sql } from '../db';

const STATS = sql`
  select c.id, c.name, c.type, c.organisation_id, o.name as organisation, c.phone, c.email, c.created_at,
    count(t.id)::int as total, count(t.id) filter (where t.state <> 'closed')::int as open, max(t.created_at) as last_at
  from contacts c left join organisations o on o.id = c.organisation_id left join tickets t on t.contact_id = c.id`;

export function contactRoutes(app: FastifyInstance) {
  app.get('/api/contacts', async (req) => {
    requirePerm(req, 'tickets.view_all');
    const q = z.object({ q: z.string().trim().max(100).optional(), organisation_id: z.coerce.number().int().optional() }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`${STATS}
      where c.merged_into is null
        and (${like}::text is null or c.name ilike ${like} or o.name ilike ${like} or c.phone ilike ${like} or c.email ilike ${like})
        and (${q.organisation_id ?? null}::int is null or c.organisation_id = ${q.organisation_id ?? null})
      group by c.id, o.name order by count(t.id) desc, c.name limit 200`;
  });

  // Likely duplicates: the same name once titles and punctuation are ignored ("Dr J. Smith" = "J Smith").
  // Phone numbers are not used: a practice's switchboard is shared by everyone who works there.
  app.get('/api/contacts/duplicates', async (req) => {
    requirePerm(req, 'contact.merge');
    const groups = await sql`select array_agg(id order by id) as ids from contacts where merged_into is null
      group by contact_key(name) having count(*) > 1 limit 100`;
    const ids = [...new Set(groups.flatMap((g) => g.ids))];
    const rows = ids.length ? await sql`${STATS} where c.id = any(${ids}) group by c.id, o.name` : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return groups.map((g) => g.ids.map((id: number) => byId.get(id)));
  });

  app.put('/api/contacts/:id', async (req) => {
    requirePerm(req, 'ticket.open');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({
      name: z.string().trim().min(1).max(200),
      type: z.enum(Object.keys(COMPLAINANT_TYPES) as [string, ...string[]]),
      organisation_id: z.number().int().nullable(),
      phone: z.string().trim().max(50).nullable(),
      email: z.union([z.literal(''), z.email()]).nullable().transform((v) => v || null),
    }).parse(req.body);
    const [r] = await sql`update contacts set ${sql(b)} where id = ${id} and merged_into is null returning id`;
    if (!r) fail(404, 'Contact not found');
    await audit(sql, { actor: req.user.id, action: 'contact.updated', entity: 'contact', id });
    return { ok: true };
  });

  // Merge a duplicate into the surviving entry: its tickets move over, its details fill any gaps, and it is retired.
  app.post('/api/contacts/:id/merge', async (req) => {
    requirePerm(req, 'contact.merge');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { into } = z.object({ into: z.number().int() }).parse(req.body);
    if (id === into) fail(400, 'Choose a different contact');
    return sql.begin(async (tx) => {
      const rows = await tx`select * from contacts where id in (${id}, ${into}) and merged_into is null for update`;
      const from = rows.find((r) => r.id === id)!;
      if (rows.length < 2) fail(404, 'Contact not found or already merged');
      const [{ count }] = await tx`with m as (update tickets set contact_id = ${into} where contact_id = ${id} returning 1) select count(*)::int from m`;
      await tx`update contacts set phone = coalesce(phone, ${from.phone}), email = coalesce(email, ${from.email}),
        organisation_id = coalesce(organisation_id, ${from.organisation_id}) where id = ${into}`;
      await tx`update contacts set merged_into = ${into} where id = ${id} or merged_into = ${id}`;
      await audit(tx, { actor: req.user.id, action: 'contact.merged', entity: 'contact', id: into, data: { from: id, name: from.name, tickets: count } });
      return { ok: true, tickets: count };
    });
  });
}
