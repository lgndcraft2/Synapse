import { useEffect, useState } from 'react';
import { clearSiteUsage, getUsage, getUsageStats, type UsageStats } from '../lib/api';
import { Skeleton } from './ui';

const RANGES = [7, 30, 90];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const INK = '#1b1c1c';
const MUTED = '#5e5f5b';
const BAR = '#004635';
const TRACK = '#e4e2e1';

interface Allowance {
  unlimited: boolean;
  limit_type: string;
  used: number;
  limit: number | null;
}

interface Bar {
  key: string;
  label: string;
  value: number;
}

function hourLabel(hour: number) {
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 || 12} ${suffix}`;
}

function dayLabel(day: string) {
  // Parsed as local noon: a bare date would parse as UTC midnight and can read
  // as the day before.
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function plural(count: number, word: string) {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

function busiest(values: number[]) {
  const peak = Math.max(...values);
  return peak > 0 ? values.indexOf(peak) : -1;
}

function Tile({ label, value, detail, loading }: { label: string; value: number; detail: string; loading: boolean }) {
  return (
    <div className="p-4 rounded shadow-tactile flex flex-col justify-between gap-3"
      style={{ backgroundColor: '#fcf9f8', border: '1px solid #3d3d38' }}>
      <span className="text-xs font-semibold" style={{ color: MUTED, letterSpacing: '0.05em' }}>{label}</span>
      <div className="font-serif font-semibold" style={{ fontSize: 32, lineHeight: 1.2, color: BAR }}>
        {loading ? <Skeleton style={{ width: 62, height: 34 }} /> : value.toLocaleString()}
      </div>
      <span className="text-xs" style={{ color: MUTED }}>{loading ? ' ' : detail}</span>
    </div>
  );
}

/** One series of columns, with a tooltip on hover and a table for screen readers. */
function BarChart({ title, bars, axisStart, axisEnd }: { title: string; bars: Bar[]; axisStart: string; axisEnd: string }) {
  const [active, setActive] = useState<number | null>(null);
  const peak = Math.max(1, ...bars.map((bar) => bar.value));
  const hovered = active === null ? null : bars[active];

  return (
    <div>
      <div className="relative flex items-end" style={{ height: 120, gap: 2 }} aria-hidden="true"
        onMouseLeave={() => setActive(null)}>
        {bars.map((bar, i) => (
          <div key={bar.key} className="flex-1 flex items-end h-full" style={{ minWidth: 0 }}
            onMouseEnter={() => setActive(i)}>
            <div style={{
              width: '100%',
              height: bar.value ? `${Math.max(4, (bar.value / peak) * 100)}%` : 2,
              backgroundColor: bar.value ? BAR : TRACK,
              opacity: active === null || active === i ? 1 : 0.55,
              borderRadius: bar.value ? '4px 4px 0 0' : 0,
            }} />
          </div>
        ))}
        {hovered && (
          <div className="absolute top-0 px-2 py-1 rounded text-xs pointer-events-none whitespace-nowrap"
            style={{
              // Stays inside the chart at both ends.
              left: `${((active ?? 0) + 0.5) / bars.length * 100}%`,
              transform: `translateX(${(active ?? 0) < bars.length / 2 ? '0' : '-100%'})`,
              backgroundColor: INK, color: '#ffffff',
            }}>
            {hovered.label}: {plural(hovered.value, 'action')}
          </div>
        )}
      </div>
      <div className="flex justify-between text-xs mt-2" style={{ color: MUTED }} aria-hidden="true">
        <span>{axisStart}</span>
        <span>{axisEnd}</span>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.key}><th scope="row">{bar.label}</th><td>{bar.value}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function allowanceText(allowance: Allowance) {
  const period = allowance.limit_type === 'monthly' ? 'this month' : 'today';
  return `${allowance.used.toLocaleString()} of ${allowance.limit?.toLocaleString()} ${period}`;
}

/** What the reader actually did with Synapse: counts, peak times and top sites. */
export default function UsagePanel() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [failed, setFailed] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let current = true;
    setFailed(false);
    getUsageStats(days, -new Date().getTimezoneOffset())
      .then((next) => { if (current) setStats(next); })
      .catch((err) => {
        console.error('Usage stats failed', err);
        if (current) setFailed(true);
      });
    return () => { current = false; };
  }, [days]);

  useEffect(() => {
    getUsage().then(setAllowance).catch((err) => console.error('Allowance failed', err));
  }, []);

  async function handleClearSites() {
    if (!window.confirm('Forget which sites you have used Synapse on? Your other stats stay.')) return;
    setClearing(true);
    try {
      await clearSiteUsage();
      setStats((prev) => (prev ? { ...prev, top_sites: [] } : prev));
    } catch (err) {
      console.error('Clearing site usage failed', err);
      alert('Could not clear your site stats. Please try again.');
    } finally {
      setClearing(false);
    }
  }

  const loading = !stats && !failed;
  const totals = stats?.totals;
  const explains = (totals?.highlights ?? 0) + (totals?.circles ?? 0);
  const anyActivity = stats ? stats.hours.some(Boolean) : false;
  const peakHour = stats ? busiest(stats.hours) : -1;
  const peakDay = stats ? busiest(stats.weekdays) : -1;
  const siteTotal = (s: UsageStats['top_sites'][number]) => s.explains + s.responds + s.reformats;
  const topSite = stats?.top_sites.length ? Math.max(...stats.top_sites.map(siteTotal)) : 1;

  return (
    <section className="md:col-span-12">
      <div className="flex flex-wrap justify-between items-end gap-4 mb-6 pb-2" style={{ borderBottom: `1px solid ${TRACK}` }}>
        <div>
          <h2 className="font-serif font-semibold text-2xl" style={{ color: INK }}>Your Usage</h2>
          {allowance && !allowance.unlimited && (
            <p className="text-sm mt-1" style={{ color: MUTED }}>Plan allowance used: {allowanceText(allowance)}</p>
          )}
        </div>
        <div className="flex gap-1" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button key={range} onClick={() => setDays(range)} aria-pressed={days === range}
              className="px-3 py-1.5 rounded text-xs font-semibold transition-colors"
              style={days === range ? { backgroundColor: BAR, color: '#ffffff' } : { color: MUTED, backgroundColor: 'transparent' }}>
              {range} days
            </button>
          ))}
        </div>
      </div>

      {failed && !stats ? (
        <p className="text-sm" style={{ color: MUTED }}>Your usage couldn't be loaded. Refresh the page to try again.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
            <Tile label="Explains" value={explains} loading={loading}
              detail={`${totals?.highlights ?? 0} highlighted, ${totals?.circles ?? 0} circled`} />
            <Tile label="Responses" value={totals?.responds ?? 0} loading={loading} detail="Replies and answers drafted" />
            <Tile label="Page Reformats" value={totals?.reformats ?? 0} loading={loading} detail="Pages rebuilt for you" />
            <Tile label="Documents" value={(totals?.documents ?? 0) + (totals?.pdf_opens ?? 0)} loading={loading}
              detail={`${totals?.pdf_opens ?? 0} PDFs opened, ${totals?.documents ?? 0} reformatted`} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-10 mb-10">
            <div>
              <h3 className="font-semibold mb-1" style={{ color: INK }}>Activity by day</h3>
              <p className="text-sm mb-4" style={{ color: MUTED }}>
                {peakDay >= 0 ? `You use Synapse most on ${WEEKDAYS[peakDay]}s.` : 'Nothing in this period yet.'}
              </p>
              {stats ? (
                <BarChart title="Actions per day"
                  bars={stats.daily.map((d) => ({
                    key: d.day, label: dayLabel(d.day), value: d.explains + d.responds + d.reformats,
                  }))}
                  axisStart={dayLabel(stats.daily[0].day)}
                  axisEnd={dayLabel(stats.daily[stats.daily.length - 1].day)} />
              ) : <Skeleton style={{ width: '100%', height: 120 }} />}
            </div>
            <div>
              <h3 className="font-semibold mb-1" style={{ color: INK }}>Peak hours</h3>
              <p className="text-sm mb-4" style={{ color: MUTED }}>
                {peakHour >= 0 ? `You're busiest around ${hourLabel(peakHour)}.` : 'Nothing in this period yet.'}
              </p>
              {stats ? (
                <BarChart title="Actions per hour of the day"
                  bars={stats.hours.map((value, hour) => ({ key: String(hour), label: hourLabel(hour), value }))}
                  axisStart="12 AM" axisEnd="11 PM" />
              ) : <Skeleton style={{ width: '100%', height: 120 }} />}
            </div>
          </div>

          <div>
            <div className="flex justify-between items-baseline gap-4 mb-1">
              <h3 className="font-semibold" style={{ color: INK }}>Most used on</h3>
              {!!stats?.top_sites.length && (
                <button onClick={handleClearSites} disabled={clearing} className="text-sm font-semibold hover:underline"
                  style={{ color: BAR, opacity: clearing ? 0.5 : 1 }}>
                  {clearing ? 'Clearing…' : 'Clear'}
                </button>
              )}
            </div>
            <p className="text-sm mb-4" style={{ color: MUTED }}>
              All time. Email, messaging and banking sites are never counted.
            </p>
            {loading ? (
              <Skeleton style={{ width: '100%', height: 80 }} />
            ) : stats?.top_sites.length ? (
              <ul className="space-y-3">
                {stats.top_sites.map((site) => (
                  <li key={site.hostname}>
                    <div className="flex justify-between gap-4 text-sm mb-1">
                      <span className="truncate" style={{ color: INK }}>
                        {site.hostname === 'local-files' ? 'Local files' : site.hostname}
                      </span>
                      <span className="shrink-0" style={{ color: MUTED }}>
                        {site.explains} explains, {site.responds} responses, {site.reformats} reformats
                      </span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: TRACK }}>
                      <div className="h-full rounded-full"
                        style={{ width: `${(siteTotal(site) / topSite) * 100}%`, backgroundColor: BAR }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm" style={{ color: MUTED, fontStyle: 'italic' }}>
                {anyActivity ? 'Update the extension to start seeing your top sites.' : 'Your top sites will show up here.'}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
