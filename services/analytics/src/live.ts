import type { DomainEvent } from '@restroflow-events/contracts';
import type { Projection } from './projection.js';

/** One ticket on the kitchen pass (no personal data – there is none in the read model). */
export interface BoardOrder {
  id: number;
  number: string;
  status: string;
  type: string;
  source: string;
  total: number;
  itemCount: number;
  placedAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  items: Array<{ name: string; qty: number }>;
}

export interface StreamEntry {
  eventId: string;
  type: string;
  topic: string;
  entityId: number | null;
  label: string | null;
  status: string | null;
  total: number | null;
  occurredAt: string;
  receivedAt: string;
}

const LIVE = ['new', 'accepted', 'ready'];

/**
 * Orders currently on the pass: everything open, plus orders picked up
 * within the last `recentMinutes` (so the last lane isn't empty).
 */
export function getBoard(p: Projection, tenant: string, now = new Date(), recentMinutes = 45): BoardOrder[] {
  const since = new Date(now.getTime() - recentMinutes * 60_000).toISOString();
  const rows = p.db
    .prepare(
      `SELECT order_id, number, status, type, source, total, item_count, placed_at, accepted_at, ready_at, completed_at
         FROM orders
        WHERE tenant = ?
          AND (status IN (${LIVE.map(() => '?').join(',')}) OR (status = 'completed' AND completed_at >= ?))
        ORDER BY placed_at ASC
        LIMIT 200`,
    )
    .all(tenant, ...LIVE, since) as unknown as Array<Record<string, string | number | null>>;

  const itemsStmt = p.db.prepare('SELECT name, qty FROM order_items WHERE tenant = ? AND order_id = ? ORDER BY line');
  return rows.map((r) => ({
    id: Number(r.order_id),
    number: String(r.number ?? ''),
    status: String(r.status),
    type: String(r.type ?? 'pickup'),
    source: String(r.source ?? 'web'),
    total: Number(r.total ?? 0),
    itemCount: Number(r.item_count ?? 0),
    placedAt: (r.placed_at as string) ?? null,
    acceptedAt: (r.accepted_at as string) ?? null,
    readyAt: (r.ready_at as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
    items: (itemsStmt.all(tenant, Number(r.order_id)) as unknown as Array<{ name: string; qty: number }>).map((i) => ({ name: i.name, qty: Number(i.qty) })),
  }));
}

export function getRecentEvents(p: Projection, tenant: string, limit = 30): StreamEntry[] {
  const rows = p.db
    .prepare(
      `SELECT event_id, type, topic, entity_id, label, status, total, occurred_at, received_at
         FROM event_log WHERE tenant = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(tenant, Math.min(200, Math.max(1, limit))) as unknown as Array<Record<string, string | number | null>>;
  return rows.map((r) => ({
    eventId: String(r.event_id),
    type: String(r.type),
    topic: String(r.topic),
    entityId: r.entity_id === null ? null : Number(r.entity_id),
    label: (r.label as string) ?? null,
    status: (r.status as string) ?? null,
    total: r.total === null ? null : Number(r.total),
    occurredAt: String(r.occurred_at),
    receivedAt: String(r.received_at),
  }));
}

export function toStreamEntry(e: DomainEvent): StreamEntry {
  if (e.type === 'product.updated') {
    return { eventId: e.eventId, type: e.type, topic: 'restroflow.catalog.v1', entityId: e.product.id, label: e.product.name ?? null, status: e.product.available === false ? 'sold_out' : 'available', total: e.product.price ?? null, occurredAt: e.occurredAt, receivedAt: e.receivedAt };
  }
  if (e.type === 'store.updated') {
    return { eventId: e.eventId, type: e.type, topic: 'restroflow.store.v1', entityId: 0, label: 'store', status: e.store.paused ? 'paused' : 'open', total: null, occurredAt: e.occurredAt, receivedAt: e.receivedAt };
  }
  return { eventId: e.eventId, type: e.type, topic: 'restroflow.orders.v1', entityId: e.order.id, label: e.order.number, status: e.order.status, total: e.order.total, occurredAt: e.occurredAt, receivedAt: e.receivedAt };
}

type Listener = (entry: StreamEntry) => void;

/** Fan-out of applied events to connected dashboards (server-sent events), per tenant. */
export class LiveHub {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(tenant: string, fn: Listener): () => void {
    let set = this.listeners.get(tenant);
    if (!set) this.listeners.set(tenant, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(tenant);
    };
  }

  publish(e: DomainEvent): void {
    const set = this.listeners.get(e.tenant);
    if (!set) return;
    const entry = toStreamEntry(e);
    for (const fn of set) fn(entry);
  }

  clientCount(tenant?: string): number {
    if (tenant) return this.listeners.get(tenant)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}
