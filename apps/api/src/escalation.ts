// Brief §5.5: time-based automatic escalation at configurable % of the limit.
import { formatMinutes } from '@baton/core';
import { audit, sql } from './db';
import { notify } from './notify';
import { slaContext } from './sla';

const LEVELS = ['', 'Amber — 80% of time limit', 'Red — time limit breached', 'Escalated — 150% of time limit'];

export async function escalationTick(now = new Date()) {
  const sla = await slaContext(sql);
  const open = await sql`
    select a.*, t.number, t.site_id, d.name as department from assignments a
    join tickets t on t.id = a.ticket_id join departments d on d.id = a.department_id
    where a.state in ('assigned', 'in_progress') and t.state <> 'closed'`;
  let raised = 0;
  for (const a of open) {
    const m = sla.measure(a.site_id, a, now);
    if (m.level <= a.escalation_level) continue;
    await sql.begin(async (tx) => {
      const [locked] = await tx`update assignments set escalation_level = ${m.level}
        where id = ${a.id} and escalation_level < ${m.level} returning id`;
      if (!locked) return;
      await audit(tx, { actor: null, action: 'escalated', entity: 'ticket', id: a.ticket_id, data: { department: a.department, level: m.level, pct: Math.round(m.pct) } });
      const body = `${a.department}: ${formatMinutes(m.used)} used of ${formatMinutes(a.limit_minutes)}.`;
      const n = { ticketId: a.ticket_id, number: a.number, title: `${LEVELS[m.level]} · ${a.department}`, body };
      // One message per jump, to everyone owed a notice at any level crossed.
      const from = a.escalation_level + 1;
      const managersOnly = from > 1 || !!a.assignee_id;
      await notify(tx, {
        users: from === 1 && a.assignee_id ? [a.assignee_id] : [],
        departments: [a.department_id],
        deptRoles: managersOnly ? ['dept_manager'] : undefined,
        roles: [...(m.level >= 2 ? ['cs_supervisor'] : []), ...(m.level >= 3 ? ['management'] : [])],
      }, n);
      raised++;
    });
  }
  return raised;
}
