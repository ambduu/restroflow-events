import { z } from 'zod';

/**
 * Incoming RestroFlow webhook (format "restroflow").
 * Mirrors plugins/restroflow/includes/webhooks.php → rf_webhook_payload().
 * Parsed leniently: unknown fields are ignored, missing optional fields default.
 */

export const WEBHOOK_EVENTS = [
  'order.created',
  'order.accepted',
  'order.ready',
  'order.completed',
  'order.declined',
  'order.updated',
  'product.updated',
  'store.updated',
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

const num = z.coerce.number().catch(0);
const str = z.coerce.string().catch('');

export const OrderLineSchema = z.object({
  product: z.coerce.number().int(),
  sku: str.default(''),
  name: str.default(''),
  kitchen_name: str.optional(),
  options: z.array(z.unknown()).catch([]).default([]),
  note: str.optional(), // free text → removed by the privacy filter
  qty: z.coerce.number().int().positive(),
  unit: num,
  sum: num,
  tax_rate: num.optional(),
});

export const OrderSchema = z.object({
  id: z.coerce.number().int().positive(),
  number: str.default(''),
  status: z.string(),
  type: z.enum(['pickup', 'delivery']).catch('pickup'),
  time_mode: str.default('asap'),
  source: str.default('web'),
  currency: str.default('EUR'),
  subtotal: num.default(0),
  delivery_fee: num.default(0),
  tip: num.default(0),
  total: num.default(0),
  tax_total: num.default(0),
  delivery_zone: str.default(''),
  payment: z
    .object({
      method: str.default(''),
      status: str.default('unpaid'),
      transaction_id: str.optional(),
      refund_id: str.optional(),
      paid_at: num.optional(),
    })
    .prefault({}),
  // Personal data – present in the webhook, never forwarded
  customer: z.object({ name: str, email: str, phone: str }).partial().optional(),
  address: z.unknown().optional(),
  note: str.optional(),
  reason: str.optional(),
  // Unix timestamps (seconds, 0 = not set)
  created_at: num.default(0),
  placed_at: num.default(0),
  accepted_at: num.default(0),
  ready_at: num.default(0),
  fulfill_at: num.default(0),
  updated_at: num.default(0),
  items: z.array(OrderLineSchema).default([]),
});
export type RestroFlowOrder = z.infer<typeof OrderSchema>;

export const ProductSchema = z.object({
  id: z.coerce.number().int().positive(),
  deleted: z.boolean().optional(),
  sku: str.optional(),
  name: str.optional(),
  price: num.optional(),
  available: z.boolean().optional(),
  category_ids: z.array(z.coerce.number()).optional(),
  modified: num.optional(),
});
export type RestroFlowProduct = z.infer<typeof ProductSchema>;

export const StoreSchema = z.object({
  restaurant: str.optional(),
  enabled: z.boolean().default(true),
  paused: z.boolean().default(false),
  accepting: z.boolean().optional(),
  prep: num.optional(),
  server_time: num.optional(),
});
export type RestroFlowStore = z.infer<typeof StoreSchema>;

const envelope = {
  id: z.string().min(1), // delivery id – changes on every retry!
  created_at: z.string(),
  site: z.url().optional(),
};

const orderEvent = <E extends string>(event: E) => z.object({ ...envelope, event: z.literal(event), data: z.object({ order: OrderSchema }) });

export const WebhookSchema = z.discriminatedUnion('event', [
  orderEvent('order.created'),
  orderEvent('order.accepted'),
  orderEvent('order.ready'),
  orderEvent('order.completed'),
  orderEvent('order.declined'),
  orderEvent('order.updated'),
  z.object({ ...envelope, event: z.literal('product.updated'), data: z.object({ product: ProductSchema }) }),
  z.object({ ...envelope, event: z.literal('store.updated'), data: z.object({ store: StoreSchema }) }),
]);

export type RestroFlowWebhook =
  | { id: string; created_at: string; site?: string; event: Exclude<WebhookEventName, 'product.updated' | 'store.updated'>; data: { order: RestroFlowOrder } }
  | { id: string; created_at: string; site?: string; event: 'product.updated'; data: { product: RestroFlowProduct } }
  | { id: string; created_at: string; site?: string; event: 'store.updated'; data: { store: RestroFlowStore } };

export function parseWebhook(input: unknown):
  | { ok: true; webhook: RestroFlowWebhook }
  | { ok: false; error: string } {
  const r = WebhookSchema.safeParse(input);
  if (r.success) return { ok: true, webhook: r.data as RestroFlowWebhook };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 5).join('; ') };
}
