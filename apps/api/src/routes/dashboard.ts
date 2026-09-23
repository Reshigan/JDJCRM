// Central dashboard (brief §7): Client Services + Management only; department managers see their own department.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '@baton/core';
import { analytics, Filters, live } from '../analytics';
import { requirePerm } from '../auth';
import { audit, fail, sql } from '../db';
import { workbook } from '../reports';

export function dashboardRoutes(app: FastifyInstance) {
  const scoped = (req: any) => {
    const f = Filters.parse(req.query);
    if (can(req.user.role, 'dashboard.view')) return { f, full: true };
    if (req.user.role === 'dept_manager') return { f: { ...f, department_id: req.user.department_id }, full: false };
    return fail(403, 'The dashboard is for Client Services and Management');
  };

  app.get('/api/dashboard/live', async (req) => {
    requirePerm(req, 'dashboard.view');
    return live();
  });

  app.get('/api/analytics', async (req) => {
    const { f, full } = scoped(req);
    const a = await analytics(f);
    return full ? a : { ...a, bleeds: null }; // department managers: own department's queries only
  });

  app.get('/api/export.xlsx', async (req, reply) => {
    requirePerm(req, 'dashboard.export');
    const f = Filters.parse(req.query);
    const buf = await workbook(f);
    await audit(sql, { actor: req.user.id, action: 'export.xlsx', entity: 'report', id: `${f.from}..${f.to}`, data: f, ip: req.ip });
    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="baton-${f.from}-to-${f.to}.xlsx"`)
      .header('cache-control', 'private, no-store');
    return buf;
  });

  // Full search (brief §7): ticket number, patient, requisition, hospital, complainant — across queries and bleeds.
  app.get('/api/search', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    const like = `%${q}%`;
    const all = can(req.user.role, 'tickets.view_all');
    const [tickets, bleeds] = await Promise.all([
      sql`select t.id, t.number, t.state, t.complainant_name, t.patient_name, t.requisition_no, c.name as category, o.name as organisation, t.created_at
        from tickets t join categories c on c.id = t.category_id left join organisations o on o.id = t.organisation_id
        where (t.number ilike ${like} or t.patient_name ilike ${like} or t.requisition_no ilike ${like} or t.complainant_name ilike ${like} or o.name ilike ${like})
          and (${all} or exists (select 1 from assignments a where a.ticket_id = t.id and a.department_id = ${req.user.department_id} and a.state <> 'cancelled'))
        order by t.created_at desc limit 50`,
      all
        ? sql`select b.id, b.number, r.number as request_number, b.patient_name, b.folder_no, b.requisition_no, h.name as hospital, b.opened_at,
            b.closed_at, b.cancelled_at, b.outcome, b.filed_at, b.released_at, b.lab_accepted_at, b.received_at, b.captured_at, b.arrived_at
          from bleeds b join bleed_requests r on r.id = b.request_id join organisations h on h.id = r.hospital_id
          where b.number ilike ${like} or r.number ilike ${like} or b.patient_name ilike ${like} or b.requisition_no ilike ${like} or b.folder_no ilike ${like} or h.name ilike ${like}
          order by b.opened_at desc limit 50`
        : [],
    ]);
    return { tickets, bleeds };
  });
}
