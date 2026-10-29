import { createKafka, type KafkaEnvConfig, type Producer } from '@restroflow-events/kafka';

export interface OutboundRecord {
  topic: string;
  key: string;
  value: unknown;
  headers?: Record<string, string>;
}

/** Abstraction over Kafka so the HTTP layer can be tested without a broker. */
export interface EventPublisher {
  publish(record: OutboundRecord): Promise<void>;
  isReady(): boolean;
  close(): Promise<void>;
}

/**
 * Idempotent Kafka producer: acks=all + enable.idempotence, so a broker retry
 * never writes the same message twice to a partition.
 */
export class KafkaPublisher implements EventPublisher {
  private producer: Producer;
  private ready = false;

  constructor(cfg: KafkaEnvConfig) {
    this.producer = createKafka(cfg).producer({
      kafkaJS: { idempotent: true, acks: -1, maxInFlightRequests: 5 },
      'linger.ms': 5,
      'compression.type': 'lz4',
    } as Parameters<ReturnType<typeof createKafka>['producer']>[0]);
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    this.ready = true;
  }

  async publish(r: OutboundRecord): Promise<void> {
    await this.producer.send({
      topic: r.topic,
      messages: [{ key: r.key, value: JSON.stringify(r.value), headers: r.headers ?? {} }],
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  async close(): Promise<void> {
    this.ready = false;
    await this.producer.disconnect();
  }
}

/** In-memory publisher for tests and dry runs. */
export class MemoryPublisher implements EventPublisher {
  records: OutboundRecord[] = [];
  failNext = 0;
  async publish(r: OutboundRecord): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker unavailable');
    }
    this.records.push(r);
  }
  isReady(): boolean {
    return true;
  }
  async close(): Promise<void> {}
}
