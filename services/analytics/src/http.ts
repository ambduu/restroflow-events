import Fastify, { type FastifyInstance } from 'fastify';
import type { Projection } from './projection.js';
import { computeStats } from './stats.js';
import type { ConsumerStats } from './consumer.js';

export function buildHttp(projection: Projection, consumerStats: () => ConsumerStats | null, opts: { logger?: boolean | object; corsOrigin?: string } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.addHook('onSend', async (_req, reply) => {
    if (opts.corsOrigin) reply.header('access-control-allow-origin', opts.corsOrigin);
  });

  app.get('/healthz', async () => ({ ok: true, consumer: consumerStats() }));

  app.get<{ Params: { tenant: string }; Querystring: { days?: string; tz?: string } }>('/v1/stats/:tenant', async (req, reply) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 7) || 7));
    const tz = req.query.tz ?? 'Europe/Berlin';
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      return reply.code(400).send({ error: 'invalid_timezone' });
    }
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return computeStats(projection, req.params.tenant, from, to, tz);
  });

  return app;
}
