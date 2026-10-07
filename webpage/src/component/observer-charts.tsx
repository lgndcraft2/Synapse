import { useState } from 'react';

// Small hand-rolled SVG charts for the observer page. Colours come from the
// --viz-* tokens in styles.css; text always uses text tokens, never a series colour.

const format = (value: number) => new Intl.NumberFormat().format(value);

function shortDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Up to five evenly spaced axis labels for a day series. */
function axisDates(dates: string[]) {
  if (dates.length <= 1) return dates.map((date, index) => ({ date, index }));
  const steps = Math.min(4, dates.length - 1);
  return Array.from({ length: steps + 1 }, (_, step) => {
    const index = Math.round((step / steps) * (dates.length - 1));
    return { date: dates[index], index };
  });
}

/** A rounded "nice" ceiling so gridlines land on readable numbers. */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value / 4) ?? 10;
  return Math.ceil(value / (step * magnitude)) * step * magnitude;
}

export type Segment = { key: string; label: string; value: number; color: string };

/** One horizontal 100% bar: each segment's share of the whole. */
export function ShareBar({ segments, label }: { segments: Segment[]; label: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const share = (value: number) => (total ? (value / total) * 100 : 0);
  const shareLabel = (value: number) => (value > 0 && share(value) < 1 ? '<1%' : `${share(value).toFixed(0)}%`);
  const summary = segments.map((segment) => `${segment.label} ${format(segment.value)} (${share(segment.value).toFixed(0)}%)`).join(', ');

  return (
    <div className="viz-share">
      <div className="viz-share-bar" role="img" aria-label={`${label}: ${summary}.`}>
        {total ? segments.filter((segment) => segment.value > 0).map((segment) => (
          <i key={segment.key} style={{ flexGrow: segment.value, background: segment.color }} title={`${segment.label}: ${format(segment.value)} (${share(segment.value).toFixed(1)}%)`} />
        )) : <i className="viz-share-empty" />}
      </div>
      <ul className="viz-legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            <span className="viz-swatch" style={{ background: segment.color }} aria-hidden="true" />
            {segment.label}
            <strong>{format(segment.value)}</strong>
            <small>{shareLabel(segment.value)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Tooltip = { x: number; title: string; rows: { label: string; value: number; color: string }[] };

function ChartTooltip({ tooltip }: { tooltip: Tooltip | null }) {
  if (!tooltip) return null;
  // Flip to the left of the cursor in the right half so it never overflows.
  const style = tooltip.x > 50 ? { right: `${100 - tooltip.x}%` } : { left: `${tooltip.x}%` };
  return (
    <div className="viz-tooltip" style={style} role="status">
      <strong>{tooltip.title}</strong>
      {tooltip.rows.map((row) => (
        <span key={row.label}><i style={{ background: row.color }} aria-hidden="true" />{row.label}<b>{format(row.value)}</b></span>
      ))}
    </div>
  );
}

function YAxis({ max }: { max: number }) {
  return (
    <div className="viz-y-axis" aria-hidden="true">
      {[max, max / 2, 0].map((tick, index) => <span key={tick} style={{ top: `${index * 50}%` }}>{format(Math.round(tick))}</span>)}
    </div>
  );
}

function XAxis({ dates }: { dates: string[] }) {
  return (
    <div className="viz-x-axis" aria-hidden="true">
      {axisDates(dates).map(({ date, index }) => (
        <span key={date} style={{ left: `${dates.length > 1 ? (index / (dates.length - 1)) * 100 : 50}%` }}>{shortDate(date)}</span>
      ))}
    </div>
  );
}

const WIDTH = 600;
const HEIGHT = 200;

export type StackSeries = { key: string; label: string; color: string };

/** Daily stacked columns, e.g. free vs paid signups. */
export function StackedColumns({ dates, values, series, label }: {
  dates: string[];
  values: Record<string, number | string>[];
  series: StackSeries[];
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = values.map((day) => series.reduce((sum, item) => sum + (Number(day[item.key]) || 0), 0));
  const max = niceMax(Math.max(...totals, 0));
  const slot = WIDTH / Math.max(dates.length, 1);
  // Thin columns with at least a 2px gap; very long ranges just get thinner.
  const barWidth = Math.max(1, Math.min(slot - 2, 28));
  const total = totals.reduce((sum, value) => sum + value, 0);
  const tooltip: Tooltip | null = hover === null ? null : {
    x: ((hover + 0.5) / dates.length) * 100,
    title: `${shortDate(dates[hover])} · ${format(totals[hover])}`,
    rows: series.map((item) => ({ label: item.label, value: Number(values[hover][item.key]) || 0, color: item.color })),
  };

  return (
    <div className="viz-chart">
      <YAxis max={max} />
      <div className="viz-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${format(total)} in total over ${dates.length} days.`}>
          <path className="viz-grid" d={`M0 0H${WIDTH}M0 ${HEIGHT / 2}H${WIDTH}M0 ${HEIGHT}H${WIDTH}`} />
          {values.map((day, index) => {
            let top = HEIGHT;
            const x = index * slot + (slot - barWidth) / 2;
            return (
              <g key={dates[index]} className={hover === null || hover === index ? '' : 'viz-dim'}>
                {series.map((item) => {
                  const height = ((Number(day[item.key]) || 0) / max) * HEIGHT;
                  if (!height) return null;
                  top -= height;
                  // 2px surface gap between stacked segments.
                  return <rect key={item.key} x={x} y={top + 1} width={barWidth} height={Math.max(height - 1, 1)} fill={item.color} />;
                })}
                <rect className="viz-hit" x={index * slot} y={0} width={slot} height={HEIGHT} onMouseEnter={() => setHover(index)} />
              </g>
            );
          })}
        </svg>
        <ChartTooltip tooltip={tooltip} />
        <XAxis dates={dates} />
      </div>
    </div>
  );
}

export type LineSeries = { key: string; label: string; color: string; values: number[] };

/** One line per series on a shared axis, with a crosshair tooltip. */
export function MultiLineChart({ dates, series, label }: { dates: string[]; series: LineSeries[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...series.flatMap((item) => item.values), 0));
  const x = (index: number) => (dates.length > 1 ? (index / (dates.length - 1)) * WIDTH : WIDTH / 2);
  const y = (value: number) => HEIGHT - (value / max) * HEIGHT;
  const slot = WIDTH / Math.max(dates.length, 1);
  const summary = series.map((item) => `${item.label} ${format(item.values.reduce((sum, value) => sum + value, 0))}`).join(', ');
  const tooltip: Tooltip | null = hover === null ? null : {
    x: dates.length > 1 ? (hover / (dates.length - 1)) * 100 : 50,
    title: shortDate(dates[hover]),
    rows: series.map((item) => ({ label: item.label, value: item.values[hover] || 0, color: item.color })),
  };

  return (
    <div className="viz-chart">
      <YAxis max={max} />
      <div className="viz-plot" onMouseLeave={() => setHover(null)}>
        <div className="viz-canvas">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${label}. Totals: ${summary || 'no series selected'}.`}>
          <path className="viz-grid" d={`M0 0H${WIDTH}M0 ${HEIGHT / 2}H${WIDTH}M0 ${HEIGHT}H${WIDTH}`} />
          {hover !== null && <path className="viz-crosshair" d={`M${x(hover)} 0V${HEIGHT}`} />}
          {series.map((item) => (
            <polyline key={item.key} className="viz-line" stroke={item.color} points={item.values.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(' ')} />
          ))}
          {dates.map((date, index) => (
            <rect key={date} className="viz-hit" x={x(index) - slot / 2} y={0} width={slot} height={HEIGHT} onMouseEnter={() => setHover(index)} />
          ))}
        </svg>
        {/* Markers live outside the stretched SVG so they stay round. */}
        {hover !== null && series.map((item) => (
          <span key={item.key} className="viz-marker" style={{ left: `${(x(hover) / WIDTH) * 100}%`, top: `${(y(item.values[hover] || 0) / HEIGHT) * 100}%`, borderColor: item.color }} aria-hidden="true" />
        ))}
        </div>
        <ChartTooltip tooltip={tooltip} />
        <XAxis dates={dates} />
      </div>
    </div>
  );
}

/** A tiny trend line for a stat tile. Decorative: the tile states the number. */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const px = values.length > 1 ? (index / (values.length - 1)) * 100 : 50;
    return `${px.toFixed(2)},${(28 - (value / max) * 26).toFixed(2)}`;
  }).join(' ');
  return (
    <svg className="viz-sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} stroke={color} />
    </svg>
  );
}
