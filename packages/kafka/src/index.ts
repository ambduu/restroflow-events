import { readFileSync } from 'node:fs';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { ALL_TOPICS } from '@restroflow-events/contracts';

export type Kafka = KafkaJS.Kafka;
export type Producer = KafkaJS.Producer;
export type Consumer = KafkaJS.Consumer;

export interface KafkaEnvConfig {
  brokers: string[];
  clientId: string;
  /** SASL/SCRAM over TLS (e.g. Aiven with SASL enabled). */
  sasl?: { mechanism: 'scram-sha-256' | 'scram-sha-512' | 'plain'; username: string; password: string };
  /** TLS; with cert+key this is mutual TLS (Aiven's default "client certificate" auth). */
  ssl?: { ca?: string; cert?: string; key?: string };
}

/** PEM from an env var (literal or base64) or from a file path in <NAME>_FILE. */
function pem(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const inline = env[name];
  if (inline) return inline.includes('-----BEGIN') ? inline.replace(/\\n/g, '\n') : Buffer.from(inline, 'base64').toString('utf8');
  const file = env[`${name}_FILE`];
  return file ? readFileSync(file, 'utf8') : undefined;
}

/**
 * Read connection settings from the environment:
 *   KAFKA_BROKERS=host:port[,host:port]          (default localhost:9092, plaintext)
 *   Aiven, client certificate (default):  KAFKA_SSL=true  KAFKA_CA_PEM  KAFKA_CERT_PEM  KAFKA_KEY_PEM
 *   Aiven, SASL:  KAFKA_SASL_MECHANISM=scram-sha-256  KAFKA_USERNAME  KAFKA_PASSWORD  KAFKA_CA_PEM
 *   Every *_PEM can also be base64, or a file via *_PEM_FILE.
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
  const ca = pem(env, 'KAFKA_CA_PEM') ?? (env.KAFKA_CA_FILE ? readFileSync(env.KAFKA_CA_FILE, 'utf8') : undefined);
  const cert = pem(env, 'KAFKA_CERT_PEM');
  const key = pem(env, 'KAFKA_KEY_PEM');
  if (env.KAFKA_SSL === 'true' || cfg.sasl || ca || cert) {
    cfg.ssl = {};
    if (ca) cfg.ssl.ca = ca;
    if (cert) cfg.ssl.cert = cert;
    if (key) cfg.ssl.key = key;
  }
  return cfg;
}

/** librdkafka properties for TLS / SASL (passed next to the KafkaJS-style block). */
export function securityProperties(cfg: KafkaEnvConfig): Record<string, string> {
  const props: Record<string, string> = {};
  if (cfg.sasl) {
    props['security.protocol'] = 'sasl_ssl';
    props['sasl.mechanisms'] = cfg.sasl.mechanism.toUpperCase();
    props['sasl.username'] = cfg.sasl.username;
    props['sasl.password'] = cfg.sasl.password;
  } else if (cfg.ssl) {
    props['security.protocol'] = 'ssl';
  }
  if (cfg.ssl?.ca) props['ssl.ca.pem'] = cfg.ssl.ca;
  if (cfg.ssl?.cert) props['ssl.certificate.pem'] = cfg.ssl.cert;
  if (cfg.ssl?.key) props['ssl.key.pem'] = cfg.ssl.key;
  return props;
}

export function createKafka(cfg: KafkaEnvConfig): Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: { clientId: cfg.clientId, brokers: cfg.brokers, logLevel: KafkaJS.logLevel.WARN },
    ...securityProperties(cfg),
  } as unknown as ConstructorParameters<typeof KafkaJS.Kafka>[0]);
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
