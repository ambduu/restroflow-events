import { TOPICS, type DomainEvent } from '@restroflow-events/contracts';
import { createKafka, type Consumer, type KafkaEnvConfig } from '@restroflow-events/kafka';
import type { Projection } from './projection.js';

export interface ConsumerStats {
  applied: number;
  duplicates: number;
  invalid: number;
  lastEventAt: string | null;
}

/**
 * Consumer group "restroflow-analytics": several instances share the
 * partitions; each event is applied once thanks to the idempotent projection.
 */
export async function startConsumer(
  cfg: KafkaEnvConfig,
  projection: Projection,
  opts: { groupId?: string; fromBeginning?: boolean; onApplied?: (e: DomainEvent) => void; log?: (msg: string, extra?: unknown) => void } = {},
): Promise<{ consumer: Consumer; stats: ConsumerStats }> {
  const log = opts.log ?? ((m, x) => console.log(m, x ?? ''));
  const stats: ConsumerStats = { applied: 0, duplicates: 0, invalid: 0, lastEventAt: null };
  const consumer = createKafka(cfg).consumer({
    kafkaJS: { groupId: opts.groupId ?? 'restroflow-analytics', fromBeginning: opts.fromBeginning ?? true },
  } as Parameters<ReturnType<typeof createKafka>['consumer']>[0]);

  await consumer.connect();
  await consumer.subscribe({ topics: [TOPICS.orders, TOPICS.catalog, TOPICS.store] });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let event: DomainEvent;
      try {
        event = JSON.parse(message.value?.toString('utf8') ?? '') as DomainEvent;
        if (!event?.eventId || !event.type || !event.tenant) throw new Error('missing eventId/type/tenant');
      } catch (err) {
        // Poison message: log and skip (the ingest service already dead-letters malformed webhooks).
        stats.invalid++;
        log('skipping invalid message', { topic, partition, offset: message.offset, err: String(err) });
        return;
      }
      if (projection.apply(event)) {
        stats.applied++;
        stats.lastEventAt = event.occurredAt;
        opts.onApplied?.(event);
      } else {
        stats.duplicates++;
      }
    },
  });
  return { consumer, stats };
}
