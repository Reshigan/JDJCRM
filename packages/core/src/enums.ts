// Brief §5.2 / §5.4 dropdowns. Labels are UI copy; keys are stored.
export const CHANNELS = {
  telephone: 'Telephone',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
  walk_in: 'Walk-in',
  sales_rep: 'Sales representative',
  internal: 'Internal',
} as const;

export const COMPLAINANT_TYPES = {
  doctor: 'Doctor / practice',
  hospital: 'Hospital',
  patient: 'Patient',
  medical_aid: 'Medical aid',
  internal: 'Internal department',
} as const;

export const PRIORITIES = { critical: 'Critical', high: 'High', normal: 'Normal' } as const;

export const CLOSURE_REASONS = {
  resolved: 'Resolved',
  resolved_corrective: 'Resolved with corrective action',
  no_fault: 'No fault found',
  withdrew: 'Client withdrew',
} as const;

export const ROOT_CAUSES = {
  pre_analytical: 'Pre-analytical',
  analytical: 'Analytical',
  post_analytical: 'Post-analytical',
  logistics: 'Logistics',
  staff_conduct: 'Staff conduct',
  system: 'System',
  client_error: 'Client error',
  other: 'Other',
} as const;

export type Channel = keyof typeof CHANNELS;
export type ComplainantType = keyof typeof COMPLAINANT_TYPES;
export type Priority = keyof typeof PRIORITIES;
export type ClosureReason = keyof typeof CLOSURE_REASONS;
export type RootCause = keyof typeof ROOT_CAUSES;
