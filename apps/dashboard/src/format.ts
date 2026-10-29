export const money = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);

export const minutes = (seconds: number | null) => {
  if (seconds === null) return '–';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
};

export function age(fromIso: string | null, now: number): string {
  if (!fromIso) return '';
  const mins = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));

export const SOURCE_LABEL: Record<string, string> = { web: 'Website', app: 'App', ios: 'iPhone app', android: 'Android app', kiosk: 'Kiosk', phone: 'Phone' };

export const EVENT_LABEL: Record<string, string> = {
  'order.created': 'order received',
  'order.accepted': 'accepted',
  'order.ready': 'ready for pickup',
  'order.completed': 'picked up',
  'order.declined': 'declined',
  'order.updated': 'updated',
  'product.updated': 'dish changed',
  'store.updated': 'store',
};
