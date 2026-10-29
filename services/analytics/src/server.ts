import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { kafkaConfigFromEnv } from '@restroflow-events/kafka';
import { Projection } from './projection.js';
import { startConsumer, type ConsumerStats } from './consumer.js';
import { buildHttp } from './http.js';

/**
 * Replay: delete the database file and start with a new ANALYTICS_GROUP_ID –
 * the consumer reads every topic from the beginning and rebuilds all statistics.
 */
async function main() {
  const dbPath = process.env.ANALYTICS_DB ?? './data/analytics.sqlite';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const projection = new Projection(dbPath);

  let stats: ConsumerStats | null = null;
  const app = buildHttp(projection, () => stats, {
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    corsOrigin: process.env.CORS_ORIGIN,
  });
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8081) });

  const started = await startConsumer(kafkaConfigFromEnv('restroflow-analytics'), projection, {
    groupId: process.env.ANALYTICS_GROUP_ID ?? 'restroflow-analytics',
    log: (m, x) => app.log.warn(x ?? {}, m),
    onApplied: (e) => app.log.info({ type: e.type, tenant: e.tenant, eventId: e.eventId }, 'event applied'),
  });
  stats = started.stats;

  const shutdown = async () => {
    await started.consumer.disconnect();
    await app.close();
    projection.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
