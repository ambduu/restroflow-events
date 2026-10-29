import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { fakeOrderWebhook, fakeStoreWebhook, parseWebhook, toDomainEvent, type DomainEvent } from '@restroflow-events/contracts';
import { Projection } from '../src/projection.js';
import { LiveHub, getBoard, getRecentEvents } from '../src/live.js';
import { buildHttp, startOfLocalDay } from '../src/http.js';

const TENANT = 'namaste-india-siegen';
const now = Math.floor(Date.now() / 1000);

function ev(wh: unknown): DomainEvent {
  const r = parseWebhook(wh);
  if (!r.ok) throw new Error(r.error);
  return toDomainEvent(TENANT, r.webhook).event;
}

let p: Projection;
beforeEach(() => {
  p = new Projection(':memory:');
});
afterEach(() => p.close());

describe('kitchen board', () => {
  it('shows open orders and recently completed ones, with dish names but no personal data', () => {
    p.apply(ev(fakeOrderWebhook({ id: 1, placedAt: now - 600, lines: [{ dish: 0, qty: 2 }] })));
    p.apply(ev(fakeOrderWebhook({ id: 2, placedAt: now - 900, event: 'order.accepted', acceptedAt: now - 800, updatedAt: now - 800 })));
    p.apply(ev(fakeOrderWebhook({ id: 3, placedAt: now - 7200, event: 'order.completed', updatedAt: now - 6000 }))); // too old
    p.apply(ev(fakeOrderWebhook({ id: 4, placedAt: now - 1800, event: 'order.completed', updatedAt: now - 300 })));
    p.apply(ev(fakeOrderWebhook({ id: 5, placedAt: now - 300, event: 'order.declined', updatedAt: now - 200 })));

    const board = getBoard(p, TENANT, new Date(now * 1000));
    expect(board.map((o) => [o.id, o.status])).toEqual([[4, 'completed'], [2, 'accepted'], [1, 'new']]);
    expect(board.find((o) => o.id === 1)?.items).toEqual([{ name: 'Butter Chicken', qty: 2 }]);
    expect(JSON.stringify(board)).not.toMatch(/Mustermann|example\.com|klingeln/);
  });

  it('keeps a bounded, newest-first event log', () => {
    p.apply(ev(fakeStoreWebhook(false, now - 100)));
    p.apply(ev(fakeOrderWebhook({ id: 9, placedAt: now - 50 })));
    const log = getRecentEvents(p, TENANT, 10);
    expect(log.map((e) => e.type)).toEqual(['order.created', 'store.updated']);
    expect(log[0]).toMatchObject({ topic: 'restroflow.orders.v1', entityId: 9, status: 'new' });
  });
});

describe('time zones', () => {
  it('finds midnight in the restaurant time zone', () => {
    const t = new Date('2026-10-29T15:20:00Z'); // 16:20 in Berlin (CET)
    expect(startOfLocalDay(t, 'Europe/Berlin').toISOString()).toBe('2026-10-28T23:00:00.000Z');
  });
});

describe('server-sent events', () => {
  it('pushes applied events to connected dashboards of the same tenant only', async () => {
    const hub = new LiveHub();
    const app = buildHttp(p, () => null, { hub, heartbeatMs: 60_000 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/stream/${TENANT}`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (needle: string) => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await readUntil('event: hello');
    expect(hub.clientCount(TENANT)).toBe(1);

    const other = toDomainEvent('other-restaurant', (parseWebhook(fakeOrderWebhook({ id: 77 })) as { ok: true; webhook: never }).webhook).event;
    hub.publish(other); // must not arrive
    hub.publish(ev(fakeOrderWebhook({ id: 42 })));
    await readUntil('event: kafka');
    await readUntil('\n\n');
    expect(buf).toContain('"entityId":42');
    expect(buf).not.toContain('"entityId":77');

    ctrl.abort();
    await app.close();
  });

  it('rejects malformed tenant slugs', async () => {
    const app = buildHttp(p, () => null);
    const res = await app.inject({ method: 'GET', url: '/v1/board/..%2Fetc' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
