// Mirrors services/analytics responses (kept here so the dashboard has no server dependency).

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
  byHour: number[];
  byDay: Array<{ date: string; orders: number; revenue: number }>;
  kitchen: { avgAcceptSeconds: number | null; avgPrepSeconds: number | null };
  store: { paused: boolean; enabled: boolean; accepting: boolean | null; updatedAt: string } | null;
  eventsProcessed: number;
}

export type Range = 'today' | '7d' | '30d';
export type Connection = 'connecting' | 'live' | 'reconnecting';
