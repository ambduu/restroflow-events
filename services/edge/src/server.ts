import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { createKafka, ensureTopics, kafkaConfigFromEnv } from '@restroflow-events/kafka';
import { loadTenants } from '@restroflow-events/ingest/app';
import { KafkaPublisher } from '@restroflow-events/ingest/publisher';
import { Projection } from '@restroflow-events/analytics/projection';
import { startConsumer, type ConsumerStats } from '@restroflow-events/analytics/consumer';
import { LiveHub } from '@restroflow-events/analytics/live';
import { buildEdge } from './app.js';
import { DemoRestaurant } from './demo.js';

/**
 * Single-process deployment for free hosts (Render free: 512 MB, no persistent disk,
 * sleeps after 15 min idle).
 *
 * No disk → the SQLite read model is rebuilt from Kafka on every start: with
 * REPLAY_ON_START=true (default) each boot joins a fresh consumer group and reads
 * all topics from the beginning. Kafka is the source of truth; the database is
 * just a cache of it. Webhooks that arrive while the service sleeps fail once and
 * are re-sent by RestroFlow's retry – event IDs are deterministic, so nothing is
 * counted twice.
 */
async function main() {
  // DEMO_TENANT (e.g. "demo"): built-in demo restaurant with simulated orders for the public dashboard.
  // Its webhook secret is random per boot and never leaves the process.
  const demoTenant = (process.env.DEMO_TENANT ?? '').trim();
  const demoSecret = randomBytes(24).toString('hex');
  const tenants = loadTenants(process.env.TENANTS ?? (demoTenant ? '{}' : ''));
  if (demoTenant) tenants[demoTenant] = demoSecret;
  const replay = process.env.REPLAY_ON_START !== 'false';
  const baseGroup = process.env.ANALYTICS_GROUP_ID ?? 'restroflow-analytics';
  const groupId = replay ? `${baseGroup}-boot-${Date.now().toString(36)}` : baseGroup;

  const dbPath = process.env.ANALYTICS_DB ?? (replay ? ':memory:' : './data/analytics.sqlite');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const projection = new Projection(dbPath);

  const producerCfg = kafkaConfigFromEnv('restroflow-ingest');
  if (process.env.CREATE_TOPICS === 'true') {
    try {
      await ensureTopics(createKafka(producerCfg), { partitions: Number(process.env.TOPIC_PARTITIONS ?? 2) });
    } catch (err) {
      console.warn('could not create topics automatically – make sure they exist:', String(err));
    }
  }
  const publisher = new KafkaPublisher(producerCfg);

  let stats: ConsumerStats | null = null;
  const hub = new LiveHub();
  const app = buildEdge({
    ingest: { tenants, publisher },
    projection,
    consumerStats: () => stats,
    analytics: {
      hub,
      corsOrigin: process.env.CORS_ORIGIN,
      dashboardDir: process.env.DASHBOARD_DIR ?? new URL('../../../apps/dashboard/dist', import.meta.url).pathname,
    },
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers["x-restroflow-signature"]', 'req.headers.authorization'],
    },
  });

  // Listen first so the platform health check passes while Kafka connects.
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 10000) });
  await publisher.connect();
  const started = await startConsumer(kafkaConfigFromEnv('restroflow-analytics'), projection, {
    groupId,
    fromBeginning: true,
    log: (m, x) => app.log.warn(x ?? {}, m),
    onApplied: (e) => {
      hub.publish(e);
      app.log.info({ type: e.type, tenant: e.tenant, eventId: e.eventId }, 'event applied');
    },
  });
  stats = started.stats;
  app.log.info({ groupId, replay }, 'consumer started');

  let demo: DemoRestaurant | null = null;
  if (demoTenant) {
    demo = new DemoRestaurant({
      app,
      tenant: demoTenant,
      secret: demoSecret,
      projection,
      timeZone: process.env.DEMO_TIMEZONE ?? 'Europe/Berlin',
      log: (m, x) => app.log.info(x ?? {}, m),
    });
    // give the consumer time to replay what is already in Kafka, so nothing is sent twice
    demo.start(Number(process.env.DEMO_START_DELAY_MS ?? 45_000));
    app.log.info({ tenant: demoTenant }, 'demo restaurant started');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    demo?.stop();
    await started.consumer.disconnect().catch(() => {});
    await app.close();
    await publisher.close().catch(() => {});
    projection.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
