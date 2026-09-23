import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  assignmentActions, can, CHANNELS, CLOSURE_REASONS, closureChecklist, COMPLAINANT_TYPES, deriveState, PRIORITIES,
  ROOT_CAUSES, sastYearMonth, ticketActions, type AssignmentAction, type TicketAction,
} from '@baton/core';
import { requirePerm } from '../auth';
import { audit, auditView, fail, sql, type Sql } from '../db';
import { decryptFile, encryptFile } from '../crypto';
import { env } from '../env';
import { notify } from '../notify';
import { limitFor, slaContext, type SlaContext } from '../sla';
import { range } from '../analytics';

const keys = <T extends object>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
const text = (max = 20_000) => z.string().trim().min(1).max(max);
const opt = (max = 500) => z.string().trim().max(max).optional().transform((v) => v || null);

const NewTicket = z
  .object({
    channel: z.enum(keys(CHANNELS)),
    complainant_type: z.enum(keys(COMPLAINANT_TYPES)),
    complainant_name: text(200),
    organisation_id: z.number().int().nullable().optional(),
    contact_phone: opt(50),
    contact_email: z.union([z.literal(''), z.email()]).optional().transform((v) => v || null),
    patient_name: opt(200),
    requisition_no: opt(50),
    site_id: z.number().int(),
    category_id: z.number().int(),
    priority: z.enum(keys(PRIORITIES)),
    description: text(),
  })
  .refine((t) => t.contact_phone || t.contact_email, { message: 'A contact number or e-mail is required', path: ['contact_phone'] })
  .refine((t) => t.organisation_id || t.complainant_type === 'patient' || t.complainant_type === 'internal', {
    message: 'Practice / hospital is required',
    path: ['organisation_id'],
  });

const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('acknowledge'), assignment_id: z.uuid() }),
  z.object({ action: z.literal('respond'), assignment_id: z.uuid(), findings: text(), corrective_action: text(), breach_reason: opt(2000) }),
  z.object({ action: z.literal('return'), assignment_id: z.uuid(), reason: text(2000) }),
  z.object({ action: z.literal('accept'), assignment_id: z.uuid() }),
  z.object({ action: z.literal('assign_user'), assignment_id: z.uuid(), user_id: z.uuid() }),
  z.object({ action: z.literal('review') }),
  z.object({
    action: z.literal('log_call'),
    called_at: z.coerce.date(),
    spoken_to: text(200),
    number_used: text(50),
    summary: text(),
    satisfied: z.boolean(),
    reopen_department_ids: z.array(z.number().int()).optional(),
  }),
  z.object({ action: z.literal('close'), closure_reason: z.enum(keys(CLOSURE_REASONS)), root_cause: z.enum(keys(ROOT_CAUSES)) }),
  z.object({ action: z.literal('reopen'), reason: text(2000), department_ids: z.array(z.number().int()).optional() }),
  z.object({ action: z.literal('reassign'), assignment_id: z.uuid(), department_id: z.number().int(), reason: text(2000) }),
  z.object({ action: z.literal('reprioritise'), priority: z.enum(keys(PRIORITIES)), reason: text(2000) }),
]);

async function load(db: Sql, id: string, forUpdate = false) {
  const [t] = forUpdate
    ? await db`select * from tickets where id = ${id} for update`
    : await db`select * from tickets where id = ${id}`;
  if (!t) fail(404, 'Ticket not found');
  const assignments = await db`select a.*, d.name as department, d.code as department_code, u.name as assignee
    from assignments a join departments d on d.id = a.department_id left join users u on u.id = a.assignee_id
    where ticket_id = ${id} order by a.created_at`;
  const calls = await db`select c.*, u.name as recorded_by_name from calls c join users u on u.id = c.recorded_by
    where ticket_id = ${id} order by c.created_at`;
  return { t, assignments, calls };
}

const DEPT_ROLES = ['dept_responder', 'dept_manager'];
const visible = (req: FastifyRequest, as: any[]) =>
  can(req.user.role, 'tickets.view_all') || (DEPT_ROLES.includes(req.user.role) && as.some((a) => a.department_id === req.user.department_id && a.state !== 'cancelled'));

/** Restart an assignment's clock (new cycle after reopen / not satisfied). */
async function restart(db: Sql, sla: SlaContext, t: any, a: any, limit: number) {
  const now = new Date();
  await db`update assignments set state = 'in_progress', started_at = ${now}, due_at = ${sla.due(t.site_id, now, limit, a.clock)},
    limit_minutes = ${limit}, responded_at = null, escalation_level = 0, breach_reason = null where id = ${a.id}`;
}

export function ticketRoutes(app: FastifyInstance) {
  app.get('/api/tickets', async (req) => {
    const q = z
      .object({
        scope: z.enum(['open', 'closed', 'all']).default('open'),
        q: z.string().trim().max(100).optional(),
        department_id: z.coerce.number().int().optional(),
        priority: z.enum(keys(PRIORITIES)).optional(),
        flag: z.enum(['green', 'amber', 'red']).optional(),
        state: z.string().max(30).optional(),
        category_id: z.coerce.number().int().optional(),
        site_id: z.coerce.number().int().optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    const [a, b] = q.from && q.to ? range({ from: q.from, to: q.to }) : [null, null];
    const all = can(req.user.role, 'tickets.view_all');
    if (!all && !req.user.department_id) return [];
    const dept = all ? q.department_id ?? null : req.user.department_id;
    const like = q.q ? `%${q.q}%` : null;
    const rows = await sql`
      select t.id, t.number, t.state, t.priority, t.created_at, t.site_id, t.complainant_name, t.patient_name, t.cycle,
        c.name as category, s.name as site, o.name as organisation,
        (select json_agg(json_build_object('id', a.id, 'department_id', a.department_id, 'department', d.name, 'code', d.code,
            'state', a.state, 'started_at', a.started_at, 'responded_at', a.responded_at, 'limit_minutes', a.limit_minutes,
            'clock', a.clock, 'due_at', a.due_at) order by d.name)
          from assignments a join departments d on d.id = a.department_id where a.ticket_id = t.id and a.state <> 'cancelled') as assignments
      from tickets t
      join categories c on c.id = t.category_id
      join sites s on s.id = t.site_id
      left join organisations o on o.id = t.organisation_id
      where t.type = 'query'
        and ${q.scope === 'open' ? sql`t.state <> 'closed'` : q.scope === 'closed' ? sql`t.state = 'closed'` : sql`true`}
        and (${q.state ?? null}::text is null or t.state = ${q.state ?? null})
        and (${q.priority ?? null}::text is null or t.priority = ${q.priority ?? null})
        and (${q.category_id ?? null}::int is null or t.category_id = ${q.category_id ?? null})
        and (${q.site_id ?? null}::int is null or t.site_id = ${q.site_id ?? null})
        and (${a}::timestamptz is null or (t.created_at >= ${a} and t.created_at < ${b}))
        and (${dept}::int is null or exists (select 1 from assignments a where a.ticket_id = t.id and a.department_id = ${dept} and a.state <> 'cancelled'))
        and (${like}::text is null or t.number ilike ${like} or t.complainant_name ilike ${like} or t.patient_name ilike ${like}
             or t.requisition_no ilike ${like} or o.name ilike ${like})
      order by t.created_at desc limit 500`;
    const sla = await slaContext(sql);
    const rank = { green: 0, amber: 1, red: 2 } as const;
    const out = rows.map((t) => {
      const as = (t.assignments ?? []).map((a: any) => ({ ...a, sla: sla.measure(t.site_id, a) }));
      const running = as.filter((a: any) => ['assigned', 'in_progress'].includes(a.state));
      const worst = running.reduce((w: any, a: any) => (rank[a.sla.flag as keyof typeof rank] > rank[w as keyof typeof rank] ? a.sla.flag : w), 'green');
      return { ...t, assignments: as, flag: t.state === 'closed' ? null : worst };
    });
    return q.flag ? out.filter((t) => t.flag === q.flag) : out;
  });

  app.get('/api/tickets/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { t, assignments, calls } = await load(sql, id);
    if (!visible(req, assignments)) fail(404, 'Ticket not found');
    await auditView(sql, req.user.id, 'ticket', id, req.ip);
    const sla = await slaContext(sql);
    const [meta, attachments, notes, timeline] = await Promise.all([
      sql`select c.name as category, c.clock, s.name as site, o.name as organisation, u.name as logged_by_name
          from tickets t join categories c on c.id = t.category_id join sites s on s.id = t.site_id
          left join organisations o on o.id = t.organisation_id join users u on u.id = t.logged_by where t.id = ${id}`,
      sql`select a.id, a.filename, a.mime, a.size, a.created_at, u.name as uploaded_by from attachments a join users u on u.id = a.uploaded_by where ticket_id = ${id} order by a.created_at`,
      sql`select n.id, n.body, n.created_at, u.name as author from notes n join users u on u.id = n.author_id where ticket_id = ${id} order by n.created_at`,
      sql`select l.id, l.at, l.action, l.data, u.name as actor from audit_log l left join users u on u.id = l.actor_id
          where entity = 'ticket' and entity_id = ${id} order by l.id`,
    ]);
    const me = { role: req.user.role, department_id: req.user.department_id };
    return {
      ...t,
      ...meta[0],
      assignments: assignments.map((a: any) => ({ ...a, sla: sla.measure(t.site_id, a), actions: assignmentActions(t as any, a as any, me) })),
      calls,
      attachments,
      notes,
      timeline,
      actions: ticketActions(t as any, assignments as any, me),
    };
  });

  app.post('/api/tickets', async (req, reply) => {
    requirePerm(req, 'ticket.open');
    const b = NewTicket.parse(req.body);
    const id = await sql.begin(async (tx) => {
      const [cat] = await tx`select * from categories where id = ${b.category_id} and active`;
      if (!cat) fail(400, 'Unknown category');
      const sla = await slaContext(tx);
      const now = new Date();
      const prefix = `QRY-${sastYearMonth(now)}`;
      const [{ n }] = await tx`insert into counters values (${prefix}, 1) on conflict (prefix) do update set n = counters.n + 1 returning n`;
      const number = `${prefix}-${String(n).padStart(4, '0')}`;
      const [t] = await tx`insert into tickets ${tx({ ...b, number, state: 'assigned', logged_by: req.user.id, created_at: now })} returning id, site_id, number`;
      const limit = limitFor(cat, b.priority);
      const depts = await tx`select id, name from departments where id = any(${cat.department_ids}) and active`;
      for (const d of depts)
        await tx`insert into assignments ${tx({ ticket_id: t.id, department_id: d.id, clock: cat.clock, limit_minutes: limit, started_at: now, due_at: sla.due(t.site_id, now, limit, cat.clock) })}`;
      await audit(tx, { actor: req.user.id, action: 'created', entity: 'ticket', id: t.id, data: { to: 'new', number } });
      await audit(tx, { actor: null, action: 'routed', entity: 'ticket', id: t.id, data: { to: 'assigned', departments: depts.map((d) => d.name), limit_minutes: limit, clock: cat.clock } });
      await notify(tx, { departments: depts.map((d) => d.id) }, { ticketId: t.id, number, title: `New ${b.priority} query · ${cat.name}`, body: b.description.slice(0, 500) });
      return t.id;
    });
    reply.code(201);
    return { id };
  });

  app.post('/api/tickets/:id/actions', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = Action.parse(req.body);
    const me = { role: req.user.role, department_id: req.user.department_id };
    await sql.begin(async (tx) => {
      const { t, assignments } = await load(tx, id, true);
      if (!visible(req, assignments)) fail(404, 'Ticket not found');
      const sla = await slaContext(tx);
      const [cat] = await tx`select * from categories where id = ${t.category_id}`;
      const log = (action: string, data: object = {}) => audit(tx, { actor: req.user.id, action, entity: 'ticket', id, data, ip: req.ip });
      let a: any;

      if ('assignment_id' in b && b.action !== 'reassign') {
        a = assignments.find((x) => x.id === b.assignment_id) ?? fail(404, 'Assignment not found');
        if (!assignmentActions(t as any, a, me).includes(b.action as AssignmentAction)) fail(409, `Cannot ${b.action} at this stage`);
      } else if (!ticketActions(t as any, assignments as any, me).includes(b.action as TicketAction)) fail(409, `Cannot ${b.action} at this stage`);

      switch (b.action) {
        case 'acknowledge':
          await tx`update assignments set state = 'in_progress', acknowledged_at = now(), assignee_id = coalesce(assignee_id, ${req.user.id}) where id = ${a.id}`;
          await log('acknowledged', { department: a.department });
          break;
        case 'respond': {
          const m = sla.measure(t.site_id, a);
          const breach = b.breach_reason ?? a.breach_reason;
          if (m.pct >= sla.thresholds[1] && !breach) fail(422, 'Time limit exceeded — a breach reason is required');
          await tx`update assignments set state = 'responded', responded_at = now(), findings = ${b.findings},
            corrective_action = ${b.corrective_action}, breach_reason = ${breach} where id = ${a.id}`;
          await log('responded', { department: a.department, pct: Math.round(m.pct), breach_reason: breach });
          await notify(tx, { users: [t.logged_by], roles: ['cs_supervisor'] }, { ticketId: id, number: t.number, title: `Response submitted · ${a.department}` });
          break;
        }
        case 'return':
          await tx`update assignments set state = 'in_progress', responded_at = null where id = ${a.id}`;
          await log('returned', { department: a.department, reason: b.reason });
          await notify(tx, { departments: [a.department_id] }, { ticketId: id, number: t.number, title: 'Response returned by Client Services', body: b.reason });
          break;
        case 'accept':
          await tx`update assignments set state = 'accepted' where id = ${a.id}`;
          await log('accepted', { department: a.department });
          break;
        case 'assign_user': {
          const [u] = await tx`select id, name from users where id = ${b.user_id} and department_id = ${a.department_id} and active`;
          if (!u) fail(400, 'User is not in this department');
          await tx`update assignments set assignee_id = ${u.id} where id = ${a.id}`;
          await log('assigned_user', { department: a.department, user: u.name });
          await notify(tx, { users: [u.id] }, { ticketId: id, number: t.number, title: 'Ticket assigned to you' });
          break;
        }
        case 'review':
          await tx`update tickets set state = 'under_review' where id = ${id}`;
          await log('state', { from: t.state, to: 'under_review' });
          break;
        case 'log_call': {
          await tx`insert into calls ${tx({ ticket_id: id, cycle: t.cycle, called_at: b.called_at, spoken_to: b.spoken_to, number_used: b.number_used, summary: b.summary, satisfied: b.satisfied, recorded_by: req.user.id })}`;
          await log('call_logged', { spoken_to: b.spoken_to, satisfied: b.satisfied });
          if (b.satisfied) {
            await tx`update tickets set state = 'client_contacted' where id = ${id}`;
            await log('state', { from: t.state, to: 'client_contacted' });
          } else {
            const reopen = assignments.filter((x) => x.state === 'accepted' && (!b.reopen_department_ids?.length || b.reopen_department_ids.includes(x.department_id)));
            if (!reopen.length) fail(400, 'Choose at least one department to reopen');
            for (const x of reopen) await restart(tx, sla, t, x, limitFor(cat, t.priority));
            await tx`update tickets set cycle = cycle + 1 where id = ${id}`;
            await log('not_satisfied', { departments: reopen.map((x) => x.department) });
            await notify(tx, { departments: reopen.map((x) => x.department_id) }, { ticketId: id, number: t.number, title: 'Client not satisfied — ticket back in progress', body: b.summary });
          }
          break;
        }
        case 'close': {
          const { calls } = await load(tx, id);
          const gate = closureChecklist({ state: t.state, assignments: assignments as any, calls: calls as any, cycle: t.cycle, ...b });
          const missing = gate.filter((i) => !i.ok).map((i) => i.label);
          if (missing.length) fail(409, `Cannot close: ${missing.join(', ')}`);
          await tx`update tickets set state = 'closed', closure_reason = ${b.closure_reason}, root_cause = ${b.root_cause},
            closed_at = now(), closed_by = ${req.user.id} where id = ${id}`;
          await log('state', { from: t.state, to: 'closed', closure_reason: b.closure_reason, root_cause: b.root_cause });
          break;
        }
        case 'reopen': {
          const reopen = assignments.filter((x) => x.state === 'accepted' && (!b.department_ids?.length || b.department_ids.includes(x.department_id)));
          if (!reopen.length) fail(400, 'Choose at least one department to reopen');
          for (const x of reopen) await restart(tx, sla, t, x, limitFor(cat, t.priority));
          await tx`update tickets set state = 'in_progress', cycle = cycle + 1, closure_reason = null, root_cause = null, closed_at = null, closed_by = null where id = ${id}`;
          await log('reopened', { reason: b.reason, departments: reopen.map((x) => x.department) });
          await notify(tx, { departments: reopen.map((x) => x.department_id) }, { ticketId: id, number: t.number, title: 'Ticket reopened', body: b.reason });
          break;
        }
        case 'reassign': {
          a = assignments.find((x) => x.id === b.assignment_id && !['cancelled', 'accepted'].includes(x.state)) ?? fail(404, 'Assignment not open');
          if (assignments.some((x) => x.department_id === b.department_id && x.state !== 'cancelled')) fail(409, 'Department already assigned');
          const [d] = await tx`select id, name from departments where id = ${b.department_id} and active`;
          if (!d) fail(400, 'Unknown department');
          const now = new Date();
          const limit = limitFor(cat, t.priority);
          await tx`update assignments set state = 'cancelled' where id = ${a.id}`;
          await tx`insert into assignments ${tx({ ticket_id: id, department_id: d.id, clock: cat.clock, limit_minutes: limit, started_at: now, due_at: sla.due(t.site_id, now, limit, cat.clock) })}`;
          await log('reassigned', { from: a.department, to: d.name, reason: b.reason });
          await notify(tx, { departments: [d.id] }, { ticketId: id, number: t.number, title: `Reassigned to ${d.name}`, body: b.reason });
          break;
        }
        case 'reprioritise': {
          const limit = limitFor(cat, b.priority);
          for (const x of assignments.filter((x) => ['assigned', 'in_progress'].includes(x.state)))
            await tx`update assignments set limit_minutes = ${limit}, due_at = ${sla.due(t.site_id, new Date(x.started_at), limit, x.clock)} where id = ${x.id}`;
          await tx`update tickets set priority = ${b.priority} where id = ${id}`;
          await log('reprioritised', { from: t.priority, to: b.priority, reason: b.reason });
          break;
        }
      }
      // Re-derive ticket state from department assignments.
      const [cur] = await tx`select state from tickets where id = ${id}`;
      const as = await tx`select state, department_id from assignments where ticket_id = ${id}`;
      const next = deriveState(cur.state, as as any);
      if (next !== cur.state) {
        await tx`update tickets set state = ${next} where id = ${id}`;
        await log('state', { from: cur.state, to: next });
        if (next === 'response_submitted')
          await notify(tx, { users: [t.logged_by], roles: ['cs_supervisor'] }, { ticketId: id, number: t.number, title: 'All departments have responded — ready for review' });
      }
      await tx`update tickets set updated_at = now() where id = ${id}`;
    });
    return { ok: true };
  });

  app.post('/api/tickets/:id/notes', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { body } = z.object({ body: text(10_000) }).parse(req.body);
    if (['management', 'admin'].includes(req.user.role)) fail(403, 'Read-only role');
    const { assignments } = await load(sql, id);
    if (!visible(req, assignments)) fail(404, 'Ticket not found');
    await sql`insert into notes (ticket_id, body, author_id) values (${id}, ${body}, ${req.user.id})`;
    await audit(sql, { actor: req.user.id, action: 'note', entity: 'ticket', id });
    return { ok: true };
  });

  app.post('/api/tickets/:id/attachments', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (['management', 'admin'].includes(req.user.role)) fail(403, 'Read-only role');
    const { assignments } = await load(sql, id);
    if (!visible(req, assignments)) fail(404, 'Ticket not found');
    const file = await req.file({ limits: { fileSize: 20 * 1024 * 1024 } });
    if (!file) fail(400, 'No file');
    const data = await file!.toBuffer();
    const { blob, keyWrapped } = encryptFile(data);
    const [row] = await sql`insert into attachments (ticket_id, filename, mime, size, key_wrapped, uploaded_by)
      values (${id}, ${file!.filename.slice(0, 200)}, ${file!.mimetype}, ${data.length}, ${keyWrapped}, ${req.user.id}) returning id`;
    mkdirSync(`${env.dataDir}/blobs`, { recursive: true });
    writeFileSync(`${env.dataDir}/blobs/${row.id}`, blob);
    await audit(sql, { actor: req.user.id, action: 'attachment_added', entity: 'ticket', id, data: { filename: file!.filename } });
    return { id: row.id };
  });

  app.get('/api/attachments/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [f] = await sql`select * from attachments where id = ${id}`;
    if (!f) fail(404, 'Not found');
    const { assignments } = await load(sql, f.ticket_id);
    if (!visible(req, assignments)) fail(404, 'Not found');
    const data = decryptFile(readFileSync(`${env.dataDir}/blobs/${id}`), f.key_wrapped);
    await audit(sql, { actor: req.user.id, action: 'attachment.viewed', entity: 'attachment', id, data: { ticket_id: f.ticket_id }, ip: req.ip });
    const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(f.mime);
    reply
      .header('content-type', inline ? f.mime : 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.filename)}"`)
      .header('cache-control', 'private, no-store');
    return data;
  });

  // Complainant register lookup, with repeat history (brief §5.2, §7 repeat complainant).
  app.get('/api/complainants', async (req) => {
    requirePerm(req, 'ticket.open');
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    return sql`
      select complainant_name as name, complainant_type as type, max(organisation_id) as organisation_id,
        (array_agg(contact_phone order by created_at desc) filter (where contact_phone is not null))[1] as contact_phone,
        (array_agg(contact_email order by created_at desc) filter (where contact_email is not null))[1] as contact_email,
        count(*)::int as total, count(*) filter (where created_at > now() - interval '90 days')::int as recent,
        count(*) filter (where state <> 'closed')::int as open,
        array_agg(category_id) as category_ids
      from tickets where complainant_name ilike ${'%' + q + '%'}
      group by complainant_name, complainant_type order by count(*) desc limit 8`;
  });
}
