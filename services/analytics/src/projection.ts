import { DatabaseSync } from 'node:sqlite';
import type { DomainEvent, OrderEvent, ProductEvent, StoreEvent } from '@restroflow-events/contracts';

/**
 * Read model built from the event stream ("projection").
 *
 * Idempotent: every event is recorded in processed_events in the same
 * transaction as its effects, so redelivery (at-least-once consumers,
 * webhook retries, replays) never double-counts an order.
 */
export class Projection {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        tenant TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        tenant TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        number TEXT,
        status TEXT NOT NULL,
        type TEXT,
        source TEXT,
        payment_method TEXT,
        currency TEXT,
        total REAL NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0,
        placed_at TEXT,
        accepted_at TEXT,
        ready_at TEXT,
        completed_at TEXT,
        declined_at TEXT,
        last_event_at TEXT NOT NULL,
        PRIMARY KEY (tenant, order_id)
      );
      CREATE TABLE IF NOT EXISTS order_items (
        tenant TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        line INTEGER NOT NULL,
        product_id INTEGER,
        sku TEXT,
        name TEXT,
        qty INTEGER NOT NULL,
        line_total REAL NOT NULL,
        PRIMARY KEY (tenant, order_id, line)
      );
      CREATE TABLE IF NOT EXISTS products (
        tenant TEXT NOT NULL,
        product_id INTEGER NOT NULL,
        name TEXT,
        price REAL,
        available INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        PRIMARY KEY (tenant, product_id)
      );
      CREATE TABLE IF NOT EXISTS store_state (
        tenant TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        paused INTEGER NOT NULL,
        accepting INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orders_placed ON orders (tenant, placed_at);
    `);
  }

  /** Apply one event. Returns false if it was already processed (duplicate). */
  apply(event: DomainEvent): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const fresh = this.db
        .prepare('INSERT OR IGNORE INTO processed_events (event_id, type, tenant, processed_at) VALUES (?, ?, ?, ?)')
        .run(event.eventId, event.type, event.tenant, new Date().toISOString());
      if (Number(fresh.changes) === 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (event.type === 'product.updated') this.applyProduct(event);
      else if (event.type === 'store.updated') this.applyStore(event);
      else this.applyOrder(event);
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private applyOrder(e: OrderEvent): void {
    const o = e.order;
    const prev = this.db
      .prepare('SELECT last_event_at FROM orders WHERE tenant = ? AND order_id = ?')
      .get(e.tenant, o.id) as { last_event_at: string } | undefined;

    // Ignore stale snapshots (e.g. an old retry arriving after a newer status).
    if (prev && prev.last_event_at > e.occurredAt) return;

    const completedAt = e.type === 'order.completed' || o.status === 'completed' ? e.occurredAt : null;
    const declinedAt = e.type === 'order.declined' || o.status === 'declined' || o.status === 'cancelled' ? e.occurredAt : null;

    this.db
      .prepare(
        `INSERT INTO orders (tenant, order_id, number, status, type, source, payment_method, currency, total, item_count,
                             placed_at, accepted_at, ready_at, completed_at, declined_at, last_event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant, order_id) DO UPDATE SET
           status = excluded.status,
           total = excluded.total,
           item_count = excluded.item_count,
           placed_at = COALESCE(orders.placed_at, excluded.placed_at),
           accepted_at = COALESCE(excluded.accepted_at, orders.accepted_at),
           ready_at = COALESCE(excluded.ready_at, orders.ready_at),
           completed_at = COALESCE(orders.completed_at, excluded.completed_at),
           declined_at = COALESCE(orders.declined_at, excluded.declined_at),
           last_event_at = excluded.last_event_at`,
      )
      .run(
        e.tenant, o.id, o.number, o.status, o.type, o.source, o.paymentMethod, o.currency, o.total, o.itemCount,
        o.placedAt ?? o.createdAt ?? e.occurredAt, o.acceptedAt, o.readyAt, completedAt, declinedAt, e.occurredAt,
      );

    if (o.items.length) {
      this.db.prepare('DELETE FROM order_items WHERE tenant = ? AND order_id = ?').run(e.tenant, o.id);
      const ins = this.db.prepare('INSERT INTO order_items (tenant, order_id, line, product_id, sku, name, qty, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      o.items.forEach((l, i) => ins.run(e.tenant, o.id, i, l.productId, l.sku, l.name, l.qty, l.lineTotal));
    }
  }

  private applyProduct(e: ProductEvent): void {
    const p = e.product;
    this.db
      .prepare(
        `INSERT INTO products (tenant, product_id, name, price, available, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant, product_id) DO UPDATE SET
           name = COALESCE(excluded.name, products.name),
           price = COALESCE(excluded.price, products.price),
           available = COALESCE(excluded.available, products.available),
           deleted = excluded.deleted,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= COALESCE(products.updated_at, '')`,
      )
      .run(e.tenant, p.id, p.name ?? null, p.price ?? null, p.available === undefined ? null : p.available ? 1 : 0, p.deleted ? 1 : 0, e.occurredAt);
  }

  private applyStore(e: StoreEvent): void {
    const s = e.store;
    this.db
      .prepare(
        `INSERT INTO store_state (tenant, enabled, paused, accepting, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant) DO UPDATE SET enabled = excluded.enabled, paused = excluded.paused,
           accepting = excluded.accepting, updated_at = excluded.updated_at
         WHERE excluded.updated_at >= store_state.updated_at`,
      )
      .run(e.tenant, s.enabled ? 1 : 0, s.paused ? 1 : 0, s.accepting === null ? null : s.accepting ? 1 : 0, e.occurredAt);
  }

  close(): void {
    this.db.close();
  }
}
