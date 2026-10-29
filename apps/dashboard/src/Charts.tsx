import type { Stats } from './types';
import { money, SOURCE_LABEL } from './format';

/** Orders per hour of the day (restaurant time). Opening hours 11–23 are emphasised. */
export function HourBars({ byHour, currentHour }: { byHour: number[]; currentHour: number | null }) {
  const max = Math.max(1, ...byHour);
  const W = 480, H = 140, pad = 18, bw = (W - pad) / 24;
  return (
    <figure className="chart">
      <figcaption>Orders by hour</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label={`Orders by hour: ${byHour.map((n, h) => (n ? `${h}:00 ${n}` : '')).filter(Boolean).join(', ') || 'no orders'}`}>
        <line x1={pad} x2={W} y1={H} y2={H} className="axis" />
        {byHour.map((n, h) => {
          const bh = (n / max) * (H - 16);
          return (
            <g key={h}>
              <rect
                x={pad + h * bw + 2}
                y={H - bh}
                width={bw - 4}
                height={Math.max(bh, n ? 2 : 0)}
                rx="2"
                className={h === currentHour ? 'bar bar-now' : 'bar'}
              >
                <title>{`${String(h).padStart(2, '0')}:00 – ${n} ${n === 1 ? 'order' : 'orders'}`}</title>
              </rect>
              {h % 3 === 0 && (
                <text x={pad + h * bw + bw / 2} y={H + 16} className="tick" textAnchor="middle">
                  {h}
                </text>
              )}
            </g>
          );
        })}
        <text x={0} y={12} className="tick">{max}</text>
      </svg>
    </figure>
  );
}

export function TopDishes({ dishes, currency }: { dishes: Stats['topDishes']; currency: string }) {
  const top = dishes.slice(0, 6);
  const max = Math.max(1, ...top.map((d) => d.qty));
  return (
    <figure className="chart">
      <figcaption>Best sellers</figcaption>
      {top.length === 0 ? (
        <p className="chart-empty">No dishes sold in this period.</p>
      ) : (
        <ol className="dishes">
          {top.map((d) => (
            <li key={d.name}>
              <span className="dish-name">{d.name}</span>
              <span className="dish-bar" style={{ ['--w' as string]: `${(d.qty / max) * 100}%` }} aria-hidden="true" />
              <span className="dish-num">
                {d.qty} <small>{money(d.revenue, currency)}</small>
              </span>
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}

const CHANNEL_ORDER = ['web', 'ios', 'android', 'app', 'phone', 'kiosk'];

export function Channels({ bySource }: { bySource: Record<string, number> }) {
  const entries = Object.entries(bySource).sort(([a], [b]) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b));
  const total = entries.reduce((s, [, n]) => s + n, 0);
  return (
    <figure className="chart">
      <figcaption>Where orders come from</figcaption>
      {total === 0 ? (
        <p className="chart-empty">No orders in this period.</p>
      ) : (
        <>
          <div className="channel-bar" role="img" aria-label={entries.map(([k, n]) => `${SOURCE_LABEL[k] ?? k} ${Math.round((n / total) * 100)}%`).join(', ')}>
            {entries.map(([k, n]) => (
              <span key={k} className={`seg seg-${k}`} style={{ flexGrow: n }} />
            ))}
          </div>
          <ul className="legend">
            {entries.map(([k, n]) => (
              <li key={k}>
                <i className={`swatch seg-${k}`} aria-hidden="true" />
                {SOURCE_LABEL[k] ?? k} <b>{Math.round((n / total) * 100)}%</b>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}

export function RevenueByDay({ byDay, currency }: { byDay: Stats['byDay']; currency: string }) {
  if (byDay.length < 2) {
    return (
      <figure className="chart">
        <figcaption>Revenue by day</figcaption>
        <p className="chart-empty">Needs at least two days of orders. Switch to “7 days” or “30 days”.</p>
      </figure>
    );
  }
  const W = 480, H = 130, pad = 6;
  const max = Math.max(1, ...byDay.map((d) => d.revenue));
  const x = (i: number) => pad + (i / (byDay.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - (v / max) * (H - 14);
  const line = byDay.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.revenue).toFixed(1)}`).join(' ');
  const last = byDay[byDay.length - 1]!;
  return (
    <figure className="chart">
      <figcaption>Revenue by day</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 20}`} role="img" aria-label={byDay.map((d) => `${d.date}: ${money(d.revenue, currency)}`).join(', ')}>
        <path d={`${line} L${x(byDay.length - 1)},${H} L${x(0)},${H} Z`} className="area" />
        <path d={line} className="line" />
        <circle cx={x(byDay.length - 1)} cy={y(last.revenue)} r="4" className="dot" />
        <text x={pad} y={H + 16} className="tick">{byDay[0]!.date.slice(5)}</text>
        <text x={W - pad} y={H + 16} className="tick" textAnchor="end">{last.date.slice(5)}</text>
      </svg>
    </figure>
  );
}
