// Deterministic insights: each measure compared with its own recent history. No models, nothing leaves the server.
import { formatMinutes, SAST_OFFSET } from '@baton/core';
import { analytics } from './analytics';
import { sql, type Sql } from './db';

export type Insight = { tone: 'warn' | 'good' | 'info'; title: string; detail: string; link?: string };

const day = (offset: number) => new Date(Date.now() + SAST_OFFSET - offset * 86_400_000).toISOString().slice(0, 10);
const change = (now: number, base: number) => Math.round(((now - base) / base) * 100);

export async function insights(db: Sql = sql, minN = 3): Promise<Insight[]> {
  const week = { from: day(6), to: day(0) };
  const base = { from: day(34), to: day(7) };
  const month = { from: day(29), to: day(0) };
  const [w, b, m] = await Promise.all([analytics(week, db), analytics(base, db), analytics(month, db)]);
  const out: (Insight & { weight: number })[] = [];
  const wk = `from=${week.from}&to=${week.to}`;

  // 1. Bleed stage drift: this week's median vs the previous four weeks.
  w.bleeds.stages.forEach((s, i) => {
    const p = b.bleeds.stages[i];
    if (s.n < minN || p.n < minN || !s.median || !p.median) return;
    const c = change(s.median, p.median);
    if (Math.abs(c) < 20 || Math.abs(s.median - p.median) < 5) return;
    out.push({
      tone: c > 0 ? 'warn' : 'good', weight: Math.abs(c),
      title: `${s.label} time ${c > 0 ? 'up' : 'down'} ${Math.abs(c)}% on the 4-week median`,
      detail: `Median ${formatMinutes(s.median)} this week vs ${formatMinutes(p.median)} before · owner ${s.owner} · limit ${formatMinutes(s.limit)}`,
      link: `/dashboard/performance?${wk}`,
    });
  });

  // 2. Department first response drift.
  for (const d of w.queries.by_department) {
    const p = b.queries.by_department.find((x) => x.id === d.id);
    if (!p || d.n < minN || p.n < minN || !d.avg_first_response || !p.avg_first_response) continue;
    const c = change(d.avg_first_response, p.avg_first_response);
    if (Math.abs(c) < 25 || Math.abs(d.avg_first_response - p.avg_first_response) < 15) continue;
    out.push({
      tone: c > 0 ? 'warn' : 'good', weight: Math.abs(c) * 0.8,
      title: `${d.label} first response ${c > 0 ? 'slower' : 'faster'} by ${Math.abs(c)}%`,
      detail: `Average ${formatMinutes(d.avg_first_response)} this week vs ${formatMinutes(p.avg_first_response)} before`,
      link: `/tickets?scope=all&${wk}&department_id=${d.id}`,
    });
  }

  // 3. Worst hospital this week.
  const worst = w.bleeds.by_hospital.filter((h) => h.completed >= minN && h.compliance != null && h.compliance < 80).sort((x, y) => x.compliance! - y.compliance!)[0];
  if (worst)
    out.push({
      tone: 'warn', weight: 100 - worst.compliance!,
      title: `${worst.label}: ${worst.compliance}% of bleeds within every limit this week`,
      detail: `${worst.completed} reports filed · median turnaround ${worst.median_tat ? formatMinutes(worst.median_tat) : '—'}`,
      link: `/bleeds?scope=all&${wk}&hospital_id=${worst.id}`,
    });

  // 4. Geolocation exceptions per nurse (30 days).
  const geo = await db`
    select u.id, u.name, count(*)::int as n, count(*) filter (where coalesce(r.arrive_override, b.file_override, r.arrive_suspect, b.file_suspect) is not null)::int as ex
    from bleeds b join bleed_requests r on r.id = b.request_id join users u on u.id = r.nurse_id
    where b.opened_at >= now() - interval '30 days' and b.cancelled_at is null group by u.id, u.name`;
  for (const g of geo)
    if (g.n >= minN && g.ex / g.n >= 0.2)
      out.push({
        tone: 'warn', weight: (g.ex / g.n) * 100,
        title: `${g.name}: ${g.ex} of ${g.n} bleeds with a geolocation exception`,
        detail: 'Checkpoints confirmed outside the hospital geofence in the last 30 days — review the reasons given.',
        link: `/bleeds?scope=all&from=${month.from}&to=${month.to}&nurse_id=${g.id}`,
      });

  // 5. The same failure recurring (30 days).
  for (const r of m.queries.repeats.filter((x) => x.n >= 3).slice(0, 3))
    out.push({
      tone: 'warn', weight: r.n * 15,
      title: `${r.complainant} has raised “${r.category}” ${r.n} times in 30 days`,
      detail: `${r.organisation ?? ''} — the corrective actions are not holding.`.trim(),
      link: `/search?q=${encodeURIComponent(r.complainant)}`,
    });

  return out.sort((x, y) => (x.tone === 'warn' ? 0 : 1) - (y.tone === 'warn' ? 0 : 1) || y.weight - x.weight).slice(0, 6).map(({ weight: _, ...i }) => i);
}
