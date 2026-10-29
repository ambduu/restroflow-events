import { useMemo, useState } from 'react';
import { useLive, useNow } from './useLive';
import { Pass } from './Pass';
import { Channels, HourBars, RevenueByDay, TopDishes } from './Charts';
import { StreamLog } from './StreamLog';
import { minutes, money } from './format';
import type { Range } from './types';

const RANGES: Array<{ id: Range; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

const params = new URLSearchParams(location.search);
const TENANT = params.get('tenant') ?? 'namaste-india-siegen';
const NAME = params.get('name') ?? 'Namaste India, Siegen';

const CONNECTION_TEXT = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' } as const;

export function App() {
  const [range, setRange] = useState<Range>('today');
  const { board, stats, events, connection, error, fresh } = useLive(TENANT, range);
  const now = useNow();
  const tz = stats?.timezone ?? 'Europe/Berlin';
  const currentHour = useMemo(() => (range === 'today' ? Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now)) : null), [range, tz, now]);
  const cur = stats?.revenue.currency ?? 'EUR';
  const store = stats?.store;

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <h1>{NAME}</h1>
          <p>Kitchen pass, streamed from RestroFlow through Kafka</p>
        </div>
        <div className="top-right">
          {store && (
            <span className={`store-state ${store.paused ? 'is-paused' : 'is-open'}`}>{store.paused ? 'Online ordering paused' : 'Taking orders'}</span>
          )}
          <span className={`conn conn-${connection}`} role="status">
            <i aria-hidden="true" />
            {CONNECTION_TEXT[connection]}
          </span>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          Can't reach the analytics service: {error}. The page retries automatically.
        </p>
      )}

      <Pass orders={board} now={now} fresh={fresh} />

      <div className="below">
        <main className="numbers-and-charts">
          <div className="range-row">
            <h2>Sales</h2>
            <div className="range" role="radiogroup" aria-label="Period">
              {RANGES.map((r) => (
                <button key={r.id} role="radio" aria-checked={range === r.id} onClick={() => setRange(r.id)}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <dl className="numbers">
            <div>
              <dt>Revenue</dt>
              <dd>{stats ? money(stats.revenue.total, cur) : '–'}</dd>
            </div>
            <div>
              <dt>Orders</dt>
              <dd>
                {stats?.orders.total ?? '–'}
                {stats && stats.orders.declined > 0 && <small> incl. {stats.orders.declined} declined</small>}
              </dd>
            </div>
            <div>
              <dt>Average order</dt>
              <dd>{stats ? money(stats.revenue.averageOrderValue, cur) : '–'}</dd>
            </div>
            <div>
              <dt>Time to accept</dt>
              <dd>{minutes(stats?.kitchen.avgAcceptSeconds ?? null)}</dd>
            </div>
            <div>
              <dt>Cooking time</dt>
              <dd>{minutes(stats?.kitchen.avgPrepSeconds ?? null)}</dd>
            </div>
          </dl>

          {stats && (
            <div className="charts">
              <HourBars byHour={stats.byHour} currentHour={currentHour} />
              <TopDishes dishes={stats.topDishes} currency={cur} />
              <Channels bySource={stats.bySource} />
              <RevenueByDay byDay={stats.byDay} currency={cur} />
            </div>
          )}
        </main>

        <StreamLog events={events} timeZone={tz} />
      </div>

      <footer className="foot">
        <p>
          How it works: RestroFlow sends a signed webhook for every order change. The ingest service removes
          customer details and publishes the event to Kafka. The analytics consumer updates its read model and pushes the
          change to this page over server-sent events. {stats ? `${stats.eventsProcessed} events processed.` : ''}
        </p>
        <p>
          <a href="https://github.com/ambduu/restroflow-events">Source code on GitHub</a>
        </p>
      </footer>
    </div>
  );
}
