import { buildApp } from './app';
import { env } from './env';
import { migrate } from './migrate';

await migrate();
const app = await buildApp();
await app.listen({ host: '0.0.0.0', port: env.port });

// Every API instance watches the worker; the alert is claimed once per hour cluster-wide.
const { watchdog } = await import('./ops');
setInterval(() => watchdog().catch((e) => app.log.error(e)), 120_000);
