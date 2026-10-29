import type { BoardOrder } from './types';
import { age, money, SOURCE_LABEL } from './format';

const LANES = [
  { status: 'new', title: 'New', hint: 'Waiting to be accepted' },
  { status: 'accepted', title: 'In the kitchen', hint: 'Accepted, being cooked' },
  { status: 'ready', title: 'Ready', hint: 'Waiting for the guest' },
  { status: 'completed', title: 'Picked up', hint: 'Last 45 minutes' },
] as const;

/** Minutes after which a ticket counts as late in its lane. */
const LATE_AFTER: Record<string, number> = { new: 5, accepted: 35, ready: 15 };

function since(o: BoardOrder): string | null {
  if (o.status === 'new') return o.placedAt;
  if (o.status === 'accepted') return o.acceptedAt ?? o.placedAt;
  if (o.status === 'ready') return o.readyAt ?? o.acceptedAt;
  return o.completedAt;
}

function Ticket({ o, now, fresh }: { o: BoardOrder; now: number; fresh: boolean }) {
  const start = since(o);
  const mins = start ? (now - Date.parse(start)) / 60_000 : 0;
  const late = LATE_AFTER[o.status] !== undefined && mins > LATE_AFTER[o.status]!;
  return (
    <li className={`ticket${late ? ' is-late' : ''}${fresh ? ' is-fresh' : ''}`} aria-label={`Order ${o.number}, ${o.itemCount} items, ${money(o.total)}${late ? ', late' : ''}`}>
      <div className="ticket-head">
        <span className="ticket-no">#{o.number}</span>
        <span className="ticket-age" title={late ? 'Taking longer than usual' : undefined}>{age(start, now)}</span>
      </div>
      <p className="ticket-meta">
        {o.type === 'delivery' ? 'Delivery' : 'Pickup'}, {SOURCE_LABEL[o.source] ?? o.source}
      </p>
      <ul className="ticket-items">
        {o.items.slice(0, 6).map((i, k) => (
          <li key={k}>
            <span className="qty">{i.qty}×</span> {i.name}
          </li>
        ))}
        {o.items.length > 6 && <li className="more">+ {o.items.length - 6} more</li>}
      </ul>
      <div className="ticket-total">{money(o.total)}</div>
    </li>
  );
}

export function Pass({ orders, now, fresh }: { orders: BoardOrder[]; now: number; fresh: Set<string> }) {
  const total = orders.filter((o) => o.status !== 'completed').length;
  return (
    <section className="pass" aria-labelledby="pass-title">
      <div className="pass-title">
        <h2 id="pass-title">The pass</h2>
        <p>{total === 0 ? 'No open orders right now.' : `${total} open ${total === 1 ? 'order' : 'orders'}`}</p>
      </div>
      <div className="lanes">
        {LANES.map((lane) => {
          const list = orders.filter((o) => o.status === lane.status);
          const shown = lane.status === 'completed' ? list.slice(-8).reverse() : list;
          return (
            <div className={`lane lane-${lane.status}`} key={lane.status}>
              <div className="rail" aria-hidden="true" />
              <h3>
                {lane.title} <span className="count">{list.length}</span>
              </h3>
              <p className="lane-hint">{lane.hint}</p>
              {shown.length === 0 ? (
                <p className="lane-empty">{lane.status === 'new' ? 'New tickets appear here the moment an order is placed.' : 'Nothing here.'}</p>
              ) : (
                <ol className="tickets">
                  {shown.map((o) => (
                    <Ticket key={`${o.id}`} o={o} now={now} fresh={fresh.has(`${o.id}:${o.status}`)} />
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
