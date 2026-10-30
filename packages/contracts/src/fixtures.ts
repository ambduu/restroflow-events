/**
 * Realistic RestroFlow webhook payloads with FAKE personal data.
 * Used by tests and by scripts/simulate.ts.
 */

const DISHES = [
  { product: 101, sku: 'BUT-CHK', name: 'Butter Chicken', unit: 15.9 },
  { product: 102, sku: 'PAL-PAN', name: 'Palak Paneer', unit: 13.5 },
  { product: 103, sku: 'LAM-BIR', name: 'Lamm Biryani', unit: 17.9 },
  { product: 104, sku: 'GAR-NAN', name: 'Garlic Naan', unit: 3.9 },
  { product: 105, sku: 'MAN-LAS', name: 'Mango Lassi', unit: 4.5 },
  { product: 106, sku: 'SAM-VEG', name: 'Gemüse-Samosa (2 Stk.)', unit: 5.5 },
  { product: 107, sku: 'CHK-TIK', name: 'Chicken Tikka Masala', unit: 15.5 },
  { product: 108, sku: 'DAL-MAK', name: 'Dal Makhani', unit: 12.9 },
] as const;

export interface FakeOrderInput {
  id: number;
  status?: string;
  event?: 'order.created' | 'order.accepted' | 'order.ready' | 'order.completed' | 'order.declined' | 'order.updated';
  placedAt?: number; // unix seconds
  lines?: Array<{ dish: number; qty: number }>;
  source?: string;
  type?: 'pickup' | 'delivery';
  paymentMethod?: string;
  deliveryId?: string;
  acceptedAt?: number;
  readyAt?: number;
  updatedAt?: number;
}

export function fakeOrderWebhook(input: FakeOrderInput) {
  const placed = input.placedAt ?? Math.floor(Date.now() / 1000);
  const lines = (input.lines ?? [{ dish: 0, qty: 1 }, { dish: 3, qty: 2 }]).map(({ dish, qty }) => {
    const d = DISHES[dish % DISHES.length]!;
    return { product: d.product, pos_id: '', sku: d.sku, name: d.name, kitchen_name: d.name, options: [], note: 'extra scharf bitte', qty, unit: d.unit, sum: Math.round(d.unit * qty * 100) / 100, tax_rate: 7 };
  });
  const subtotal = Math.round(lines.reduce((s, l) => s + l.sum, 0) * 100) / 100;
  const event = input.event ?? 'order.created';
  const status = input.status ?? ({ 'order.created': 'new', 'order.accepted': 'accepted', 'order.ready': 'ready', 'order.completed': 'completed', 'order.declined': 'declined', 'order.updated': 'accepted' } as const)[event];
  return {
    id: input.deliveryId ?? 'dlv_' + Math.random().toString(36).slice(2, 14),
    event,
    created_at: new Date((input.updatedAt ?? placed) * 1000).toISOString(),
    site: 'https://spice-route.example',
    data: {
      order: {
        id: input.id,
        number: String(1000 + (input.id % 9000)),
        status,
        status_text: status,
        type: input.type ?? 'pickup',
        time_mode: 'asap',
        fulfill_at: placed + 25 * 60,
        ready_at: input.readyAt ?? 0,
        customer: { name: 'Max Mustermann', email: 'max@example.com', phone: '+49 271 000000' },
        address: input.type === 'delivery' ? { street: 'Musterstraße 1', postcode: '57072', city: 'Siegen' } : null,
        delivery_zone: '',
        note: 'Bitte klingeln',
        currency: 'EUR',
        subtotal,
        delivery_fee: 0,
        tip: 0,
        total: subtotal,
        tax_total: Math.round((subtotal - subtotal / 1.07) * 100) / 100,
        taxes: [],
        prices_include_tax: true,
        payment: { method: input.paymentMethod ?? 'stripe', method_title: 'Karte', status: 'paid', transaction_id: 'pi_FAKE123', paid_at: placed, refund_id: '' },
        source: input.source ?? 'web',
        reason: event === 'order.declined' ? 'Küche überlastet' : '',
        created_at: placed - 60,
        placed_at: placed,
        accepted_at: input.acceptedAt ?? 0,
        updated_at: input.updatedAt ?? placed,
        pos_reference: '',
        items: lines,
        acknowledged: false,
      },
    },
  };
}

export function fakeProductWebhook(id: number, available: boolean, modified = Math.floor(Date.now() / 1000)) {
  const d = DISHES.find((x) => x.product === id) ?? DISHES[0];
  return {
    id: 'dlv_' + Math.random().toString(36).slice(2, 14),
    event: 'product.updated' as const,
    created_at: new Date(modified * 1000).toISOString(),
    site: 'https://spice-route.example',
    data: { product: { id, sku: d.sku, name: d.name, price: d.unit, available, modified, category_ids: [3] } },
  };
}

export function fakeStoreWebhook(paused: boolean, at = Math.floor(Date.now() / 1000)) {
  return {
    id: 'dlv_' + Math.random().toString(36).slice(2, 14),
    event: 'store.updated' as const,
    created_at: new Date(at * 1000).toISOString(),
    site: 'https://spice-route.example',
    data: { store: { restaurant: 'Spice Route Kitchen', enabled: true, paused, accepting: !paused, auto_accept: false, prep: 25, server_time: at } },
  };
}

export const FAKE_DISHES = DISHES;
