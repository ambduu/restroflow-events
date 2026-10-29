import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  FORBIDDEN_KEYS,
  SIGNATURE_HEADER,
  TOPICS,
  findForbiddenKeys,
  parseWebhook,
  partitionKey,
  toDomainEvent,
  verifySignature,
} from '@restroflow-events/contracts';
import type { EventPublisher } from './publisher.js';
import { RecentIds } from './dedupe.js';

export interface IngestOptions {
  /** tenant slug → webhook secret (as configured in RestroFlow › Webhooks). */
  tenants: Record<string, string>;
  publisher: EventPublisher;
  logger?: boolean | object;
  maxBodyBytes?: number;
}

type Outcome = 'published' | 'duplicate' | 'dead_lettered' | 'unauthorized' | 'unknown_tenant' | 'unavailable';

/** Remove personal data from anything we keep for debugging (dead-letter queue). */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !(FORBIDDEN_KEYS as readonly string[]).includes(k) && k !== 'name' && k !== 'customer')
        .map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
}

export function buildApp(opts: IngestOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: opts.maxBodyBytes ?? 256 * 1024,
    trustProxy: true,
  });
  const recent = new RecentIds();
  const counters: Record<Outcome, number> = { published: 0, duplicate: 0, dead_lettered: 0, unauthorized: 0, unknown_tenant: 0, unavailable: 0 };

  // Keep the raw bytes: the HMAC is computed over the exact body RestroFlow sent.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const ready = opts.publisher.isReady();
    return reply.code(ready ? 200 : 503).send({ ready });
  });
  app.get('/metrics', async (_req, reply) => {
    const lines = Object.entries(counters).map(([k, v]) => `restroflow_ingest_webhooks_total{outcome="${k}"} ${v}`);
    return reply.type('text/plain; version=0.0.4').send(['# TYPE restroflow_ingest_webhooks_total counter', ...lines, ''].join('\n'));
  });

  app.post<{ Params: { tenant: string } }>('/v1/webhooks/restroflow/:tenant', async (req, reply) => {
    const tenant = req.params.tenant;
    const secret = opts.tenants[tenant];
    if (!secret) {
      counters.unknown_tenant++;
      return reply.code(404).send({ error: 'unknown_tenant' });
    }

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const signature = req.headers[SIGNATURE_HEADER] as string | undefined;
    if (!verifySignature(raw, signature, secret)) {
      counters.unauthorized++;
      req.log.warn({ tenant }, 'invalid webhook signature');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const receivedAt = new Date();
    const deliveryId = String(req.headers['x-restroflow-delivery'] ?? '');

    // Authentic but not understood → dead-letter queue (scrubbed), and 202 so RestroFlow stops retrying.
    const deadLetter = async (reason: string, payload: unknown) => {
      await opts.publisher.publish({
        topic: TOPICS.deadLetter,
        key: partitionKey(tenant, 'dlq', deliveryId || receivedAt.getTime()),
        value: {
          tenant,
          reason,
          deliveryId,
          receivedAt: receivedAt.toISOString(),
          bodySha256: createHash('sha256').update(raw).digest('hex'),
          bodyBytes: raw.length,
          payload: payload === undefined ? null : scrub(payload),
        },
        headers: { 'rf-tenant': tenant, 'rf-reason': reason.slice(0, 200) },
      });
      counters.dead_lettered++;
      req.log.warn({ tenant, reason }, 'webhook dead-lettered');
      return reply.code(202).send({ status: 'dead_lettered', reason });
    };

    try {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        return await deadLetter('invalid_json', undefined);
      }

      const parsed = parseWebhook(json);
      if (!parsed.ok) return await deadLetter(`schema: ${parsed.error}`, json);

      const routed = toDomainEvent(tenant, parsed.webhook, receivedAt);
      const leaks = findForbiddenKeys(routed.event);
      if (leaks.length) return await deadLetter(`privacy_guard: ${leaks.join(',')}`, undefined);

      if (recent.has(routed.event.eventId)) {
        counters.duplicate++;
        return reply.code(200).send({ status: 'duplicate', eventId: routed.event.eventId });
      }

      await opts.publisher.publish({
        topic: routed.topic,
        key: routed.key,
        value: routed.event,
        headers: {
          'rf-tenant': tenant,
          'rf-event-type': routed.event.type,
          'rf-event-id': routed.event.eventId,
          'rf-schema-version': String(routed.event.schemaVersion),
        },
      });
      recent.add(routed.event.eventId);
      counters.published++;
      req.log.info({ tenant, type: routed.event.type, eventId: routed.event.eventId, topic: routed.topic }, 'event published');
      return reply.code(202).send({ status: 'published', eventId: routed.event.eventId, topic: routed.topic });
    } catch (err) {
      // Kafka unreachable: answer 503 so RestroFlow's built-in retry delivers it later. Nothing is lost.
      counters.unavailable++;
      req.log.error({ err, tenant }, 'publish failed');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }
  });

  return app;
}
