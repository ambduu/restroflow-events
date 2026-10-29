/**
 * Small LRU of recently published eventIds.
 * RestroFlow retries webhooks (after 1, 5, 30, 120, 360 min) when it doesn't get a 2xx in time,
 * so the same fact can arrive several times. This cheap first filter avoids most duplicates;
 * consumers are still idempotent on eventId (the real guarantee).
 */
export class RecentIds {
  private map = new Map<string, number>();
  constructor(private readonly max = 10_000) {}

  has(id: string): boolean {
    return this.map.has(id);
  }

  add(id: string): void {
    this.map.delete(id);
    this.map.set(id, Date.now());
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
