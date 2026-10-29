/**
 * Sends realistic, signed RestroFlow webhooks to the ingest service –
 * a whole evening of orders with accept/ready/complete steps, a declined order,
 * a webhook retry and a sold-out dish. Personal data in the payloads is fake.
 *
 *   npm run simulate -- --orders 25 --url http://localhost:8080 --tenant namaste-india-siegen --secret <secret>
 */
import { fakeOrderWebhook, fakeProductWebhook, fakeStoreWebhook, sign } from '@restroflow-events/contracts';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<Array<[string, string]>>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), []),
);
const url = (args.url ?? process.env.INGEST_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const tenant = args.tenant ?? 'namaste-india-siegen';
const secret = args.secret ?? process.env.WEBHOOK_SECRET ?? 'local-dev-secret-change-me';
const count = Number(args.orders ?? 20);

const rand = (n: number) => Math.floor(Math.random() * n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(payload: unknown, label: string) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${url}/v1/webhooks/restroflow/${tenant}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-restroflow-signature': sign(body, secret) },
    body,
  });
  const out = (await res.json().catch(() => ({}))) as { status?: string };
  console.log(`${res.status} ${(out.status ?? '').padEnd(13)} ${label}`);
}

async function main() {
  console.log(`→ ${url} as ${tenant}, ${count} orders`);
  const evening = Math.floor(Date.now() / 1000) - 4 * 3600;
  await send(fakeStoreWebhook(false, evening), 'store opened');

  for (let i = 0; i < count; i++) {
    const id = 50_000 + rand(900_000);
    const placed = evening + i * rand(600) + rand(300);
    const lines = Array.from({ length: 1 + rand(3) }, () => ({ dish: rand(8), qty: 1 + rand(2) }));
    const source = ['web', 'web', 'ios', 'android'][rand(4)];
    const base = { id, placedAt: placed, lines, source };

    const created = fakeOrderWebhook(base);
    await send(created, `order ${id} created`);
    if (i === 2) await send({ ...created, id: 'dlv_retry' }, `order ${id} created (retry → duplicate)`);

    if (i === 4) {
      await send(fakeOrderWebhook({ ...base, event: 'order.declined', updatedAt: placed + 60 }), `order ${id} declined`);
      continue;
    }
    const acc = placed + 30 + rand(240);
    const ready = acc + 900 + rand(900);
    await send(fakeOrderWebhook({ ...base, event: 'order.accepted', acceptedAt: acc, updatedAt: acc }), `order ${id} accepted`);
    await send(fakeOrderWebhook({ ...base, event: 'order.ready', acceptedAt: acc, readyAt: ready, updatedAt: ready }), `order ${id} ready`);
    if (i < count - 2) {
      await send(fakeOrderWebhook({ ...base, event: 'order.completed', acceptedAt: acc, readyAt: ready, updatedAt: ready + 300 + rand(600) }), `order ${id} completed`);
    }
    if (i === Math.floor(count / 2)) await send(fakeProductWebhook(105, false, placed), 'Mango Lassi sold out');
    await sleep(50);
  }
  await send({ id: 'dlv_broken', event: 'order.created', created_at: 'x', data: {} }, 'broken payload (→ dead-letter queue)');
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
