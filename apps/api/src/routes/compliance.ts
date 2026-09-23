// Insights and POPIA tooling.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth';
import { audit, fail, sql } from '../db';
import { insights } from '../insights';
import { status } from '../ops';

export function complianceRoutes(app: FastifyInstance) {
  app.get('/api/system/status', async (req) => {
    requirePerm(req, 'admin.configure');
    return status();
  });

  app.get('/api/insights', async (req) => {
    requirePerm(req, 'dashboard.view');
    return insights();
  });

  // POPIA s23 access request: every record held about a data subject, and everyone who accessed it.
  app.get('/api/popia/subject', async (req, reply) => {
    if (!['cs_supervisor', 'management'].includes(req.user.role)) fail(403, 'Client Services supervisors and management only');
    const { q } = z.object({ q: z.string().trim().min(3).max(100) }).parse(req.query);
    const like = `%${q}%`;
    const tickets = await sql`select id, number, created_at, state, complainant_name, patient_name, requisition_no, contact_phone, contact_email, description
      from tickets where patient_name ilike ${like} or complainant_name ilike ${like} or requisition_no ilike ${like} order by created_at`;
    const bleeds = await sql`select b.id, b.number, b.opened_at, b.patient_name, b.folder_no, b.ward, b.bed, b.requisition_no, b.outcome, h.name as hospital,
        (select count(*)::int from bleed_photos p where p.bleed_id = b.id) as photos
      from bleeds b join bleed_requests r on r.id = b.request_id join organisations h on h.id = r.hospital_id
      where b.patient_name ilike ${like} or b.folder_no ilike ${like} or b.requisition_no ilike ${like} order by b.opened_at`;
    const ids = [...tickets.map((t) => t.id), ...bleeds.map((b) => b.id)];
    const access = await sql`select l.at, u.name as by, u.role, l.action, l.entity, l.entity_id, l.ip from audit_log l left join users u on u.id = l.actor_id
      where l.entity_id = any(${ids}::text[]) and l.action in ('viewed', 'photo.viewed', 'attachment.viewed') order by l.at`;
    await audit(sql, { actor: req.user.id, action: 'popia.subject_export', entity: 'report', id: q, data: { tickets: tickets.length, bleeds: bleeds.length }, ip: req.ip });
    reply.header('content-disposition', `attachment; filename="popia-subject-${q.replace(/[^\w-]+/g, '_')}.json"`).header('cache-control', 'private, no-store');
    return { generated_at: new Date().toISOString(), query: q, tickets, bleeds, access_log: access };
  });
}
