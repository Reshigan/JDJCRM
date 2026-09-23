import nodemailer from 'nodemailer';
import { env } from './env';
import { type Sql } from './db';

const mailer = env.smtp.host
  ? nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    })
  : null;

export async function sendMail(to: string[], subject: string, text: string) {
  if (!to.length) return;
  if (!mailer) return console.log(`[mail] to=${to.join(',')} subject=${subject}`);
  await mailer.sendMail({ from: env.smtp.from, to, subject, text }).catch((e) => console.error('[mail]', e.message));
}

type Audience = { users?: string[]; departments?: number[]; roles?: string[]; deptRoles?: string[] };

/** Resolve recipients, write in-app notifications, then e-mail outside the transaction. */
export async function notify(db: Sql, to: Audience, n: { ticketId?: string; link?: string; number?: string; title: string; body?: string }) {
  const rows = await db`
    select id, email from users where active and (
      id = any(${to.users ?? []}::uuid[])
      or role = any(${to.roles ?? []})
      or (department_id = any(${to.departments ?? []}::int[]) and role = any(${to.deptRoles ?? ['dept_responder', 'dept_manager', 'cs_agent', 'cs_supervisor']}))
    )`;
  if (!rows.length) return;
  await db`insert into notifications ${db(rows.map((r) => ({ user_id: r.id, ticket_id: n.ticketId ?? null, link: n.link ?? null, title: n.title, body: n.body ?? null })))}`;
  const subject = n.number ? `${n.number} · ${n.title}` : n.title;
  const path = n.link ?? (n.ticketId ? `/tickets/${n.ticketId}` : null);
  const link = path ? `\n\nOpen: ${env.appUrl}${path}` : '';
  setImmediate(() => sendMail(rows.map((r) => r.email), subject, `${n.body ?? n.title}${link}`));
}

