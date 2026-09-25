// Minimal HL7 v2 for the SkyLIMS feed: parse, read fields by path, map to CRM lab events, ACK, MLLP framing.
import { SAST_OFFSET } from '@baton/core';

export type Hl7 = { segments: string[][]; sep: { field: string; comp: string; rep: string } };

export function parse(text: string): Hl7 {
  const lines = text.split(/\r\n|\r|\n/).filter(Boolean);
  if (!lines[0]?.startsWith('MSH') || lines[0].length < 8) throw new Error('Not an HL7 v2 message (no MSH segment)');
  const field = lines[0][3];
  const enc = lines[0].slice(4, 8);
  const segments = lines.map((l) => {
    const f = l.split(field);
    return f[0] === 'MSH' ? ['MSH', field, ...f.slice(1)] : f; // MSH-1 is the separator itself
  });
  return { segments, sep: { field, comp: enc[0], rep: enc[1] } };
}

/** Values of `SEG-field[.component]` in every occurrence of SEG (first repetition; component 1 unless given). */
export function all(m: Hl7, path: string): string[] {
  const x = /^([A-Z0-9]{3})-(\d+)(?:\.(\d+))?$/.exec(path);
  if (!x) throw new Error(`Bad HL7 path "${path}"`);
  const [, seg, f, c] = x;
  return m.segments.filter((s) => s[0] === seg).map((s) => (s[+f] ?? '').split(m.sep.rep)[0].split(m.sep.comp)[+(c ?? 1) - 1] ?? '');
}
export const get = (m: Hl7, path: string) => all(m, path)[0] ?? '';

/** HL7 DTM (YYYYMMDDHHMM[SS[.S]][±ZZZZ]); no zone means SAST. */
export function dtm(v: string): Date | undefined {
  const x = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?([+-]\d{4})?$/.exec(v);
  if (!x) return undefined;
  const [, y, mo, d, h, mi, s = '00', z] = x;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const off = z ? (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(3)) * 60_000 : SAST_OFFSET;
  return new Date(utc - off);
}

export type Mapping = {
  requisition: string[]; // paths tried in order; the first non-empty value is the requisition number
  events: { event: 'sample_received' | 'lab_accepted' | 'results_released'; match: Record<string, string>; time?: string[] }[];
};

/** Starting point until Mukon's interface specification is in hand. Editable in Admin → Settings (skylims_mapping). */
export const DEFAULT_MAPPING: Mapping = {
  requisition: ['ORC-2', 'OBR-2', 'ORC-3', 'OBR-3'],
  events: [
    { event: 'sample_received', match: { 'MSH-9': '^(ORM|OML|OUL|SSU)$', 'ORC-5': '^SC$' }, time: ['OBR-14', 'MSH-7'] },
    { event: 'lab_accepted', match: { 'MSH-9': '^(ORM|OML|OUL|SSU)$', 'ORC-5': '^IP$' }, time: ['MSH-7'] },
    { event: 'results_released', match: { 'MSH-9': '^ORU$', 'OBR-25': '^F$' }, time: ['OBR-22', 'MSH-7'] },
  ],
};

/** First rule whose every path matches in every occurrence of its segment (e.g. all OBR final = all results released). */
export function toEvent(m: Hl7, map: Mapping) {
  const id = get(m, 'MSH-10');
  if (!id) throw new Error('MSH-10 (message control id) is missing');
  const rule = map.events.find((r) => Object.entries(r.match).every(([p, re]) => { const v = all(m, p); return v.length > 0 && v.every((x) => new RegExp(re).test(x)); }));
  if (!rule) return { id, event: null };
  const requisition_no = map.requisition.map((p) => get(m, p)).find(Boolean);
  const at = (rule.time ?? []).map((p) => dtm(get(m, p))).find(Boolean);
  return { id, event: rule.event, requisition_no, at };
}

const clean = (s: string) => s.replace(/[|^~\\&\r\n]/g, ' ').slice(0, 80);
export function ack(m: Hl7 | null, code: 'AA' | 'AE' | 'AR', text: string) {
  const g = (p: string) => (m ? clean(get(m, p)) : '');
  const ts = new Date(Date.now() + SAST_OFFSET).toISOString().replace(/\D/g, '').slice(0, 14) + '+0200';
  return [
    `MSH|^~\\&|CRM|JDJ|${g('MSH-3')}|${g('MSH-4')}|${ts}||ACK^${g('MSH-9.2')}|ACK${Date.now()}|P|${g('MSH-12') || '2.5'}`,
    `MSA|${code}|${g('MSH-10')}|${clean(text)}`,
  ].join('\r');
}

// MLLP: <VT> message <FS><CR>
export const VT = 0x0b, FS = 0x1c, CR = 0x0d;
export const frame = (s: string) => Buffer.concat([Buffer.from([VT]), Buffer.from(s, 'utf8'), Buffer.from([FS, CR])]);
