import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { authPlugin } from './auth';
import { HttpError } from './db';
import { adminRoutes } from './routes/admin';
import { miscRoutes } from './routes/misc';
import { ticketRoutes } from './routes/tickets';

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' }, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return reply.code(400).send({ error: `${i.path.join('.') || 'input'}: ${i.message}`, issues: err.issues });
    }
    if (err.code === 'P0001') return reply.code(409).send({ error: err.message }); // raised by DB guard triggers
    if (err.code === '23505') return reply.code(409).send({ error: 'Already exists' });
    if (err.code === '23514' || err.code === '23503' || err.code === '22P02') return reply.code(400).send({ error: 'Invalid data' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  authPlugin(app);
  miscRoutes(app);
  ticketRoutes(app);
  adminRoutes(app);
  return app;
}
