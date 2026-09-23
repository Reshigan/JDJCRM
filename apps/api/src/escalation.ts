// Brief §5.5: time-based automatic escalation at configurable % of the limit.
import { audit, sql } from './db';
import { notify } from './notify';
import { slaContext } from './sla';
import { bleedIntervals, formatMinutes, INTERVALS, SAST_OFFSET } from '@baton/core';
import { bleedConfig } from './routes/bleeds';

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

/** Brief §6.5: amber → stage owner (early warning); red → Client Services + the owning department's manager. */
export async function bleedEscalationTick(now = new Date()) {
  const cfg = await bleedConfig(sql);
  const open = await sql`
    select b.*, r.nurse_id, r.number as request_number, h.name as hospital from bleeds b
    join bleed_requests r on r.id = b.request_id join organisations h on h.id = r.hospital_id
    where b.closed_at is null and b.cancelled_at is null and b.filed_at is null and coalesce(b.outcome, 'successful') = 'successful'`;
  const depts = Object.fromEntries((await sql`select code, id from departments`).map((d) => [d.code, d.id as number]));
  let raised = 0;
  for (const b of open) {
    const cur = bleedIntervals(b, cfg.limits, now, cfg.th).current;
    if (!cur) continue;
    const level = Math.min(2, cur.pct >= cfg.th[1] ? 2 : cur.pct >= cfg.th[0] ? 1 : 0);
    if (level <= (b.escalations?.[cur.index] ?? 0)) continue;
    await sql.begin(async (tx) => {
      const [ok] = await tx`update bleeds set escalations = escalations || ${tx.json({ [cur.index]: level })}
        where id = ${b.id} and coalesce((escalations ->> ${String(cur.index)})::int, 0) < ${level} returning id`;
      if (!ok) return;
      await audit(tx, { actor: null, action: 'bleed.escalated', entity: 'bleed', id: b.id, data: { interval: cur.label, level, pct: Math.round(cur.pct) } });
      const dept = depts[INTERVALS[cur.index].dept];
      const nurse = ['response', 'bleed', 'logistics', 'reporting'].includes(cur.key) && b.nurse_id ? [b.nurse_id] : [];
      const n = {
        link: level === 1 && nurse.length ? `/field/r/${b.request_id}` : `/bleeds/${b.id}`,
        number: b.number,
        title: `${level === 2 ? 'Red' : 'Amber'} · ${cur.label} · ${b.hospital}`,
        body: `${cur.label}: ${formatMinutes(cur.used)} of ${formatMinutes(cur.limit)}.`,
      };
      if (level === 1) await notify(tx, { users: nurse, departments: nurse.length ? [] : [dept], deptRoles: ['dept_responder', 'dept_manager'] }, n);
      else await notify(tx, { users: nurse, departments: [dept], deptRoles: ['dept_manager'], roles: ['cs_agent', 'cs_supervisor'] }, n);
      raised++;
    });
  }
  return raised;
}

/** Corrective-action effectiveness checks that fall due today: remind whoever closed the ticket, and CS supervisors, once. */
export async function effectivenessTick() {
  const today = new Date(Date.now() + SAST_OFFSET).toISOString().slice(0, 10);
  const due = await sql`update tickets set effectiveness_reminded = true
    where state = 'closed' and effectiveness_due <= ${today} and effectiveness_at is null and not effectiveness_reminded
    returning id, number, closed_by`;
  for (const t of due)
    await notify(sql, { users: [t.closed_by], roles: ['cs_supervisor'] }, { ticketId: t.id, number: t.number, title: 'Corrective action effectiveness check due' });
  return due.length;
}
