import { readFileSync } from 'node:fs';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { ALL_TOPICS } from '@restroflow-events/contracts';

export type Kafka = KafkaJS.Kafka;
export type Producer = KafkaJS.Producer;
export type Consumer = KafkaJS.Consumer;

export interface KafkaEnvConfig {
  brokers: string[];
  clientId: string;
  /** SASL/SCRAM over TLS – e.g. Aiven ("SCRAM-SHA-256"). Omit for local plaintext Kafka. */
  sasl?: { mechanism: 'scram-sha-256' | 'scram-sha-512' | 'plain'; username: string; password: string };
  ssl?: { ca?: string };
}

/**
 * Read connection settings from the environment:
 *   KAFKA_BROKERS=host:port[,host:port]   (default localhost:9092)
 *   KAFKA_SASL_MECHANISM=scram-sha-256    KAFKA_USERNAME=…  KAFKA_PASSWORD=…
 *   KAFKA_SSL=true                        KAFKA_CA_FILE=/path/ca.pem  or  KAFKA_CA_PEM="-----BEGIN…"
 */
export function kafkaConfigFromEnv(clientId: string, env: NodeJS.ProcessEnv = process.env): KafkaEnvConfig {
  const cfg: KafkaEnvConfig = {
    brokers: (env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((b) => b.trim()).filter(Boolean),
    clientId: env.KAFKA_CLIENT_ID ?? clientId,
  };
  if (env.KAFKA_SASL_MECHANISM) {
    cfg.sasl = {
      mechanism: env.KAFKA_SASL_MECHANISM.toLowerCase() as 'scram-sha-256',
      username: env.KAFKA_USERNAME ?? '',
      password: env.KAFKA_PASSWORD ?? '',
    };
  }
  if (env.KAFKA_SSL === 'true' || cfg.sasl) {
    const ca = env.KAFKA_CA_PEM ?? (env.KAFKA_CA_FILE ? readFileSync(env.KAFKA_CA_FILE, 'utf8') : undefined);
    cfg.ssl = ca ? { ca } : {};
  }
  return cfg;
}

export function createKafka(cfg: KafkaEnvConfig): Kafka {
  const kafkaJS: Record<string, unknown> = {
    clientId: cfg.clientId,
    brokers: cfg.brokers,
    logLevel: KafkaJS.logLevel.WARN,
  };
  if (cfg.ssl) kafkaJS.ssl = cfg.ssl.ca ? { ca: [cfg.ssl.ca] } : true;
  if (cfg.sasl) kafkaJS.sasl = cfg.sasl;
  return new KafkaJS.Kafka({ kafkaJS } as unknown as ConstructorParameters<typeof KafkaJS.Kafka>[0]);
}

/**
 * Create the platform topics if they don't exist yet (idempotent).
 * Partitions: 2 fits the Aiven free tier (max 2 per topic); raise for real load.
 */
export async function ensureTopics(kafka: Kafka, opts: { partitions?: number; replicationFactor?: number } = {}): Promise<string[]> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = ALL_TOPICS.filter((t) => !existing.has(t));
    if (missing.length) {
      await admin.createTopics({
        topics: missing.map((topic) => ({
          topic,
          numPartitions: opts.partitions ?? 2,
          replicationFactor: opts.replicationFactor ?? -1, // broker default
        })),
      });
    }
    return missing;
  } finally {
    await admin.disconnect();
  }
}
