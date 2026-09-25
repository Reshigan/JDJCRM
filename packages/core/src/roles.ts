// Brief §4. Per-department roles collapse into dept_responder / dept_manager scoped by department.
export const ROLES = {
  cs_agent: 'Client Services Agent',
  cs_supervisor: 'Client Services Supervisor',
  dept_responder: 'Department Responder',
  dept_manager: 'Department Manager',
  management: 'Management / Executive',
  admin: 'System Administrator',
} as const;
export type Role = keyof typeof ROLES;

const CS: Role[] = ['cs_agent', 'cs_supervisor'];

export const PERMISSIONS = {
  'ticket.open': CS, // rule 1: only Client Services opens
  'ticket.close': CS, // rule 1: only Client Services closes
  'ticket.review': CS,
  'ticket.reopen': CS,
  'ticket.reassign': CS,
  'ticket.reprioritise': ['cs_supervisor'],
  'assignment.respond': ['cs_agent', 'cs_supervisor', 'dept_responder', 'dept_manager'],
  'assignment.assign_user': ['cs_supervisor', 'dept_manager'],
  'tickets.view_all': ['cs_agent', 'cs_supervisor', 'management'],
  'dashboard.view': ['cs_agent', 'cs_supervisor', 'management'],
  'dashboard.export': ['cs_supervisor', 'management'],
  'admin.configure': ['admin'],
  'bleed.open': CS, // same rule as queries: only Client Services opens, cancels or closes a bleed
  'bleed.close': CS,
  'contact.merge': ['cs_supervisor'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role, p: Permission) => (PERMISSIONS[p] as readonly Role[]).includes(role);
