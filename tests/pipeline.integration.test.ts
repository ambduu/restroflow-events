/**
 * End-to-end: signed webhook → ingest (HTTP) → real Kafka → analytics consumer → stats.
 * Requires a broker at KAFKA_BROKERS (default localhost:9092).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { TOPICS, fakeOrderWebhook, sign } from '@restroflow-events/contracts';
import { createKafka, ensureTopics, kafkaConfigFromEnv, type Consumer } from '@restroflow-events/kafka';
import { buildApp } from '../services/ingest/src/app.js';
import { KafkaPublisher } from '../services/ingest/src/publisher.js';
import { Projection } from '../services/analytics/src/projection.js';
import { startConsumer, type ConsumerStats } from '../services/analytics/src/consumer.js';
import { computeStats } from '../services/analytics/src/stats.js';

const cfg = kafkaConfigFromEnv('restroflow-it');
const TENANT = 'it-' + randomUUID().slice(0, 8); // fresh tenant per run
const SECRET = 'integration-secret-0123456789';
const now = Math.floor(Date.now() / 1000) - 3600;

let publisher: KafkaPublisher;
let app: FastifyInstance;
let projection: Projection;
let consumer: Consumer;
let stats: ConsumerStats;
let dlqConsumer: Consumer;
const dlq: Array<Record<string, unknown>> = [];

const post = (payload: unknown) => {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: `/v1/webhooks/restroflow/${TENANT}`,
    headers: { 'content-type': 'application/json', 'x-restroflow-signature': sign(body, SECRET) },
    payload: body,
  });
};

async function waitFor(check: () => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timed out waiting for consumer');
}

beforeAll(async () => {
  await ensureTopics(createKafka(cfg), { partitions: 2, replicationFactor: 1 });
  publisher = new KafkaPublisher(cfg);
  await publisher.connect();
  app = buildApp({ tenants: { [TENANT]: SECRET }, publisher });

  projection = new Projection(':memory:');
  ({ consumer, stats } = await startConsumer(cfg, projection, { groupId: 'it-analytics-' + TENANT, log: () => {} }));

  dlqConsumer = createKafka(cfg).consumer({ kafkaJS: { groupId: 'it-dlq-' + TENANT, fromBeginning: true } } as never);
  await dlqConsumer.connect();
  await dlqConsumer.subscribe({ topics: [TOPICS.deadLetter] });
  await dlqConsumer.run({
    eachMessage: async ({ message }) => {
      const v = JSON.parse(message.value?.toString() ?? '{}');
      if (v.tenant === TENANT) dlq.push(v);
    },
  });
});

afterAll(async () => {
  await Promise.allSettled([consumer?.disconnect(), dlqConsumer?.disconnect(), publisher?.close(), app?.close()]);
  projection?.close();
});

describe('webhook → Kafka → analytics', () => {
  it('processes a full order lifecycle exactly once, despite retries', async () => {
    const lines = [{ dish: 0, qty: 2 }];
    const created = fakeOrderWebhook({ id: 1, placedAt: now, lines });
    const steps = [
      created,
      { ...created, id: 'dlv_retry_1' }, // webhook retry with a new delivery id
      fakeOrderWebhook({ id: 1, placedAt: now, lines, event: 'order.accepted', acceptedAt: now + 90, updatedAt: now + 90 }),
      fakeOrderWebhook({ id: 1, placedAt: now, lines, event: 'order.ready', acceptedAt: now + 90, readyAt: now + 1290, updatedAt: now + 1290 }),
      fakeOrderWebhook({ id: 1, placedAt: now, lines, event: 'order.completed', acceptedAt: now + 90, readyAt: now + 1290, updatedAt: now + 1800 }),
    ];
    const codes = [];
    for (const s of steps) codes.push((await post(s)).statusCode);
    expect(codes).toEqual([202, 200, 202, 202, 202]); // second one answered as duplicate

    await waitFor(() => stats.applied >= 4);
    const s = computeStats(projection, TENANT, new Date((now - 3600) * 1000), new Date());
    expect(s.orders).toMatchObject({ total: 1, completed: 1 });
    expect(s.revenue.total).toBe(31.8);
    expect(s.kitchen).toEqual({ avgAcceptSeconds: 90, avgPrepSeconds: 1200 });
  });

  it('dead-letters an authentic but malformed webhook without personal data', async () => {
    const res = await post({ id: 'dlv_bad', event: 'order.created', created_at: 'x', data: { order: { id: 'oops', customer: { email: 'leak@example.com' } } } });
    expect(res.statusCode).toBe(202);
    await waitFor(() => dlq.length >= 1);
    expect(String(dlq[0]?.reason)).toMatch(/^schema:/);
    expect(JSON.stringify(dlq[0])).not.toContain('leak@example.com');
  });
});
