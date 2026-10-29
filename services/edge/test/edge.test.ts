import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { fakeOrderWebhook, sign, type DomainEvent } from '@restroflow-events/contracts';
import { MemoryPublisher } from '@restroflow-events/ingest/publisher';
import { Projection } from '@restroflow-events/analytics/projection';
import { buildEdge } from '../src/app.js';

const TENANT = 'namaste-india-siegen';
const SECRET = 'test-secret-0123456789abcdef';
let app: FastifyInstance;
let projection: Projection;

afterEach(async () => {
  await app.close();
  projection.close();
});

function setup() {
  const publisher = new MemoryPublisher();
  projection = new Projection(':memory:');
  app = buildEdge({ ingest: { tenants: { [TENANT]: SECRET }, publisher }, projection, consumerStats: () => null });
  return publisher;
}

describe('edge (single-process) service', () => {
  it('accepts signed webhooks and serves analytics from the same port', async () => {
    const pub = setup();
    const body = JSON.stringify(fakeOrderWebhook({ id: 42 }));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/restroflow/${TENANT}`,
      headers: { 'content-type': 'application/json', 'x-restroflow-signature': sign(body, SECRET) },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(pub.records).toHaveLength(1);

    // what the Kafka consumer would do with the published record
    projection.apply(pub.records[0]!.value as DomainEvent);
    const board = await app.inject({ method: 'GET', url: `/v1/board/${TENANT}` });
    expect(board.statusCode).toBe(200);
    expect(board.json().orders.length).toBeGreaterThan(0);
  });

  it('has one combined health check and hides /metrics', async () => {
    setup();
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toMatchObject({ ok: true, mode: 'edge' });
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
  });

  it('still rejects unsigned webhooks', async () => {
    setup();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/restroflow/${TENANT}`,
      headers: { 'content-type': 'application/json', 'x-restroflow-signature': 'sha256=bad' },
      payload: JSON.stringify(fakeOrderWebhook({ id: 1 })),
    });
    expect(res.statusCode).toBe(401);
  });
});
