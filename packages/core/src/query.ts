// Module A lifecycle (brief §5.1, §5.4). Shared by API (enforcement) and web (what to show).
import { can, type Role } from './roles';

export const QUERY_STATES = {
  new: 'New',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  response_submitted: 'Response Submitted',
  under_review: 'Under Review',
  client_contacted: 'Client Contacted',
  closed: 'Closed',
} as const;
export type QueryState = keyof typeof QUERY_STATES;

export const ASSIGNMENT_STATES = {
  assigned: 'Assigned',
  in_progress: 'In Progress',
  responded: 'Responded',
  accepted: 'Accepted',
  cancelled: 'Reassigned',
} as const;
export type AssignmentState = keyof typeof ASSIGNMENT_STATES;

export type Actor = { role: Role; department_id: number | null };
export type AssignmentLike = { state: AssignmentState; department_id: number };
export type TicketLike = { state: QueryState; effectiveness_due?: string | null; effectiveness_at?: string | Date | null };
export type CallLike = { cycle: number; satisfied: boolean };

const active = (as: AssignmentLike[]) => as.filter((a) => a.state !== 'cancelled');
const allIn = (as: AssignmentLike[], s: AssignmentState[]) => active(as).length > 0 && active(as).every((a) => s.includes(a.state));

/** Ticket state after any assignment change. Closed / Client Contacted are only left by explicit actions. */
export function deriveState(current: QueryState, as: AssignmentLike[]): QueryState {
  if (current === 'closed' || current === 'client_contacted') return current;
  if (allIn(as, ['responded', 'accepted'])) return current === 'under_review' ? 'under_review' : 'response_submitted';
  if (active(as).some((a) => a.state !== 'assigned')) return 'in_progress';
  return 'assigned';
}

export type TicketAction = 'review' | 'log_call' | 'close' | 'reopen' | 'reassign' | 'reprioritise' | 'check_effectiveness';
export type AssignmentAction = 'acknowledge' | 'respond' | 'return' | 'accept' | 'assign_user';

export function ticketActions(t: TicketLike, as: AssignmentLike[], u: Actor): TicketAction[] {
  const out: TicketAction[] = [];
  if (can(u.role, 'ticket.review') && t.state === 'response_submitted') out.push('review');
  if (can(u.role, 'ticket.review') && t.state === 'under_review' && allIn(as, ['accepted'])) out.push('log_call');
  if (can(u.role, 'ticket.close') && t.state === 'client_contacted') out.push('close');
  if (can(u.role, 'ticket.reopen') && t.state === 'closed') out.push('reopen');
  if (can(u.role, 'ticket.close') && t.state === 'closed' && t.effectiveness_due && !t.effectiveness_at) out.push('check_effectiveness');
  if (can(u.role, 'ticket.reassign') && !['closed', 'client_contacted'].includes(t.state)) out.push('reassign');
  if (can(u.role, 'ticket.reprioritise') && t.state !== 'closed') out.push('reprioritise');
  return out;
}

export function assignmentActions(t: TicketLike, a: AssignmentLike, u: Actor): AssignmentAction[] {
  if (t.state === 'closed' || a.state === 'cancelled') return [];
  const mine = can(u.role, 'assignment.respond') && u.department_id === a.department_id;
  const out: AssignmentAction[] = [];
  if (mine && a.state === 'assigned') out.push('acknowledge');
  if (mine && a.state === 'in_progress') out.push('respond');
  if (can(u.role, 'ticket.review') && t.state === 'under_review' && a.state === 'responded') out.push('return', 'accept');
  if (
    can(u.role, 'assignment.assign_user') &&
    (u.role === 'cs_supervisor' || u.department_id === a.department_id) &&
    ['assigned', 'in_progress'].includes(a.state)
  )
    out.push('assign_user');
  return out;
}

export type ChecklistItem = { key: string; label: string; ok: boolean };

/** Brief §5.4 closure gate. Close is allowed only when every item is ok. */
export function closureChecklist(p: {
  state: QueryState;
  assignments: AssignmentLike[];
  calls: CallLike[];
  cycle: number;
  closure_reason?: string | null;
  root_cause?: string | null;
}): ChecklistItem[] {
  const calls = p.calls.filter((c) => c.cycle === p.cycle);
  const last = calls[calls.length - 1];
  return [
    { key: 'responses', label: 'Departmental response accepted', ok: allIn(p.assignments, ['accepted']) },
    { key: 'call', label: 'Verification call recorded', ok: !!last },
    { key: 'satisfied', label: 'Client confirmed satisfied', ok: !!last?.satisfied },
    { key: 'reason', label: 'Closure reason', ok: !!p.closure_reason },
    { key: 'root_cause', label: 'Root cause category', ok: !!p.root_cause },
  ];
}
