import Fastify, { type FastifyInstance } from 'fastify';
import { registerIngest, type IngestOptions } from '@restroflow-events/ingest/app';
import { registerAnalytics, type HttpOptions } from '@restroflow-events/analytics/http';
import type { Projection } from '@restroflow-events/analytics/projection';
import type { ConsumerStats } from '@restroflow-events/analytics/consumer';

export interface EdgeOptions {
  ingest: Omit<IngestOptions, 'logger' | 'maxBodyBytes'>;
  projection: Projection;
  consumerStats: () => ConsumerStats | null;
  analytics?: Omit<HttpOptions, 'logger'>;
  logger?: boolean | object;
  /** Expose /metrics publicly (default: hidden – there is no proxy in front on PaaS hosts). */
  publicMetrics?: boolean;
}

/**
 * Ingest + analytics + dashboard on ONE Fastify instance.
 *
 * Same code as the two services, just mounted together so the whole platform fits
 * into a single free container. Each part is registered in its own plugin scope,
 * so the ingest raw-body JSON parser and the analytics hooks don't leak into each other.
 * The two halves still talk only through Kafka: webhook → topic → consumer → projection.
 */
export function buildEdge(opts: EdgeOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024, trustProxy: true });

  if (!opts.publicMetrics) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/metrics' || req.url.startsWith('/metrics?')) return reply.code(404).send({ error: 'not_found' });
    });
  }

  app.get('/healthz', async () => ({
    ok: true,
    mode: 'edge',
    kafkaProducerReady: opts.ingest.publisher.isReady(),
    consumer: opts.consumerStats(),
    liveClients: opts.analytics?.hub?.clientCount() ?? 0,
  }));

  app.register(async (scope) => registerIngest(scope, { ...opts.ingest, healthRoutes: false }));
  app.register(async (scope) => registerAnalytics(scope, opts.projection, opts.consumerStats, { ...opts.analytics, healthRoutes: false }));
  return app;
}
