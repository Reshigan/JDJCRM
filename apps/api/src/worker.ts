// Background jobs. Several workers may run; a session advisory lock keeps one active.
import { sql } from './db';
import { escalationTick } from './escalation';

const reserved = await sql.reserve();
const tick = async () => {
  const [{ ok }] = await reserved`select pg_try_advisory_lock(7331) as ok`;
  if (!ok) return;
  try {
    const n = await escalationTick();
    if (n) console.log(`[worker] escalated ${n}`);
    await sql`delete from sessions where expires_at < now()`;
  } catch (e) {
    console.error('[worker]', e);
  }
};
await tick();
setInterval(tick, 60_000);
