import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Projection } from './projection.js';
import { computeStats } from './stats.js';
import type { ConsumerStats } from './consumer.js';
import { getBoard, getRecentEvents, type LiveHub } from './live.js';

export interface HttpOptions {
  logger?: boolean | object;
  corsOrigin?: string;
  hub?: LiveHub;
  /** Built dashboard (apps/dashboard/dist) – served at / when present. */
  dashboardDir?: string;
  heartbeatMs?: number;
}

const TENANT = /^[a-z0-9-]{2,60}$/;

/** Start of "today" in the restaurant's time zone. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const elapsed = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - elapsed);
}

export function buildHttp(projection: Projection, consumerStats: () => ConsumerStats | null, opts: HttpOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.addHook('onSend', async (_req, reply) => {
    if (opts.corsOrigin) reply.header('access-control-allow-origin', opts.corsOrigin);
  });

  app.addHook('preHandler', async (req, reply) => {
    const t = (req.params as { tenant?: string } | undefined)?.tenant;
    if (t !== undefined && !TENANT.test(t)) return reply.code(400).send({ error: 'invalid_tenant' });
  });

  app.get('/healthz', async () => ({ ok: true, consumer: consumerStats(), liveClients: opts.hub?.clientCount() ?? 0 }));

  app.get<{ Params: { tenant: string }; Querystring: { days?: string; range?: string; tz?: string } }>('/v1/stats/:tenant', async (req, reply) => {
    const tz = req.query.tz ?? 'Europe/Berlin';
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      return reply.code(400).send({ error: 'invalid_timezone' });
    }
    const to = new Date();
    let from: Date;
    if (req.query.range === 'today') from = startOfLocalDay(to, tz);
    else {
      const days = Math.min(365, Math.max(1, Number(req.query.range?.replace(/d$/, '') ?? req.query.days ?? 7) || 7));
      from = new Date(to.getTime() - days * 86_400_000);
    }
    return computeStats(projection, req.params.tenant, from, to, tz);
  });

  /** Tickets for the kitchen pass. */
  app.get<{ Params: { tenant: string } }>('/v1/board/:tenant', async (req) => ({
    tenant: req.params.tenant,
    serverTime: new Date().toISOString(),
    orders: getBoard(projection, req.params.tenant),
  }));

  /** Most recent events (newest first). */
  app.get<{ Params: { tenant: string }; Querystring: { limit?: string } }>('/v1/events/:tenant', async (req) => ({
    events: getRecentEvents(projection, req.params.tenant, Number(req.query.limit ?? 30) || 30),
  }));

  /** Server-sent events: one message per applied Kafka event, plus a heartbeat. */
  app.get<{ Params: { tenant: string } }>('/v1/stream/:tenant', (req, reply) => {
    const hub = opts.hub;
    if (!hub) return reply.code(404).send({ error: 'live_disabled' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...(opts.corsOrigin ? { 'access-control-allow-origin': opts.corsOrigin } : {}),
    });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ tenant: req.params.tenant, serverTime: new Date().toISOString() })}\n\n`);
    const unsubscribe = hub.subscribe(req.params.tenant, (entry) => {
      res.write(`id: ${entry.eventId}\nevent: kafka\ndata: ${JSON.stringify(entry)}\n\n`);
    });
    const beat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), opts.heartbeatMs ?? 25_000);
    req.raw.on('close', () => {
      clearInterval(beat);
      unsubscribe();
    });
  });

  if (opts.dashboardDir && existsSync(opts.dashboardDir)) {
    app.register(fastifyStatic, { root: opts.dashboardDir, prefix: '/', index: 'index.html', maxAge: '1h' });
  }

  return app;
}
