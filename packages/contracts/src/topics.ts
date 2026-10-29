/**
 * Kafka topics. One topic per entity, keyed so that all events of the same
 * order land on the same partition (= processed in order).
 */
export const TOPICS = {
  orders: 'restroflow.orders.v1',
  catalog: 'restroflow.catalog.v1',
  store: 'restroflow.store.v1',
  /** Webhooks that were authentic but could not be understood (bad JSON, unknown schema). */
  deadLetter: 'restroflow.dlq.v1',
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

export const ALL_TOPICS: TopicName[] = Object.values(TOPICS);

/** Partition key: tenant + entity id → per-order ordering, spread across partitions. */
export function partitionKey(tenant: string, entity: string, id: number | string): string {
  return `${tenant}:${entity}:${id}`;
}
