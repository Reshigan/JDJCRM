// Live push (Server-Sent Events). Events carry only entity + id: clients refetch through their normal,
// access-checked APIs, so a stream never discloses anything a user could not already load.
import type { FastifyInstance } from 'fastify';
import { sql } from '../db';

type Client = { userId: string; send: (event: string, data: string) => void };
const clients = new Set<Client>();
let listening: Promise<unknown> | null = null;

function listen() {
  listening ??= Promise.all([
    sql.listen('baton_change', (payload) => {
      const { entity, id } = JSON.parse(payload);
      const data = JSON.stringify({ entity, id });
      for (const c of clients) c.send('change', data);
    }),
    sql.listen('baton_user', (userId) => {
      for (const c of clients) if (c.userId === userId) c.send('notification', '{}');
    }),
  ]);
  return listening;
}

export function streamRoutes(app: FastifyInstance) {
  app.get('/api/stream', async (req, reply) => {
    await listen();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 5000\n\n');
    const client: Client = { userId: req.user.id, send: (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`) };
    clients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(ping); clients.delete(client); });
  });
}
