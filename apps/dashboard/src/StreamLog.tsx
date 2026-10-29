import type { StreamEntry } from './types';
import { clock, EVENT_LABEL, money } from './format';

export function StreamLog({ events, timeZone }: { events: StreamEntry[]; timeZone: string }) {
  return (
    <section className="stream" aria-labelledby="stream-title">
      <h2 id="stream-title">Kafka stream</h2>
      <p className="stream-intro">Each line is one event consumed from Kafka, newest first.</p>
      {events.length === 0 ? (
        <p className="stream-empty">Waiting for the first event.</p>
      ) : (
        <ol className="stream-list" aria-live="polite" aria-relevant="additions">
          {events.map((e) => (
            <li key={e.eventId} className={`ev ev-${e.type.replace('.', '-')}`}>
              <time dateTime={e.occurredAt}>{clock(e.occurredAt, timeZone)}</time>
              <span className="ev-topic">{e.topic.replace('restroflow.', '').replace('.v1', '')}</span>
              <span className="ev-text">
                {e.topic.endsWith('orders.v1') ? `#${e.label} ${EVENT_LABEL[e.type] ?? e.type}` : e.type === 'store.updated' ? `store ${e.status}` : `${e.label} ${e.status === 'sold_out' ? 'sold out' : 'available'}`}
                {e.type === 'order.created' && e.total !== null ? `, ${money(e.total)}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
