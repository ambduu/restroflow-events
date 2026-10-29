import { ensureTopics, createKafka, kafkaConfigFromEnv } from '@restroflow-events/kafka';
import { buildApp } from './app.js';
import { KafkaPublisher } from './publisher.js';

/**
 * TENANTS: JSON map tenant-slug → webhook secret, e.g.
 *   TENANTS='{"namaste-india-siegen":"<secret from RestroFlow › Webhooks>"}'
 */
function loadTenants(): Record<string, string> {
  const raw = process.env.TENANTS ?? '';
  if (!raw) throw new Error('TENANTS is not set (JSON: {"tenant-slug":"webhook-secret"})');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [slug, secret] of Object.entries(parsed)) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) throw new Error(`Invalid tenant slug: ${slug}`);
    if (typeof secret !== 'string' || secret.length < 16) throw new Error(`Secret for ${slug} must be at least 16 characters`);
    out[slug] = secret;
  }
  return out;
}

async function main() {
  const kafkaCfg = kafkaConfigFromEnv('restroflow-ingest');
  if (process.env.CREATE_TOPICS !== 'false') {
    const created = await ensureTopics(createKafka(kafkaCfg), { partitions: Number(process.env.TOPIC_PARTITIONS ?? 2) });
    if (created.length) console.log('created topics', created);
  }

  const publisher = new KafkaPublisher(kafkaCfg);
  await publisher.connect();

  const app = buildApp({
    tenants: loadTenants(),
    publisher,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers["x-restroflow-signature"]', 'req.headers.authorization'],
    },
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await publisher.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
