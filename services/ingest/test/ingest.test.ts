import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TOPICS, fakeOrderWebhook, findForbiddenKeys, sign } from '@restroflow-events/contracts';
import { buildApp } from '../src/app.js';
import { MemoryPublisher } from '../src/publisher.js';

const TENANT = 'namaste-india-siegen';
const SECRET = 'test-secret-0123456789abcdef';

let app: FastifyInstance;
let pub: MemoryPublisher;

beforeEach(() => {
  pub = new MemoryPublisher();
  app = buildApp({ tenants: { [TENANT]: SECRET }, publisher: pub });
});
afterEach(() => app.close());

function post(body: string, opts: { tenant?: string; secret?: string; signature?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: `/v1/webhooks/restroflow/${opts.tenant ?? TENANT}`,
    headers: {
      'content-type': 'application/json',
      'x-restroflow-signature': opts.signature ?? sign(body, opts.secret ?? SECRET),
      'x-restroflow-delivery': 'dlv_test',
    },
    payload: body,
  });
}

describe('POST /v1/webhooks/restroflow/:tenant', () => {
  it('publishes a valid, signed order event without personal data', async () => {
    const res = await post(JSON.stringify(fakeOrderWebhook({ id: 11 })));
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('published');
    expect(pub.records).toHaveLength(1);
    const rec = pub.records[0]!;
    expect(rec.topic).toBe(TOPICS.orders);
    expect(rec.key).toBe(`${TENANT}:order:11`);
    expect(rec.headers?.['rf-event-type']).toBe('order.created');
    expect(findForbiddenKeys(rec.value)).toEqual([]);
    expect(JSON.stringify(rec.value)).not.toContain('max@example.com');
  });

  it('rejects a wrong signature with 401 and publishes nothing', async () => {
    const res = await post(JSON.stringify(fakeOrderWebhook({ id: 12 })), { secret: 'wrong-secret-0123456789' });
    expect(res.statusCode).toBe(401);
    expect(pub.records).toHaveLength(0);
  });

  it('returns 404 for an unknown tenant', async () => {
    const res = await post('{}', { tenant: 'someone-else' });
    expect(res.statusCode).toBe(404);
  });

  it('sends authentic but invalid payloads to the dead-letter queue, scrubbed', async () => {
    const bad = { id: 'dlv_x', event: 'order.created', created_at: 'now', data: { order: { id: 'not-a-number', customer: { email: 'max@example.com' } } } };
    const res = await post(JSON.stringify(bad));
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('dead_lettered');
    const rec = pub.records[0]!;
    expect(rec.topic).toBe(TOPICS.deadLetter);
    expect(JSON.stringify(rec.value)).not.toContain('max@example.com');

    const res2 = await post('{not json');
    expect(res2.json().reason).toBe('invalid_json');
  });

  it('answers a retried webhook as duplicate (same eventId, new delivery id)', async () => {
    const wh = fakeOrderWebhook({ id: 13, placedAt: 1_800_000_000 });
    await post(JSON.stringify(wh));
    const res = await post(JSON.stringify({ ...wh, id: 'dlv_retry' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('duplicate');
    expect(pub.records).toHaveLength(1);
  });

  it('returns 503 when Kafka is unavailable, so RestroFlow retries later', async () => {
    pub.failNext = 1;
    const body = JSON.stringify(fakeOrderWebhook({ id: 14, placedAt: 1_800_000_100 }));
    const res = await post(body);
    expect(res.statusCode).toBe(503);
    // The retry succeeds and is not treated as a duplicate
    const retry = await post(body);
    expect(retry.statusCode).toBe(202);
    expect(pub.records).toHaveLength(1);
  });

  it('exposes Prometheus counters', async () => {
    await post(JSON.stringify(fakeOrderWebhook({ id: 15 })));
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.body).toContain('restroflow_ingest_webhooks_total{outcome="published"} 1');
  });
});
