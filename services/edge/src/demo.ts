import type { FastifyInstance } from 'fastify';
import { fakeOrderWebhook, fakeProductWebhook, fakeStoreWebhook, parseWebhook, sign, toDomainEvent } from '@restroflow-events/contracts';
import type { Projection } from '@restroflow-events/analytics/projection';

/**
 * Demo restaurant ("Spice Route Kitchen") for the public live demo.
 *
 * Every day gets a deterministic plan (seeded by the date): opening hours, ~30–50 orders
 * clustered around lunch and dinner, accept → ready → picked up, a few declined orders and a
 * dish that sells out for an hour. Each step is sent as a SIGNED webhook through the normal
 * ingest route at the moment it happens, so it really travels webhook → Kafka → consumer →
 * read model → dashboard.
 *
 * Because the plan and the event IDs are deterministic, re-sending after a restart is harmless
 * (the projection drops duplicates). On start it also fills in the last few days, so the
 * "7 days" view has history even on a free host that sleeps and keeps no disk.
 */
export interface DemoOptions {
  app: FastifyInstance;
  tenant: string;
  secret: string;
  projection: Projection;
  timeZone?: string;
  /** Days of history to make sure exist (Kafka retention on the free plan is 7 days). */
  historyDays?: number;
  tickMs?: number;
  log?: (msg: string, extra?: object) => void;
}

interface PlannedEvent {
  at: number; // unix seconds
  payload: unknown;
  label: string;
}

/* ---------- deterministic randomness ---------- */
function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- time zone helpers ---------- */
/** "YYYY-MM-DD" of an instant in the given time zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Unix seconds for a local wall-clock time (minutes after midnight) on a local date. */
export function localToUnix(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // offset of the zone at that moment (handles DST)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const asLocal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((guess - (asLocal - guess)) / 1000);
}

/* ---------- the plan for one day ---------- */
const LUNCH = [11 * 60 + 30, 14 * 60 + 30];
const DINNER = [17 * 60, 22 * 60];

export function planDay(date: string, timeZone: string): PlannedEvent[] {
  const r = seeded('spice-route|' + date);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const at = (min: number) => localToUnix(date, min, timeZone);
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
  const busy = weekday === 5 || weekday === 6 ? 1.4 : weekday === 0 ? 1.2 : 1;
  const events: PlannedEvent[] = [];

  // Opening hours: online ordering opens and pauses with the kitchen
  events.push({ at: at(LUNCH[0]! - 5), payload: fakeStoreWebhook(false, at(LUNCH[0]! - 5)), label: 'store opened' });
  events.push({ at: at(LUNCH[1]! + 5), payload: fakeStoreWebhook(true, at(LUNCH[1]! + 5)), label: 'store paused' });
  events.push({ at: at(DINNER[0]! - 5), payload: fakeStoreWebhook(false, at(DINNER[0]! - 5)), label: 'store opened' });
  events.push({ at: at(DINNER[1]! + 5), payload: fakeStoreWebhook(true, at(DINNER[1]! + 5)), label: 'store closed' });

  // Order times: lunch peak 12–13:30, dinner peak 18:30–20:30
  const times: number[] = [];
  const lunchOrders = Math.round(int(9, 15) * busy);
  const dinnerOrders = Math.round(int(16, 26) * busy);
  const peak = (lo: number, hi: number, center: number, spread: number) => {
    const v = center + (r() + r() + r() - 1.5) * spread; // roughly bell-shaped
    return Math.min(hi - 10, Math.max(lo, Math.round(v)));
  };
  for (let i = 0; i < lunchOrders; i++) times.push(peak(LUNCH[0]!, LUNCH[1]!, 12 * 60 + 45, 120));
  for (let i = 0; i < dinnerOrders; i++) times.push(peak(DINNER[0]!, DINNER[1]!, 19 * 60 + 30, 190));
  times.sort((a, b) => a - b);

  const dayNo = Number(date.replace(/-/g, '')) % 10_000;
  times.forEach((min, i) => {
    const id = dayNo * 100 + i + 1; // deterministic, unique per day
    const placed = at(min) + int(0, 59);
    const lines = Array.from({ length: int(1, 4) }, () => ({ dish: int(0, 7), qty: r() < 0.75 ? 1 : 2 }));
    const source = r() < 0.5 ? 'web' : r() < 0.6 ? 'ios' : 'android';
    const type = r() < 0.85 ? ('pickup' as const) : ('delivery' as const);
    const base = { id, placedAt: placed, lines, source, type, deliveryId: `dlv_demo_${id}` };
    events.push({ at: placed, payload: fakeOrderWebhook({ ...base, deliveryId: `dlv_demo_${id}_c` }), label: `order ${id} created` });

    if (r() < 0.04) {
      const t = placed + int(40, 180);
      events.push({ at: t, payload: fakeOrderWebhook({ ...base, event: 'order.declined', updatedAt: t, deliveryId: `dlv_demo_${id}_d` }), label: `order ${id} declined` });
      return;
    }
    const busyNow = min >= 18 * 60 + 30 && min <= 20 * 60 + 30;
    const acc = placed + int(30, busyNow ? 300 : 180);
    const ready = acc + int(busyNow ? 15 : 11, busyNow ? 30 : 22) * 60;
    const done = ready + int(3, 14) * 60;
    events.push({ at: acc, payload: fakeOrderWebhook({ ...base, event: 'order.accepted', acceptedAt: acc, updatedAt: acc, deliveryId: `dlv_demo_${id}_a` }), label: `order ${id} accepted` });
    events.push({ at: ready, payload: fakeOrderWebhook({ ...base, event: 'order.ready', acceptedAt: acc, readyAt: ready, updatedAt: ready, deliveryId: `dlv_demo_${id}_r` }), label: `order ${id} ready` });
    events.push({ at: done, payload: fakeOrderWebhook({ ...base, event: 'order.completed', acceptedAt: acc, readyAt: ready, updatedAt: done, deliveryId: `dlv_demo_${id}_p` }), label: `order ${id} picked up` });
  });

  // Mango Lassi sells out on some evenings
  if (r() < 0.5) {
    const out = at(int(19 * 60 + 15, 20 * 60 + 15));
    const back = out + int(45, 90) * 60;
    events.push({ at: out, payload: fakeProductWebhook(105, false, out), label: 'Mango Lassi sold out' });
    events.push({ at: back, payload: fakeProductWebhook(105, true, back), label: 'Mango Lassi available again' });
  }
  return events.sort((a, b) => a.at - b.at);
}

/* ---------- runner ---------- */
export class DemoRestaurant {
  private timer: NodeJS.Timeout | null = null;
  private sent = new Set<string>();
  private plans = new Map<string, PlannedEvent[]>();
  private running = false;
  private readonly tz: string;

  constructor(private readonly o: DemoOptions) {
    this.tz = o.timeZone ?? 'Europe/Berlin';
  }

  start(delayMs = 0): void {
    const go = () => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 20_000);
    };
    if (delayMs > 0) setTimeout(go, delayMs);
    else go();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private plan(date: string): PlannedEvent[] {
    let p = this.plans.get(date);
    if (!p) {
      p = planDay(date, this.tz);
      this.plans.set(date, p);
      if (this.plans.size > 10) this.plans.delete(this.plans.keys().next().value as string);
    }
    return p;
  }

  /** Already in the read model (e.g. replayed from Kafka after a restart)? */
  private alreadyApplied(payload: unknown): string | null {
    const parsed = parseWebhook(payload);
    if (!parsed.ok) return null;
    const id = toDomainEvent(this.o.tenant, parsed.webhook, new Date()).event.eventId;
    const row = this.o.projection.db.prepare('SELECT 1 FROM processed_events WHERE event_id = ?').get(id);
    return row ? id : null;
  }

  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let count = 0;
    try {
      const nowS = Math.floor(now.getTime() / 1000);
      const days = this.o.historyDays ?? 6;
      for (let back = days; back >= 0; back--) {
        const date = localDate(new Date(now.getTime() - back * 86_400_000), this.tz);
        for (const ev of this.plan(date)) {
          if (ev.at > nowS) break;
          const key = date + '|' + ev.label + '|' + ev.at;
          if (this.sent.has(key)) continue;
          if (this.alreadyApplied(ev.payload)) {
            this.sent.add(key);
            continue;
          }
          const body = JSON.stringify(ev.payload);
          const res = await this.o.app.inject({
            method: 'POST',
            url: `/v1/webhooks/restroflow/${this.o.tenant}`,
            headers: { 'content-type': 'application/json', 'x-restroflow-signature': sign(body, this.o.secret) },
            payload: body,
          });
          if (res.statusCode >= 500) {
            this.o.log?.('demo: Kafka not reachable, retrying next tick', { status: res.statusCode });
            return count;
          }
          this.sent.add(key);
          count++;
        }
      }
      if (this.sent.size > 20_000) this.sent.clear();
      if (count) this.o.log?.('demo: events sent', { count });
      return count;
    } finally {
      this.running = false;
    }
  }
}
