import { createHash } from 'node:crypto';
import type { RestroFlowOrder, RestroFlowProduct, RestroFlowStore, RestroFlowWebhook } from './webhook.js';
import { TOPICS, partitionKey, type TopicName } from './topics.js';

/**
 * Events as they are stored in Kafka.
 *
 * Privacy by design: these types simply have no fields for personal data.
 * Customer name, e-mail, phone, address, free-text notes, decline reasons and
 * payment transaction IDs are dropped in toDomainEvent() and never reach Kafka.
 */

export const SCHEMA_VERSION = 1;

export interface EventMeta {
  /** Stable ID of the business fact – identical for webhook retries (idempotency key). */
  eventId: string;
  schemaVersion: typeof SCHEMA_VERSION;
  type: RestroFlowWebhook['event'];
  tenant: string;
  /** When it happened in RestroFlow (ISO-8601). */
  occurredAt: string;
  /** When the ingest service received it (ISO-8601). */
  receivedAt: string;
  /** RestroFlow delivery id (differs per retry – kept for tracing only). */
  deliveryId: string;
}

export interface OrderLine {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface OrderSnapshot {
  id: number;
  number: string;
  status: string;
  type: 'pickup' | 'delivery';
  timeMode: string;
  source: string;
  currency: string;
  subtotal: number;
  deliveryFee: number;
  tip: number;
  total: number;
  taxTotal: number;
  deliveryZone: string;
  paymentMethod: string;
  paymentStatus: string;
  itemCount: number;
  items: OrderLine[];
  createdAt: string | null;
  placedAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  fulfillAt: string | null;
  updatedAt: string | null;
}

export interface OrderEvent extends EventMeta {
  type: Exclude<RestroFlowWebhook['event'], 'product.updated' | 'store.updated'>;
  order: OrderSnapshot;
}

export interface ProductEvent extends EventMeta {
  type: 'product.updated';
  product: { id: number; deleted: boolean; sku?: string; name?: string; price?: number; available?: boolean; categoryIds?: number[]; modifiedAt: string | null };
}

export interface StoreEvent extends EventMeta {
  type: 'store.updated';
  store: { enabled: boolean; paused: boolean; accepting: boolean | null; prepMinutes: number | null };
}

export type DomainEvent = OrderEvent | ProductEvent | StoreEvent;

export interface Routed<E extends DomainEvent = DomainEvent> {
  topic: TopicName;
  key: string;
  event: E;
}

const iso = (unix: number | undefined): string | null => (unix && unix > 0 ? new Date(unix * 1000).toISOString() : null);
const money = (n: number) => Math.round(n * 100) / 100;

/** Same fact → same id, even when RestroFlow re-sends the webhook with a new delivery id. */
export function eventIdFor(tenant: string, parts: Array<string | number>): string {
  return createHash('sha256').update([tenant, ...parts].join('|')).digest('hex').slice(0, 32);
}

export function orderSnapshot(o: RestroFlowOrder): OrderSnapshot {
  const items: OrderLine[] = o.items.map((l) => ({
    productId: l.product,
    sku: l.sku,
    name: l.name,
    qty: l.qty,
    unitPrice: money(l.unit),
    lineTotal: money(l.sum),
  }));
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    type: o.type,
    timeMode: o.time_mode,
    source: o.source,
    currency: o.currency,
    subtotal: money(o.subtotal),
    deliveryFee: money(o.delivery_fee),
    tip: money(o.tip),
    total: money(o.total),
    taxTotal: money(o.tax_total),
    deliveryZone: o.delivery_zone,
    paymentMethod: o.payment.method,
    paymentStatus: o.payment.status,
    itemCount: items.reduce((n, l) => n + l.qty, 0),
    items,
    createdAt: iso(o.created_at),
    placedAt: iso(o.placed_at),
    acceptedAt: iso(o.accepted_at),
    readyAt: iso(o.ready_at),
    fulfillAt: iso(o.fulfill_at),
    updatedAt: iso(o.updated_at),
  };
}

function productPayload(p: RestroFlowProduct): ProductEvent['product'] {
  const out: ProductEvent['product'] = { id: p.id, deleted: !!p.deleted, modifiedAt: iso(p.modified) };
  if (p.sku !== undefined) out.sku = p.sku;
  if (p.name !== undefined) out.name = p.name;
  if (p.price !== undefined) out.price = money(p.price);
  if (p.available !== undefined) out.available = p.available;
  if (p.category_ids !== undefined) out.categoryIds = p.category_ids;
  return out;
}

function storePayload(s: RestroFlowStore): StoreEvent['store'] {
  return { enabled: s.enabled, paused: s.paused, accepting: s.accepting ?? null, prepMinutes: s.prep ?? null };
}

/**
 * Turn a verified, parsed webhook into a privacy-safe domain event plus its
 * Kafka topic and partition key.
 */
export function toDomainEvent(tenant: string, wh: RestroFlowWebhook, receivedAt: Date = new Date()): Routed {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    tenant,
    deliveryId: wh.id,
    receivedAt: receivedAt.toISOString(),
  } as const;

  if (wh.event === 'product.updated') {
    const p = wh.data.product;
    const event: ProductEvent = {
      ...base,
      type: wh.event,
      eventId: eventIdFor(tenant, ['product', p.id, p.modified ?? wh.created_at, String(p.available ?? ''), p.price ?? '', p.deleted ? 'deleted' : '']),
      occurredAt: iso(p.modified) ?? wh.created_at,
      product: productPayload(p),
    };
    return { topic: TOPICS.catalog, key: partitionKey(tenant, 'product', p.id), event };
  }

  if (wh.event === 'store.updated') {
    const s = wh.data.store;
    const event: StoreEvent = {
      ...base,
      type: wh.event,
      eventId: eventIdFor(tenant, ['store', s.server_time ?? wh.created_at, s.paused ? 1 : 0, s.enabled ? 1 : 0]),
      occurredAt: iso(s.server_time) ?? wh.created_at,
      store: storePayload(s),
    };
    return { topic: TOPICS.store, key: partitionKey(tenant, 'store', 0), event };
  }

  const o = wh.data.order;
  const event: OrderEvent = {
    ...base,
    type: wh.event,
    // An order event is identified by order + event + status + last change – not by the delivery id.
    eventId: eventIdFor(tenant, ['order', o.id, wh.event, o.status, o.updated_at]),
    occurredAt: iso(o.updated_at) ?? wh.created_at,
    order: orderSnapshot(o),
  };
  return { topic: TOPICS.orders, key: partitionKey(tenant, 'order', o.id), event };
}

/** Field names that must never appear in a Kafka message (checked in tests and at runtime). */
export const FORBIDDEN_KEYS = ['customer', 'email', 'phone', 'address', 'note', 'reason', 'transaction_id', 'transactionId', 'refund_id', 'refundId'] as const;

export function findForbiddenKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findForbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...((FORBIDDEN_KEYS as readonly string[]).includes(k) ? [`${path}.${k}`] : []),
      ...findForbiddenKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}
