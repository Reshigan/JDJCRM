// Reference data from the brief (idempotent). `--demo` adds demo users, hospitals and live tickets.
import zlib from 'node:zlib';
import { sql } from './db';
import { hashPassword } from './crypto';
import { migrate } from './migrate';

const DEPTS = [
  ['CS', 'Client Services'], ['ANA', 'Analytical'], ['PRE', 'Pre-Analytical'], ['LOG', 'Logistics'],
  ['NUR', 'Nursing'], ['STO', 'Stores & Procurement'], ['FIN', 'Finance'],
];
// [name, dept codes, critical, high, normal] in working minutes — brief §5.3 limits are TBC, adjust in Admin.
const CATS: [string, string[], number, number, number][] = [
  ['Status / result query', ['CS'], 60, 120, 240],
  ['Result queried as incorrect / repeat requested', ['ANA'], 120, 240, 480],
  ['Turnaround time complaint', ['CS'], 120, 240, 480],
  ['Sample rejected / recollection required', ['PRE'], 60, 180, 480],
  ['Sample not received / sample lost', ['PRE', 'LOG'], 60, 180, 480],
  ['Incorrect patient details', ['PRE'], 120, 240, 480],
  ['Collection not done', ['LOG', 'NUR'], 60, 180, 480],
  ['Late delivery of reports', ['LOG', 'NUR'], 60, 180, 480],
  ['Phlebotomy service / nursing conduct', ['NUR'], 240, 480, 960],
  ['Stock not delivered', ['STO'], 240, 480, 960],
  ['Account, billing or pricing query', ['FIN'], 480, 960, 1440],
  ['Compliment / general enquiry', ['CS'], 480, 960, 1440],
];
const HOLIDAYS = [
  ['2026-01-01', "New Year's Day"], ['2026-03-21', 'Human Rights Day'], ['2026-04-03', 'Good Friday'], ['2026-04-06', 'Family Day'],
  ['2026-04-27', 'Freedom Day'], ['2026-05-01', "Workers' Day"], ['2026-06-16', 'Youth Day'], ['2026-08-10', "National Women's Day (observed)"],
  ['2026-09-24', 'Heritage Day'], ['2026-12-16', 'Day of Reconciliation'], ['2026-12-25', 'Christmas Day'], ['2026-12-26', 'Day of Goodwill'],
  ['2027-01-01', "New Year's Day"], ['2027-03-22', 'Human Rights Day (observed)'], ['2027-03-26', 'Good Friday'], ['2027-03-29', 'Family Day'],
  ['2027-04-27', 'Freedom Day'], ['2027-05-01', "Workers' Day"], ['2027-06-16', 'Youth Day'], ['2027-08-09', "National Women's Day"],
  ['2027-09-24', 'Heritage Day'], ['2027-12-16', 'Day of Reconciliation'], ['2027-12-25', 'Christmas Day'], ['2027-12-27', 'Day of Goodwill (observed)'],
];

export async function seed(demo: boolean, tickets = demo) {
  await migrate();
  for (const [code, name] of DEPTS) await sql`insert into departments (code, name) values (${code}, ${name}) on conflict (code) do nothing`;
  const dept = Object.fromEntries((await sql`select id, code from departments`).map((d) => [d.code, d.id as number]));
  for (const [name, codes, c, h, n] of CATS)
    await sql`insert into categories (name, department_ids, limit_critical, limit_high, limit_normal)
      values (${name}, ${codes.map((x) => dept[x])}, ${c}, ${h}, ${n}) on conflict (name) do nothing`;
  for (const [day, name] of HOLIDAYS) await sql`insert into holidays values (${day}, ${name}) on conflict do nothing`;
  await sql`insert into sites (code, name, region) values ('MAIN', 'Main Laboratory', 'Head Office') on conflict do nothing`;

  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@baton.local';
  const [{ n }] = await sql`select count(*)::int as n from users where role = 'admin'`;
  if (!n) {
    const pw = process.env.ADMIN_PASSWORD ?? 'ChangeMe!2026';
    await sql`insert into users (email, name, role, password_hash) values (${adminEmail}, 'System Administrator', 'admin', ${hashPassword(pw)})`;
    console.log(`admin created: ${adminEmail}`);
  }
  const [canned] = await sql`select count(*)::int as n from canned_responses`;
  if (!canned.n) await sql`insert into canned_responses ${sql(CANNED.map(([title, body]) => ({ title, body })))}`;
  if (demo) await seedDemo(dept, tickets);
}

// Starter wording; edit in Administration → Canned responses.
const CANNED = [
  ['Sample located', 'The sample was located and processed. Results were released and the report sent to the requesting doctor.'],
  ['Recollection arranged', 'The sample could not be processed. A recollection has been arranged and the patient contacted.'],
  ['Courier delay', 'The collection was delayed by the courier route. The route has been reviewed and the driver briefed.'],
  ['Staff briefed', 'The staff member involved has been briefed on the correct procedure, and the incident recorded for training.'],
  ['Apology given', 'Apologised to the client for the inconvenience and explained the corrective action taken.'],
];

async function seedDemo(dept: Record<string, number>, tickets: boolean) {
  await sql`update settings set value = '[]' where key = 'mfa_enforced_roles'`; // demo convenience only
  for (const [code, name, region] of [['NTH', 'North Depot', 'Gauteng North'], ['STH', 'South Depot', 'Gauteng South'], ['CPT', 'Coastal Branch', 'Western Cape']])
    await sql`insert into sites (code, name, region) values (${code}, ${name}, ${region}) on conflict do nothing`;
  const site = Object.fromEntries((await sql`select id, code from sites`).map((s) => [s.code, s.id as number]));
  const orgs = [
    ['hospital', 'Demo General Hospital', -25.7479, 28.2293, 300, 'NTH'],
    ['hospital', 'Demo Private Clinic', -26.1076, 28.0567, 200, 'STH'],
    ['hospital', 'Demo Coastal Hospital', -33.9249, 18.4241, 350, 'CPT'],
    ['practice', 'Dr A. Naidoo Family Practice', null, null, null, 'NTH'],
    ['practice', 'Parkview Medical Centre', null, null, null, 'STH'],
    ['practice', 'Harbour Paediatrics', null, null, null, 'CPT'],
  ] as const;
  const [{ c }] = await sql`select count(*)::int as c from organisations`;
  if (!c)
    for (const [kind, name, lat, lng, radius_m, s] of orgs)
      await sql`insert into organisations (kind, name, lat, lng, radius_m, site_id) values (${kind}, ${name}, ${lat}, ${lng}, ${radius_m}, ${site[s]})`;

  const pw = hashPassword('Baton!demo2026');
  const users = [
    ['agent@baton.local', 'Thandi Mokoena', 'cs_agent', 'CS'],
    ['supervisor@baton.local', 'Johan van Wyk', 'cs_supervisor', 'CS'],
    ['analytical@baton.local', 'Priya Govender', 'dept_responder', 'ANA'],
    ['preanalytical@baton.local', 'Sipho Dlamini', 'dept_responder', 'PRE'],
    ['logistics@baton.local', 'Kagiso Molefe', 'dept_responder', 'LOG'],
    ['nursing@baton.local', 'Sister Anne Botha', 'dept_responder', 'NUR'],
    ['manager.pre@baton.local', 'Lerato Khumalo', 'dept_manager', 'PRE'],
    ['exec@baton.local', 'Dr Ravi Pillay', 'management', null],
  ] as const;
  for (const [email, name, role, d] of users)
    await sql`insert into users (email, name, role, department_id, password_hash)
      values (${email}, ${name}, ${role}, ${d ? dept[d] : null}, ${pw}) on conflict (email) do nothing`;
  await sql`insert into users (email, name, role, department_id, password_hash)
    values ('nurse2@baton.local', 'Sister Zanele Nkosi', 'dept_responder', ${dept.NUR}, ${pw}) on conflict (email) do nothing`;
  await sql`update organisations set nurse_id = (select id from users where email = 'nursing@baton.local') where kind = 'hospital' and nurse_id is null and name <> 'Demo Coastal Hospital'`;
  await sql`update organisations set nurse_id = (select id from users where email = 'nurse2@baton.local') where name = 'Demo Coastal Hospital' and nurse_id is null`;
  console.log('demo users ready — password: Baton!demo2026');
  if (tickets) await demoTickets();
}

/** Drive demo tickets through the real API so every step is audited like production. */
async function demoTickets() {
  const [{ n }] = await sql`select count(*)::int as n from tickets`;
  if (n) return;
  const { buildApp } = await import('./app');
  const { escalationTick } = await import('./escalation');
  const app = await buildApp();
  const jar: Record<string, string> = {};
  const as = async (email: string) => {
    if (!jar[email]) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: email, password: 'Baton!demo2026' } });
      jar[email] = String(r.headers['set-cookie']).split(';')[0];
    }
    return (url: string, payload?: object) => app.inject({ method: payload ? 'POST' : 'GET', url, payload, headers: { cookie: jar[email] } }).then((r) => r.json());
  };
  const cs = await as('agent@baton.local');
  const lk = await cs('/api/lookups');
  const cat = (s: string) => lk.categories.find((c: any) => c.name.startsWith(s)).id;
  const org = (s: string) => lk.organisations.find((o: any) => o.name.startsWith(s));
  const byDept: Record<string, string> = { ANA: 'analytical@baton.local', PRE: 'preanalytical@baton.local', LOG: 'logistics@baton.local', NUR: 'nursing@baton.local', CS: 'agent@baton.local' };

  // [category, org, complainant, type, priority, description, hoursAgo, progress]
  const demo: [string, string, string, string, string, string, number, 'new' | 'ack' | 'responded' | 'closed'][] = [
    ['Sample not received', 'Dr A. Naidoo', 'Dr A. Naidoo', 'doctor', 'critical', 'Urgent FBC for patient M. Petersen collected yesterday 14:00; lab says not received.', 30, 'ack'],
    ['Result queried as incorrect', 'Parkview', 'Dr L. Mahlangu', 'doctor', 'high', 'Potassium 7.2 on a patient who is clinically well. Suspect haemolysis; requests repeat.', 5, 'ack'],
    ['Late delivery of reports', 'Demo General', 'Ward 4B sister', 'hospital', 'high', 'Reports for three patients not in folders at 10:00 ward round.', 3, 'new'],
    ['Collection not done', 'Harbour Paediatrics', 'Reception, Harbour Paediatrics', 'doctor', 'normal', 'Courier did not collect the 15:30 box.', 2, 'new'],
    ['Account, billing', 'Dr A. Naidoo', 'Dr A. Naidoo', 'doctor', 'normal', 'Patient billed twice for the same lipid panel.', 1, 'new'],
    ['Incorrect patient details', 'Demo Private', 'Ward clerk', 'hospital', 'normal', 'Date of birth wrong on report for requisition RQ-448120.', 26, 'responded'],
    ['Phlebotomy service', 'Demo Coastal', 'Unit manager', 'hospital', 'normal', 'Patient complained about bruising after bleed.', 50, 'closed'],
    ['Result queried as incorrect', 'Parkview', 'L Mahlangu', 'doctor', 'normal', 'Asked for a copy of the repeat potassium.', 1.5, 'new'], // a duplicate of Dr L. Mahlangu in the register
    ['Compliment', 'Parkview', 'Dr L. Mahlangu', 'doctor', 'normal', 'Thanks to the night team for the fast troponin turnaround.', 0.2, 'new'],
  ];
  for (const [c, o, name, type, priority, description, hoursAgo, progress] of demo) {
    const g = org(o);
    const { id } = await cs('/api/tickets', {
      channel: 'telephone', complainant_type: type, complainant_name: name, organisation_id: g.id, contact_phone: '012 555 0100',
      site_id: g.site_id, category_id: cat(c), priority, description,
    });
    await sql`update tickets set created_at = now() - ${hoursAgo + ' hours'}::interval where id = ${id}`;
    await sql`update assignments set started_at = now() - ${hoursAgo + ' hours'}::interval where ticket_id = ${id}`;
    const t = await cs(`/api/tickets/${id}`);
    if (progress === 'new') continue;
    for (const a of t.assignments) {
      const d = await as(byDept[a.department_code] ?? 'agent@baton.local');
      await d(`/api/tickets/${id}/actions`, { action: 'acknowledge', assignment_id: a.id });
      if (progress !== 'ack')
        await d(`/api/tickets/${id}/actions`, { action: 'respond', assignment_id: a.id, findings: 'Investigated and confirmed.', corrective_action: 'Corrected and staff briefed.', breach_reason: 'Backlog after system downtime' });
    }
    if (progress === 'closed') {
      await cs(`/api/tickets/${id}/actions`, { action: 'review' });
      for (const a of t.assignments) await cs(`/api/tickets/${id}/actions`, { action: 'accept', assignment_id: a.id });
      await cs(`/api/tickets/${id}/actions`, { action: 'log_call', called_at: new Date().toISOString(), spoken_to: name, number_used: '012 555 0100', summary: 'Apologised and explained corrective action.', satisfied: true });
      await cs(`/api/tickets/${id}/actions`, { action: 'close', closure_reason: 'resolved_corrective', root_cause: 'staff_conduct', effectiveness_due: '2099-01-01' });
      await sql`update tickets set effectiveness_due = current_date - 1 where id = ${id}`; // an effectiveness check already due
    }
  }
  await escalationTick();
  await demoBleeds(app, as);
  await app.close();
  console.log('demo tickets created');
}

/** Placeholder "photo": a striped PNG, so the demo shows real images without real patients. */
function demoPng(w = 480, h = 320, hue = 0) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const bar = y > 120 && y < 220 && x > 60 && x < 420 && (x * 7) % 11 < 5;
      const v = bar ? 30 : 235 - ((x + y) % 40 === 0 ? 20 : 0);
      raw.set([v, v, Math.max(0, v - hue)], y * (w * 3 + 1) + 1 + x * 3);
    }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data] as Uint8Array[]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc] as Uint8Array[]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))] as Uint8Array[]);
}

async function demoBleeds(app: any, as: (email: string) => Promise<(url: string, payload?: object) => Promise<any>>) {
  const cs = await as('agent@baton.local');
  const lk = await cs('/api/lookups');
  const hosp = (n: string) => lk.organisations.find((o: any) => o.name === n);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const jar: Record<string, string> = {};
  const cookie = async (email: string) => {
    jar[email] ??= String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: email, password: 'Baton!demo2026' } })).headers['set-cookie']).split(';')[0];
    return jar[email];
  };
  const post = async (email: string, url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: { cookie: await cookie(email) } });
  const capture = async (email: string, id: string, fields: Record<string, string>) => {
    const B = 'demo';
    const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (fields.outcome === 'successful')
      for (const [k, hue] of [['requisition', 0], ['sticker', 60]] as const)
        parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"; filename="${k}.png"\r\nContent-Type: image/png\r\n\r\n`), demoPng(480, 320, hue), Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${B}--\r\n`));
    return app.inject({ method: 'POST', url: `/api/bleeds/${id}/capture`, payload: Buffer.concat(parts as Uint8Array[]), headers: { cookie: await cookie(email), 'content-type': `multipart/form-data; boundary=${B}` } });
  };
  // [hospital, nurse, patients, minutes since call, progress minutes: arrive, capture, receive, lab, release, file]
  type Plan = { h: string; nurse: string; patients: string[]; opened: number; arrive?: number; capture?: number; receive?: number; lab?: number; release?: number; file?: number; override?: string; outcome?: string };
  const plans: Plan[] = [
    { h: 'Demo General Hospital', nurse: 'nursing@baton.local', patients: ['Maria Smith', 'Thabo Nkosi', 'Anna Pretorius'], opened: 25 },
    { h: 'Demo Private Clinic', nurse: 'nursing@baton.local', patients: ['Sarah Jacobs'], opened: 180, arrive: 170, capture: 155, receive: 60, lab: 45 },
    { h: 'Demo Coastal Hospital', nurse: 'nurse2@baton.local', patients: ['Peter Adams', 'Lindiwe Zulu'], opened: 300, arrive: 280, capture: 260, receive: 120, lab: 100, release: 30 },
    { h: 'Demo General Hospital', nurse: 'nursing@baton.local', patients: ['David Botha'], opened: 60, arrive: 35, override: 'Main campus block C, GPS drifting' },
    { h: 'Demo Private Clinic', nurse: 'nursing@baton.local', patients: ['Grace Molefe'], opened: 1560, arrive: 1530, capture: 1510, receive: 1450, lab: 1420, release: 1260, file: 1200 },
    { h: 'Demo General Hospital', nurse: 'nursing@baton.local', patients: ['Joseph Mokoena'], opened: 90, arrive: 70, capture: 60, outcome: 'patient_refused' },
  ];
  const H = { lat: 0, lng: 0 };
  for (const p of plans) {
    const h = hosp(p.h);
    const r = await cs('/api/bleed-requests', { hospital_id: h.id, requested_by: 'Ward sister', notes: p.patients.length > 2 ? 'Fasting bloods — before 10:00 please' : undefined,
      patients: p.patients.map((n, i) => ({ patient_name: n, ward: `${3 + i}A`, bed: String(10 + i * 3), folder_no: `F-${70000 + Math.floor(Math.random() * 9999)}` })) });
    await sql`update bleed_requests set created_at = ${ago(p.opened)} where id = ${r.id}`;
    await sql`update bleeds set opened_at = ${ago(p.opened)} where request_id = ${r.id}`;
    const at = (h2: any) => ({ ...H, lat: h2.lat, lng: h2.lng });
    const hospital = (await sql`select lat, lng from organisations where id = ${h.id}`)[0];
    const breach = 'Demo: traffic / backlog';
    if (p.arrive != null)
      await post(p.nurse, `/api/bleed-requests/${r.id}/arrive`, { ...(p.override ? { lat: hospital.lat + 0.006, lng: hospital.lng } : at(hospital)), accuracy: p.override ? 60 : 9, device_time: ago(p.arrive), override_reason: p.override, breach_reason: breach });
    for (const id of r.bleed_ids) {
      if (p.capture == null) continue;
      const [b] = await sql`select patient_name, folder_no, ward, bed from bleeds where id = ${id}`;
      const cr = await capture(p.nurse, id, p.outcome
        ? { outcome: p.outcome, outcome_reason: 'Patient declined; ward informed', device_time: ago(p.capture) }
        : { outcome: 'successful', patient_name: b.patient_name, folder_no: b.folder_no, ward: b.ward, bed: b.bed, requisition_no: `RQ-${400000 + Math.floor(Math.random() * 99999)}`, tubes: JSON.stringify([{ type: 'EDTA (purple)', count: 1 }, { type: 'SST (gold)', count: 2 }]), device_time: ago(p.capture), breach_reason: breach });
      if (cr.statusCode !== 200) throw new Error(`demo capture failed: ${cr.body}`);
      for (const [step, who, min, col] of [['receive', 'preanalytical@baton.local', p.receive, 'received_at'], ['lab_accept', 'analytical@baton.local', p.lab, 'lab_accepted_at'], ['release', 'analytical@baton.local', p.release, 'released_at']] as const) {
        if (min == null) break;
        await post(who, `/api/bleeds/${id}/step`, { step, breach_reason: breach });
        await sql`update bleeds set ${sql(col)} = ${ago(min)} where id = ${id}`;
      }
      if (p.file != null) {
        await post(p.nurse, '/api/bleeds/file', { bleed_ids: [id], ...at(hospital), accuracy: 11, device_time: ago(p.file), breach_reason: breach });
        await post('agent@baton.local', `/api/bleeds/${id}/close`, {});
      }
    }
  }
  // Demo timestamps were back-dated after each step: keep breach reasons only on intervals that really overran.
  const { bleedIntervals } = await import('@baton/core');
  for (const b of await sql`select * from bleeds`) {
    const keep = Object.fromEntries(Object.entries(b.breach_reasons).filter(([k]) => bleedIntervals(b).intervals[+k]?.flag === 'red'));
    await sql`update bleeds set breach_reasons = ${sql.json(keep as any)} where id = ${b.id}`;
  }
  const { bleedEscalationTick } = await import('./escalation');
  await bleedEscalationTick();
  console.log('demo bleeds created');
}

if (/[\/]seed\.[jt]s$/.test(process.argv[1] ?? '')) {
  await seed(process.argv.includes('--demo'));
  await sql.end();
}
