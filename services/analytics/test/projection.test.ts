import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeOrderWebhook,
  fakeProductWebhook,
  fakeStoreWebhook,
  parseWebhook,
  toDomainEvent,
  type DomainEvent,
} from '@restroflow-events/contracts';
import { Projection } from '../src/projection.js';
import { computeStats } from '../src/stats.js';
import { buildHttp } from '../src/http.js';

const TENANT = 'namaste-india-siegen';
const T0 = Math.floor(Date.parse('2026-10-28T18:00:00Z') / 1000); // 19:00 in Siegen

function ev(wh: unknown, tenant = TENANT): DomainEvent {
  const r = parseWebhook(wh);
  if (!r.ok) throw new Error(r.error);
  return toDomainEvent(tenant, r.webhook).event;
}

/** created → accepted (+2 min) → ready (+20 min) → completed (+30 min) */
function lifecycle(id: number, placed: number, lines = [{ dish: 0, qty: 1 }, { dish: 3, qty: 2 }]) {
  return [
    ev(fakeOrderWebhook({ id, placedAt: placed, lines })),
    ev(fakeOrderWebhook({ id, placedAt: placed, lines, event: 'order.accepted', acceptedAt: placed + 120, updatedAt: placed + 120 })),
    ev(fakeOrderWebhook({ id, placedAt: placed, lines, event: 'order.ready', acceptedAt: placed + 120, readyAt: placed + 1320, updatedAt: placed + 1320 })),
    ev(fakeOrderWebhook({ id, placedAt: placed, lines, event: 'order.completed', acceptedAt: placed + 120, readyAt: placed + 1320, updatedAt: placed + 1800 })),
  ];
}

let p: Projection;
beforeEach(() => {
  p = new Projection(':memory:');
});
afterEach(() => p.close());

const window = { from: new Date((T0 - 86_400) * 1000), to: new Date((T0 + 86_400) * 1000) };

describe('projection', () => {
  it('builds order statistics from the event stream', () => {
    lifecycle(1, T0).forEach((e) => p.apply(e));
    lifecycle(2, T0 + 600, [{ dish: 2, qty: 1 }, { dish: 4, qty: 2 }]).forEach((e) => p.apply(e));
    p.apply(ev(fakeOrderWebhook({ id: 3, placedAt: T0 + 900 })));
    p.apply(ev(fakeOrderWebhook({ id: 3, placedAt: T0 + 900, event: 'order.declined', updatedAt: T0 + 960 })));

    const s = computeStats(p, TENANT, window.from, window.to);
    expect(s.orders).toEqual({ total: 3, completed: 2, declined: 1, open: 0 });
    expect(s.revenue.total).toBe(50.6); // 23.70 + 26.90 – the declined order is not counted
    expect(s.revenue.averageOrderValue).toBe(25.3);
    expect(s.byHour[19]).toBe(2); // Europe/Berlin
    expect(s.kitchen).toEqual({ avgAcceptSeconds: 120, avgPrepSeconds: 1200 });
    // tie on quantity (2 each) → higher revenue first
    expect(s.topDishes.slice(0, 2)).toEqual([{ name: 'Mango Lassi', qty: 2, revenue: 9 }, { name: 'Garlic Naan', qty: 2, revenue: 7.8 }]);
  });

  it('is idempotent: redelivered events are not counted twice', () => {
    const events = lifecycle(1, T0);
    events.forEach((e) => p.apply(e));
    const again = events.map((e) => p.apply(e));
    expect(again).toEqual([false, false, false, false]);
    expect(computeStats(p, TENANT, window.from, window.to).orders.total).toBe(1);
  });

  it('ignores a stale status that arrives late', () => {
    const [created, accepted, ready] = lifecycle(1, T0);
    p.apply(created!);
    p.apply(ready!);
    p.apply(accepted!); // older than "ready"
    const row = p.db.prepare('SELECT status FROM orders WHERE order_id = 1').get() as { status: string };
    expect(row.status).toBe('ready');
  });

  it('keeps tenants apart', () => {
    lifecycle(1, T0).forEach((e) => p.apply(e));
    p.apply(ev(fakeOrderWebhook({ id: 1, placedAt: T0 }), 'other-restaurant'));
    expect(computeStats(p, TENANT, window.from, window.to).orders.total).toBe(1);
    expect(computeStats(p, 'other-restaurant', window.from, window.to).orders.total).toBe(1);
  });

  it('tracks store pause and product availability', () => {
    p.apply(ev(fakeStoreWebhook(true, T0)));
    p.apply(ev(fakeProductWebhook(104, false, T0)));
    expect(computeStats(p, TENANT, window.from, window.to).store?.paused).toBe(true);
    const prod = p.db.prepare('SELECT available FROM products WHERE product_id = 104').get() as { available: number };
    expect(prod.available).toBe(0);
  });
});

describe('HTTP API', () => {
  it('serves stats and validates the timezone', async () => {
    lifecycle(1, Math.floor(Date.now() / 1000) - 3600).forEach((e) => p.apply(e));
    const app = buildHttp(p, () => null);
    const res = await app.inject({ method: 'GET', url: `/v1/stats/${TENANT}?days=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().orders.completed).toBe(1);
    const bad = await app.inject({ method: 'GET', url: `/v1/stats/${TENANT}?tz=Mars/Base` });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
