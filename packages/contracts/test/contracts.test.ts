import { describe, expect, it } from 'vitest';
import {
  TOPICS,
  findForbiddenKeys,
  parseWebhook,
  sign,
  toDomainEvent,
  verifySignature,
  type OrderEvent,
} from '../src/index.js';
import { fakeOrderWebhook, fakeProductWebhook, fakeStoreWebhook } from '../src/fixtures.js';

const TENANT = 'namaste-india-siegen';

describe('signature', () => {
  const body = JSON.stringify({ hello: 'world' });
  const secret = 's3cret';

  it('accepts a correct RestroFlow signature', () => {
    expect(verifySignature(body, sign(body, secret), secret)).toBe(true);
  });

  it('rejects a wrong secret, a tampered body and malformed headers', () => {
    expect(verifySignature(body, sign(body, 'other'), secret)).toBe(false);
    expect(verifySignature(body + ' ', sign(body, secret), secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, 'sha256=abc', secret)).toBe(false);
    expect(verifySignature(body, sign(body, secret).replace('sha256=', 'md5='), secret)).toBe(false);
  });
});

describe('webhook parsing', () => {
  it('parses order, product and store webhooks', () => {
    for (const wh of [fakeOrderWebhook({ id: 42 }), fakeProductWebhook(101, false), fakeStoreWebhook(true)]) {
      const r = parseWebhook(wh);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });

  it('rejects unknown events and broken payloads with a readable reason', () => {
    const r1 = parseWebhook({ ...fakeOrderWebhook({ id: 1 }), event: 'order.exploded' });
    expect(r1.ok).toBe(false);
    const r2 = parseWebhook({ id: 'x', event: 'order.created', created_at: 'now', data: { order: { id: 'abc' } } });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/order/);
  });
});

describe('domain events (privacy + idempotency)', () => {
  it('drops all personal data before Kafka', () => {
    const r = parseWebhook(fakeOrderWebhook({ id: 7, type: 'delivery', event: 'order.declined' }));
    if (!r.ok) throw new Error(r.error);
    const { event } = toDomainEvent(TENANT, r.webhook);
    const json = JSON.stringify(event);
    expect(findForbiddenKeys(event)).toEqual([]);
    for (const secret of ['Max Mustermann', 'max@example.com', '+49 271 000000', 'Musterstraße', 'Bitte klingeln', 'extra scharf', 'pi_FAKE123', 'Küche überlastet']) {
      expect(json).not.toContain(secret);
    }
  });

  it('keeps the business data needed for analytics', () => {
    const r = parseWebhook(fakeOrderWebhook({ id: 9, lines: [{ dish: 0, qty: 2 }, { dish: 4, qty: 1 }], source: 'ios' }));
    if (!r.ok) throw new Error(r.error);
    const routed = toDomainEvent(TENANT, r.webhook);
    const e = routed.event as OrderEvent;
    expect(routed.topic).toBe(TOPICS.orders);
    expect(routed.key).toBe(`${TENANT}:order:9`);
    expect(e.order.total).toBe(36.3);
    expect(e.order.itemCount).toBe(3);
    expect(e.order.source).toBe('ios');
    expect(e.order.items.map((i) => i.name)).toEqual(['Butter Chicken', 'Mango Lassi']);
    expect(e.order.placedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('gives a webhook retry (new delivery id) the same eventId', () => {
    const a = fakeOrderWebhook({ id: 5, placedAt: 1_800_000_000, deliveryId: 'dlv_first' });
    const b = { ...a, id: 'dlv_retry' };
    const ea = toDomainEvent(TENANT, (parseWebhook(a) as { ok: true; webhook: never }).webhook).event;
    const eb = toDomainEvent(TENANT, (parseWebhook(b) as { ok: true; webhook: never }).webhook).event;
    expect(ea.deliveryId).not.toBe(eb.deliveryId);
    expect(ea.eventId).toBe(eb.eventId);
  });

  it('gives different status changes of the same order different eventIds', () => {
    const t = 1_800_000_000;
    const created = parseWebhook(fakeOrderWebhook({ id: 5, placedAt: t }));
    const accepted = parseWebhook(fakeOrderWebhook({ id: 5, placedAt: t, event: 'order.accepted', acceptedAt: t + 60, updatedAt: t + 60 }));
    if (!created.ok || !accepted.ok) throw new Error('parse');
    expect(toDomainEvent(TENANT, created.webhook).event.eventId).not.toBe(toDomainEvent(TENANT, accepted.webhook).event.eventId);
  });

  it('routes product and store events to their own topics', () => {
    const p = parseWebhook(fakeProductWebhook(104, false));
    const s = parseWebhook(fakeStoreWebhook(true));
    if (!p.ok || !s.ok) throw new Error('parse');
    expect(toDomainEvent(TENANT, p.webhook).topic).toBe(TOPICS.catalog);
    expect(toDomainEvent(TENANT, s.webhook).topic).toBe(TOPICS.store);
  });
});
