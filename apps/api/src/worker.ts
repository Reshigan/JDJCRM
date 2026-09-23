// Background jobs. Several workers may run; a session advisory lock keeps one active.
import { sql } from './db';
import { bleedEscalationTick, escalationTick } from './escalation';
import { reportTick } from './reports';

const reserved = await sql.reserve();
const tick = async () => {
  const [{ ok }] = await reserved`select pg_try_advisory_lock(7331) as ok`;
  if (!ok) return;
  try {
    const n = (await escalationTick()) + (await bleedEscalationTick());
    if (n) console.log(`[worker] escalated ${n}`);
    await sql`delete from sessions where expires_at < now()`;
    await reportTick();
  } catch (e) {
    console.error('[worker]', e);
  }
};
await tick();
setInterval(tick, 60_000);
