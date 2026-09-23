// Excel export of any analytics view + scheduled daily / monthly e-mail summaries (brief §7).
import ExcelJS from 'exceljs';
import { bleedIntervals, bleedState, BLEED_STATES, formatMinutes, INTERVALS, patientRef, QUERY_STATES, sast, SAST_OFFSET } from '@baton/core';
import { analytics, bleedRows, queryRows, type Filters } from './analytics';
import { audit, sql } from './db';
import { sendMail } from './notify';
import { bleedConfig } from './routes/bleeds';

const mins = (m: number | null | undefined) => (m == null ? '' : Math.round(m));

export async function workbook(f: Filters) {
  const [a, bleeds, queries, cfg] = await Promise.all([analytics(f), bleedRows(sql, f), queryRows(sql, f), bleedConfig(sql)]);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Baton';
  wb.created = new Date();
  const sheet = (name: string, cols: [string, number][], rows: unknown[][]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([header, width]) => ({ header, width }));
    ws.getRow(1).font = { bold: true };
    ws.addRows(rows);
    return ws;
  };

  sheet('Summary', [['Measure', 40], ['Value', 18]], [
    ['Period (SAST)', `${f.from} to ${f.to}`],
    ['Bleeds requested', a.bleeds.requested], ['Bleeds cancelled (excluded)', a.bleeds.cancelled], ['Reports filed', a.bleeds.completed],
    ['Bleed turnaround compliance %', a.bleeds.compliance ?? ''], ['Median total turnaround (min)', mins(a.bleeds.median_tat)],
    ['Geolocation exceptions', a.bleeds.geo_exceptions], ['Late (offline) syncs', a.bleeds.late_sync],
    ['Queries logged', a.queries.logged], ['Queries closed', a.queries.closed], ['Query response compliance %', a.queries.compliance ?? ''],
  ]);
  sheet('Bleed stages', [['Interval', 16], ['Owner', 26], ['Limit (min)', 12], ['Completed', 12], ['Average (min)', 14], ['Median (min)', 14], ['Compliance %', 14]],
    a.bleeds.stages.map((s) => [s.label, s.owner, s.limit, s.n, mins(s.avg), mins(s.median), s.compliance ?? '']));
  for (const [name, rows] of [['By site', a.bleeds.by_site], ['By hospital', a.bleeds.by_hospital], ['By nurse', a.bleeds.by_nurse]] as const)
    sheet(`Bleeds ${name.toLowerCase()}`, [[name.slice(3), 32], ['Bleeds', 10], ['Filed', 10], ['Compliance %', 14], ['Median TAT (min)', 16], ['Currently red', 14]],
      rows.map((r) => [r.label, r.n, r.completed, r.compliance ?? '', mins(r.median_tat), r.breaches]));
  sheet('Departments', [['Department', 26], ['Assigned', 10], ['Open', 8], ['Avg first response (min)', 22], ['Avg resolution (min)', 20], ['Compliance %', 14], ['Breaches', 10]],
    a.queries.by_department.map((d) => [d.label, d.n, d.open, mins(d.avg_first_response), mins(d.avg_resolution), d.compliance ?? '', d.breaches]));
  sheet('Query categories', [['Category', 44], ['Queries', 10]], a.queries.by_category.map((c) => [c.label, c.n]));
  sheet('Repeat failures', [['Complainant', 30], ['Practice / hospital', 30], ['Category', 44], ['Times', 8]], a.queries.repeats.map((r) => [r.complainant, r.organisation ?? '', r.category, r.n]));

  sheet('Queries', [['Ticket', 18], ['Received (SAST)', 18], ['State', 18], ['Priority', 10], ['Category', 40], ['Site', 18], ['Complainant', 28], ['Practice / hospital', 28], ['Departments', 30], ['Root cause', 16], ['Closed (SAST)', 18]],
    queries.map((t) => [t.number, sast(t.created_at), QUERY_STATES[t.state as keyof typeof QUERY_STATES], t.priority, t.category, t.site, t.complainant_name, t.organisation ?? '',
      (t.assignments ?? []).map((x: any) => x.department).join(', '), t.root_cause ?? '', t.closed_at ? sast(t.closed_at) : '']));
  sheet('Bleeds', [['Ticket', 18], ['Request', 18], ['Opened (SAST)', 18], ['Hospital', 26], ['Patient ref.', 16], ['Nurse', 22], ['State', 18],
    ...INTERVALS.map((iv) => [`${iv.label} (min)`, 14] as [string, number]), ['Total (min)', 12], ['Geo exception', 14], ['Breach reasons', 40]],
    bleeds.map((b) => {
      const r = bleedIntervals(b, cfg.limits, new Date(), cfg.th);
      return [b.number, b.request_number, sast(b.opened_at), b.hospital, patientRef(b.patient_name, b.folder_no), b.nurse ?? '', BLEED_STATES[bleedState(b)],
        ...r.intervals.map((i) => (i.status === 'done' ? Math.round(i.used) : '')), mins(r.total), b.arrive_override || b.file_override ? 'Yes' : '',
        Object.entries(b.breach_reasons ?? {}).map(([k, v]) => `${INTERVALS[+k].label}: ${v}`).join('; ')];
    }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function summaryText(title: string, a: Awaited<ReturnType<typeof analytics>>) {
  const pc = (x: number | null) => (x == null ? '—' : `${x}%`);
  return [
    `${title} — ${a.filters.from}${a.filters.to !== a.filters.from ? ` to ${a.filters.to}` : ''} (SAST)`,
    '',
    'HOSPITAL BLEEDS',
    `  Requested ${a.bleeds.requested} · reports filed ${a.bleeds.completed} · cancelled ${a.bleeds.cancelled}`,
    `  Turnaround compliance ${pc(a.bleeds.compliance)} · median ${a.bleeds.median_tat != null ? formatMinutes(a.bleeds.median_tat) : '—'}`,
    ...a.bleeds.stages.map((s) => `  ${s.label.padEnd(11)} median ${s.median != null ? formatMinutes(s.median).padEnd(8) : '—'.padEnd(8)} limit ${formatMinutes(s.limit).padEnd(7)} compliance ${pc(s.compliance)}`),
    `  Geolocation exceptions ${a.bleeds.geo_exceptions} · late syncs ${a.bleeds.late_sync}`,
    '',
    'QUERIES',
    `  Logged ${a.queries.logged} · closed ${a.queries.closed} · response compliance ${pc(a.queries.compliance)}`,
    ...a.queries.by_department.map((d) => `  ${d.label.padEnd(22)} ${String(d.n).padStart(3)} assigned · ${d.breaches} breached · compliance ${pc(d.compliance)}`),
    ...(a.queries.repeats.length ? ['', 'REPEAT FAILURES', ...a.queries.repeats.slice(0, 5).map((r) => `  ${r.complainant}: ${r.category} ×${r.n}`)] : []),
    '',
    'Full detail in the attached workbook.',
  ].join('\n');
}

export async function sendReport(kind: 'daily' | 'monthly', f: Filters, to: string[]) {
  const a = await analytics(f);
  const title = kind === 'daily' ? 'Baton daily operations summary' : 'Baton monthly management summary';
  await sendMail(to, `${title} · ${f.from}${kind === 'monthly' ? ` to ${f.to}` : ''}`, summaryText(title, a), [
    { filename: `baton-${kind}-${f.from}.xlsx`, content: await workbook(f) },
  ]);
  await audit(sql, { actor: null, action: `report.${kind}`, entity: 'report', id: f.from, data: { to } });
}

/** Called every worker tick; sends each report once, after the configured SAST hour. */
export async function reportTick(now = new Date()) {
  const rows = await sql`select key, value from settings where key like 'report_%'`;
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const local = new Date(now.getTime() + SAST_OFFSET);
  if (local.getUTCHours() < Number(s.report_send_hour ?? 7)) return;
  const today = local.toISOString().slice(0, 10);
  const yesterday = new Date(local.getTime() - 86_400_000).toISOString().slice(0, 10);
  const claim = async (key: string, value: string) =>
    (await sql`insert into settings values (${key}, ${sql.json(value)}) on conflict (key) do update set value = excluded.value
      where settings.value <> excluded.value returning 1`).length > 0;
  if ((s.report_daily_recipients ?? []).length && (await claim('report_last_daily', today)))
    await sendReport('daily', { from: yesterday, to: yesterday }, s.report_daily_recipients);
  if (local.getUTCDate() === 1 && (s.report_monthly_recipients ?? []).length && (await claim('report_last_monthly', today))) {
    const first = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    await sendReport('monthly', { from: first, to: yesterday }, s.report_monthly_recipients);
  }
}
