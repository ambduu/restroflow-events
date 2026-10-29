import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardOrder, Connection, Range, Stats, StreamEntry } from './types';

const API = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${path})`);
  return (await res.json()) as T;
}

/**
 * Initial load over HTTP, then live updates over server-sent events.
 * Every Kafka event is appended to the stream log immediately; board and
 * statistics are re-fetched (debounced) so they always match the read model.
 */
export function useLive(tenant: string, range: Range) {
  const [board, setBoard] = useState<BoardOrder[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<StreamEntry[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const timer = useRef<number | undefined>(undefined);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const refresh = useCallback(async () => {
    try {
      const enc = encodeURIComponent(tenant);
      const [b, s] = await Promise.all([
        getJson<{ orders: BoardOrder[] }>(`/v1/board/${enc}`),
        getJson<Stats>(`/v1/stats/${enc}?range=${rangeRef.current}`),
      ]);
      setBoard(b.orders);
      setStats(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tenant]);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(refresh, 350);
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh, range]);

  useEffect(() => {
    let cancelled = false;
    getJson<{ events: StreamEntry[] }>(`/v1/events/${encodeURIComponent(tenant)}?limit=40`)
      .then((r) => !cancelled && setEvents(r.events))
      .catch(() => {});

    const es = new EventSource(`${API}/v1/stream/${encodeURIComponent(tenant)}`);
    es.addEventListener('hello', () => {
      setConnection('live');
      scheduleRefresh(); // catch up on anything missed while disconnected
    });
    es.addEventListener('kafka', (msg) => {
      const entry = JSON.parse((msg as MessageEvent<string>).data) as StreamEntry;
      setEvents((prev) => [entry, ...prev.filter((e) => e.eventId !== entry.eventId)].slice(0, 40));
      if (entry.topic.endsWith('orders.v1') && entry.entityId) {
        const key = `${entry.entityId}:${entry.status}`;
        setFresh((prev) => new Set(prev).add(key));
        window.setTimeout(() => setFresh((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        }), 2400);
      }
      scheduleRefresh();
    });
    es.onerror = () => setConnection(es.readyState === EventSource.CLOSED ? 'reconnecting' : 'reconnecting');
    return () => {
      cancelled = true;
      es.close();
      window.clearTimeout(timer.current);
    };
  }, [tenant, scheduleRefresh]);

  // Stats are time-based ("last 7 days"), so refresh them now and then even when it's quiet.
  useEffect(() => {
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return { board, stats, events, connection, error, fresh };
}

/** Re-render every `ms` so ticket ages tick. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}
