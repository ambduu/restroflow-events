import { describe, expect, it } from 'vitest';
import { MemoryPublisher } from '@restroflow-events/ingest/publisher';
import { Projection } from '@restroflow-events/analytics/projection';
import type { DomainEvent } from '@restroflow-events/contracts';
import { buildEdge } from '../src/app.js';
import { DemoRestaurant, localToUnix, planDay } from '../src/demo.js';

const TZ = 'Europe/Berlin';

describe('demo restaurant plan', () => {
  it('is deterministic per day and sorted', () => {
    // (store/product webhooks carry a random delivery id; the event IDs are derived from the business facts)
    const shape = (p: ReturnType<typeof planDay>) => p.map((e) => e.at + ' ' + e.label).join('\n');
    const a = planDay('2026-10-30', TZ);
    const b = planDay('2026-10-30', TZ);
    expect(shape(a)).toBe(shape(b));
    expect(a.map((e) => e.at)).toEqual([...a.map((e) => e.at)].sort((x, y) => x - y));
    expect(shape(planDay('2026-10-31', TZ))).not.toBe(shape(a));
  });

  it('has a realistic number of orders inside opening hours', () => {
    const plan = planDay('2026-10-30', TZ);
    const created = plan.filter((e) => e.label.endsWith('created'));
    expect(created.length).toBeGreaterThanOrEqual(25);
    expect(created.length).toBeLessThanOrEqual(60);
    const open = localToUnix('2026-10-30', 11 * 60 + 30, TZ);
    const close = localToUnix('2026-10-30', 22 * 60, TZ);
    for (const e of created) expect(e.at).toBeGreaterThanOrEqual(open), expect(e.at).toBeLessThan(close);
  });

  it('converts local time correctly across daylight saving time', () => {
    // 12:00 in Berlin: UTC+2 in summer, UTC+1 in winter
    expect(new Date(localToUnix('2026-07-01', 12 * 60, TZ) * 1000).toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(new Date(localToUnix('2026-12-01', 12 * 60, TZ) * 1000).toISOString()).toBe('2026-12-01T11:00:00.000Z');
  });
});

describe('demo restaurant runner', () => {
  it('sends due events through the signed webhook route, and nothing twice', async () => {
    const publisher = new MemoryPublisher();
    const projection = new Projection(':memory:');
    const secret = 'demo-secret-0123456789abcdef';
    const app = buildEdge({ ingest: { tenants: { demo: secret }, publisher }, projection, consumerStats: () => null });
    const demo = new DemoRestaurant({ app, tenant: 'demo', secret, projection, historyDays: 0, timeZone: TZ });

    const noon = new Date(localToUnix('2026-10-30', 13 * 60, TZ) * 1000);
    const n = await demo.tick(noon);
    expect(n).toBeGreaterThan(5);
    expect(publisher.records.every((r) => !JSON.stringify(r.value).includes('max@example.com'))).toBe(true);

    // what the consumer would do; then a "restart" (new runner) must not resend
    for (const r of publisher.records) projection.apply(r.value as DomainEvent);
    const before = publisher.records.length;
    const again = new DemoRestaurant({ app, tenant: 'demo', secret, projection, historyDays: 0, timeZone: TZ });
    expect(await again.tick(noon)).toBe(0);
    expect(publisher.records.length).toBe(before);

    // later in the day more events become due
    expect(await demo.tick(new Date(noon.getTime() + 6 * 3600_000))).toBeGreaterThan(10);
    await app.close();
    projection.close();
  });
});
