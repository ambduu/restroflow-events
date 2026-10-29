import type { Projection } from './projection.js';

export interface Stats {
  tenant: string;
  from: string;
  to: string;
  timezone: string;
  orders: { total: number; completed: number; declined: number; open: number };
  revenue: { total: number; currency: string; averageOrderValue: number };
  topDishes: Array<{ name: string; qty: number; revenue: number }>;
  bySource: Record<string, number>;
  byType: Record<string, number>;
  byHour: number[]; // 24 buckets, local time
  byDay: Array<{ date: string; orders: number; revenue: number }>;
  kitchen: { avgAcceptSeconds: number | null; avgPrepSeconds: number | null };
  store: { paused: boolean; enabled: boolean; accepting: boolean | null; updatedAt: string } | null;
  eventsProcessed: number;
}

interface OrderRow {
  status: string;
  type: string;
  source: string;
  currency: string;
  total: number;
  placed_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  declined_at: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const seconds = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null);

const OPEN = new Set(['new', 'accepted', 'ready', 'pending_payment']);
const LOST = new Set(['declined', 'cancelled', 'expired']);

export function computeStats(p: Projection, tenant: string, from: Date, to: Date, timezone = 'Europe/Berlin'): Stats {
  const rows = p.db
    .prepare(
      `SELECT status, type, source, currency, total, placed_at, accepted_at, ready_at, declined_at
         FROM orders WHERE tenant = ? AND placed_at >= ? AND placed_at < ?`,
    )
    .all(tenant, from.toISOString(), to.toISOString()) as unknown as OrderRow[];

  const sold = rows.filter((r) => !LOST.has(r.status));
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

  const byHour = Array.from({ length: 24 }, () => 0);
  const byDay = new Map<string, { orders: number; revenue: number }>();
  const bySource: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const r of sold) {
    const d = new Date(r.placed_at);
    byHour[Number(hourFmt.format(d)) % 24]! += 1;
    const day = dayFmt.format(d);
    const cur = byDay.get(day) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += r.total;
    byDay.set(day, cur);
    bySource[r.source || 'web'] = (bySource[r.source || 'web'] ?? 0) + 1;
    byType[r.type || 'pickup'] = (byType[r.type || 'pickup'] ?? 0) + 1;
  }

  const revenue = round2(sold.reduce((s, r) => s + r.total, 0));

  const topDishes = p.db
    .prepare(
      `SELECT i.name AS name, SUM(i.qty) AS qty, SUM(i.line_total) AS revenue
         FROM order_items i JOIN orders o ON o.tenant = i.tenant AND o.order_id = i.order_id
        WHERE o.tenant = ? AND o.placed_at >= ? AND o.placed_at < ? AND o.status NOT IN ('declined','cancelled','expired')
        GROUP BY i.name ORDER BY qty DESC, revenue DESC LIMIT 10`,
    )
    .all(tenant, from.toISOString(), to.toISOString()) as unknown as Array<{ name: string; qty: number; revenue: number }>;

  const store = p.db.prepare('SELECT enabled, paused, accepting, updated_at FROM store_state WHERE tenant = ?').get(tenant) as
    | { enabled: number; paused: number; accepting: number | null; updated_at: string }
    | undefined;

  const processed = p.db.prepare('SELECT COUNT(*) AS n FROM processed_events WHERE tenant = ?').get(tenant) as { n: number };

  return {
    tenant,
    from: from.toISOString(),
    to: to.toISOString(),
    timezone,
    orders: {
      total: rows.length,
      completed: rows.filter((r) => r.status === 'completed').length,
      declined: rows.filter((r) => LOST.has(r.status)).length,
      open: rows.filter((r) => OPEN.has(r.status)).length,
    },
    revenue: { total: revenue, currency: sold[0]?.currency ?? 'EUR', averageOrderValue: sold.length ? round2(revenue / sold.length) : 0 },
    topDishes: topDishes.map((d) => ({ name: d.name, qty: Number(d.qty), revenue: round2(Number(d.revenue)) })),
    bySource,
    byType,
    byHour,
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, orders: v.orders, revenue: round2(v.revenue) })),
    kitchen: {
      avgAcceptSeconds: avg(sold.map((r) => seconds(r.placed_at, r.accepted_at)).filter((x): x is number => x !== null && x >= 0)),
      avgPrepSeconds: avg(sold.map((r) => seconds(r.accepted_at, r.ready_at)).filter((x): x is number => x !== null && x >= 0)),
    },
    store: store ? { enabled: !!store.enabled, paused: !!store.paused, accepting: store.accepting === null ? null : !!store.accepting, updatedAt: store.updated_at } : null,
    eventsProcessed: Number(processed.n),
  };
}
