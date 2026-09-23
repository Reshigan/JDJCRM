import { buildApp } from './app';
import { env } from './env';
import { migrate } from './migrate';

await migrate();
const app = await buildApp();
await app.listen({ host: '0.0.0.0', port: env.port });
