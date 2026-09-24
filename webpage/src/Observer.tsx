import { Activity, Clock3, Gauge, ListTree, RefreshCw, Server, ShieldCheck, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from './component/AppShell';
import { getObserverOverview } from './lib/api';
import { getSession, requireAuth, subscribeAuth } from './lib/auth';

type Overview = {
  generated_at: string;
  metrics: {
    total_users: number;
    new_users_24h: number;
    active_users_30d: number;
    total_sessions: number;
    sessions_24h: number;
    active_subscriptions: number;
    open_tickets: number;
  };
  traffic: { date: string; sessions: number }[];
  runtime: {
    scope: string;
    process_started_at: string;
    uptime_seconds: number;
    traffic: {
      requests_1m: number;
      requests_5m: number;
      requests_per_second_1m: number;
      requests_per_minute_1m: number;
      status_counts_5m: Record<'2xx' | '3xx' | '4xx' | '5xx', number>;
    };
    latency: { avg_ms_5m: number; p50_ms_5m: number; p95_ms_5m: number; max_ms_5m: number };
    endpoints: { method: string; path: string; requests: number; avg_ms: number; p95_ms: number; server_errors: number }[];
    recent_requests: { at: string; method: string; path: string; status: number; duration_ms: number }[];
    timeline: { at: string; requests: number; avg_ms: number; p95_ms: number; server_errors: number }[];
  };
};

const metricCards: { key: keyof Overview['metrics']; label: string; detail: string }[] = [
  { key: 'total_users', label: 'Total users', detail: 'All registered accounts' },
  { key: 'new_users_24h', label: 'New users', detail: 'Registered in the last 24 hours' },
  { key: 'active_users_30d', label: 'Active readers', detail: 'Reading activity in the last 30 days' },
  { key: 'sessions_24h', label: 'Traffic today', detail: 'Reading sessions in the last 24 hours' },
  { key: 'total_sessions', label: 'All sessions', detail: 'Lifetime reading sessions' },
  { key: 'active_subscriptions', label: 'Paid access', detail: 'Active or trial subscriptions' },
  { key: 'open_tickets', label: 'Open support', detail: 'Tickets awaiting a reply' },
];

function number(value: number) {
  return new Intl.NumberFormat().format(value);
}

function duration(ms: number) {
  return `${ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

function uptime(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

type TrendMetric = 'p95_ms' | 'avg_ms' | 'requests' | 'server_errors';

const trendOptions: Record<TrendMetric, { label: string; unit: string }> = {
  p95_ms: { label: 'P95 latency', unit: 'ms' },
  avg_ms: { label: 'Average latency', unit: 'ms' },
  requests: { label: 'Throughput', unit: 'requests / 30s' },
  server_errors: { label: 'Server errors', unit: '5xx / 30s' },
};

function TrendChart({ timeline, metric }: { timeline: Overview['runtime']['timeline']; metric: TrendMetric }) {
  const values = timeline.map((point) => point[metric]);
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = values.length > 1 ? (index / (values.length - 1)) * 600 : 300;
    const y = 156 - (value / max) * 132;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const latest = values[values.length - 1] || 0;
  const option = trendOptions[metric];

  return (
    <div className="observer-trend" role="img" aria-label={`${option.label}: latest value ${latest} ${option.unit}; maximum shown is ${max} ${option.unit}.`}>
      <div className="observer-trend-value"><strong>{metric.includes('ms') ? duration(latest) : number(latest)}</strong><span>{option.unit}</span></div>
      <svg viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true">
        <path className="observer-trend-grid" d="M0 24H600M0 90H600M0 156H600" />
        <polygon className="observer-trend-area" points={`0,156 ${points} 600,156`} />
        <polyline className="observer-trend-line" points={points} />
        {values.map((value, index) => {
          const x = values.length > 1 ? (index / (values.length - 1)) * 600 : 300;
          const y = 156 - (value / max) * 132;
          return <circle cx={x} cy={y} r="3.5" key={`${timeline[index].at}:${value}`}><title>{`${new Date(timeline[index].at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${value} ${option.unit}`}</title></circle>;
        })}
      </svg>
      <div className="observer-trend-axis"><span>{timeline[0] ? new Date(timeline[0].at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</span><span>now</span></div>
    </div>
  );
}

export default function Observer() {
  const [user, setUser] = useState(() => getSession()?.user ?? null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('p95_ms');
  const [logQuery, setLogQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const load = useCallback(async () => {
    setError(null);
    try {
      setOverview(await getObserverOverview());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load observer data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    requireAuth('/observer');
    void load();
    const refresh = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(refresh);
  }, [load]);

  useEffect(() => subscribeAuth((session) => setUser(session?.user ?? null)), []);

  const maxSessions = Math.max(...(overview?.traffic.map((point) => point.sessions) ?? [1]), 1);
  const runtime = overview?.runtime;
  const totalStatus = runtime ? Object.values(runtime.traffic.status_counts_5m).reduce((total, value) => total + value, 0) : 0;
  const filteredRequests = useMemo(() => (runtime?.recent_requests || []).filter((request) => {
    const matchesRoute = request.path.toLowerCase().includes(logQuery.trim().toLowerCase());
    const matchesMethod = methodFilter === 'all' || request.method === methodFilter;
    const matchesStatus = statusFilter === 'all' || String(Math.floor(request.status / 100)) === statusFilter;
    return matchesRoute && matchesMethod && matchesStatus;
  }), [runtime?.recent_requests, logQuery, methodFilter, statusFilter]);
  const availableMethods = useMemo(() => Array.from(new Set((runtime?.recent_requests || []).map((request) => request.method))).sort(), [runtime?.recent_requests]);
  const technicalCards = runtime ? [
    { label: 'Throughput', value: `${runtime.traffic.requests_per_minute_1m}/min`, detail: `${runtime.traffic.requests_per_second_1m}/sec over the last minute`, icon: Gauge },
    { label: 'P95 latency', value: duration(runtime.latency.p95_ms_5m), detail: `P50 ${duration(runtime.latency.p50_ms_5m)} · 5-minute window`, icon: Clock3 },
    { label: 'Server errors', value: number(runtime.traffic.status_counts_5m['5xx']), detail: '5xx responses over five minutes', icon: Server },
    { label: 'Requests', value: number(runtime.traffic.requests_1m), detail: `${number(runtime.traffic.requests_5m)} requests over five minutes`, icon: Activity },
  ] : [];

  return (
    <AppShell user={user} authChecked backTo={{ href: '/dashboard', label: 'Dashboard' }}>
      <main className="observer-page">
        <section className="observer-heading" aria-labelledby="observer-title">
          <div>
            <span className="observer-eyebrow"><ShieldCheck aria-hidden="true" /> Internal operations</span>
            <h1 id="observer-title">Observer panel</h1>
            <p>Aggregate account and reading traffic. Refreshes every 30 seconds.</p>
          </div>
          <button className="button button-secondary observer-refresh" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'observer-spin' : ''} aria-hidden="true" />
            Refresh
          </button>
        </section>

        {error ? (
          <section className="observer-error" role="alert">
            <h2>Observer unavailable</h2>
            <p>{error}</p>
          </section>
        ) : (
          <>
            <section className="observer-metrics" aria-label="Operations metrics" aria-busy={loading}>
              {metricCards.map((card) => (
                <article className="observer-card" key={card.key}>
                  <span>{card.label}</span>
                  <strong>{overview ? number(overview.metrics[card.key]) : '—'}</strong>
                  <p>{card.detail}</p>
                </article>
              ))}
            </section>

            <section className="observer-traffic" aria-labelledby="traffic-title">
              <div className="observer-section-head">
                <div>
                  <span className="observer-eyebrow"><Activity aria-hidden="true" /> App traffic</span>
                  <h2 id="traffic-title">Reading sessions, last seven days</h2>
                </div>
                <span className="observer-updated">{overview ? `Updated ${new Date(overview.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Loading…'}</span>
              </div>
              <div className="observer-chart" role="img" aria-label="Reading sessions per day for the last seven days">
                {(overview?.traffic ?? Array.from({ length: 7 }, () => ({ date: '', sessions: 0 }))).map((point, index) => (
                  <div className="observer-bar-group" key={point.date || index}>
                    <span className="observer-bar-value">{overview ? number(point.sessions) : ''}</span>
                    <div className="observer-bar-track"><i style={{ height: `${overview ? (point.sessions / maxSessions) * 100 : 0}%` }} /></div>
                    <span className="observer-bar-label">{point.date ? new Date(`${point.date}T00:00:00`).toLocaleDateString([], { weekday: 'short' }) : '—'}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="observer-runtime" aria-labelledby="runtime-title">
              <div className="observer-section-head">
                <div>
                  <span className="observer-eyebrow"><Server aria-hidden="true" /> Runtime telemetry</span>
                  <h2 id="runtime-title">Latency, throughput and errors</h2>
                </div>
                <span className="observer-updated">{runtime ? `${runtime.scope} · up ${uptime(runtime.uptime_seconds)}` : 'Loading…'}</span>
              </div>

              <div className="observer-tech-grid" aria-busy={!runtime}>
                {(technicalCards.length ? technicalCards : Array.from({ length: 4 }, () => null)).map((card, index) => {
                  const Icon = card?.icon;
                  return (
                    <article className="observer-tech-card" key={card?.label || index}>
                      {Icon && <Icon aria-hidden="true" />}
                      <span>{card?.label || 'Loading'}</span>
                      <strong>{card?.value || '—'}</strong>
                      <p>{card?.detail || 'Collecting runtime data…'}</p>
                    </article>
                  );
                })}
              </div>

              <div className="observer-status-row" aria-label="Response status distribution over five minutes">
                {(['2xx', '3xx', '4xx', '5xx'] as const).map((group) => {
                  const count = runtime?.traffic.status_counts_5m[group] || 0;
                  const percentage = totalStatus ? (count / totalStatus) * 100 : 0;
                  return <div className={`observer-status observer-status-${group}`} key={group}>
                    <span>{group}</span><strong>{number(count)}</strong><i><b style={{ width: `${percentage}%` }} /></i>
                  </div>;
                })}
              </div>

              <div className="observer-trend-head">
                <div><h3>Live trend</h3><p>Rolling five-minute window, grouped into 30-second buckets.</p></div>
                <label className="observer-select-label">Metric
                  <select value={trendMetric} onChange={(event) => setTrendMetric(event.target.value as TrendMetric)}>
                    {Object.entries(trendOptions).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
              <TrendChart timeline={runtime?.timeline || []} metric={trendMetric} />
            </section>

            <section className="observer-table-card" aria-labelledby="endpoint-title">
              <div className="observer-section-head">
                <div>
                  <span className="observer-eyebrow"><ListTree aria-hidden="true" /> Endpoint activity</span>
                  <h2 id="endpoint-title">Busiest routes, last five minutes</h2>
                </div>
              </div>
              <div className="observer-table-scroll">
                <table>
                  <thead><tr><th>Route</th><th>Requests</th><th>Average</th><th>P95</th><th>5xx</th></tr></thead>
                  <tbody>
                    {runtime?.endpoints.length ? runtime.endpoints.map((endpoint) => (
                      <tr key={`${endpoint.method}:${endpoint.path}`}>
                        <td><code><b>{endpoint.method}</b> {endpoint.path}</code></td>
                        <td>{number(endpoint.requests)}</td><td>{duration(endpoint.avg_ms)}</td><td>{duration(endpoint.p95_ms)}</td><td>{number(endpoint.server_errors)}</td>
                      </tr>
                    )) : <tr><td colSpan={5} className="observer-empty">No application requests recorded in this process yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="observer-table-card" aria-labelledby="request-log-title">
              <div className="observer-section-head">
                <div>
                  <span className="observer-eyebrow"><Activity aria-hidden="true" /> Request log</span>
                  <h2 id="request-log-title">Latest 50 requests</h2>
                </div>
              </div>
              <div className="observer-log-filters" aria-label="Request log filters">
                <label>Route
                  <input value={logQuery} onChange={(event) => setLogQuery(event.target.value)} placeholder="Filter route" />
                </label>
                <label>Method
                  <select value={methodFilter} onChange={(event) => setMethodFilter(event.target.value)}><option value="all">All methods</option>{availableMethods.map((method) => <option key={method} value={method}>{method}</option>)}</select>
                </label>
                <label>Status
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="2">2xx success</option><option value="3">3xx redirect</option><option value="4">4xx client error</option><option value="5">5xx server error</option></select>
                </label>
                <button className="button button-secondary observer-clear-filters" type="button" onClick={() => { setLogQuery(''); setMethodFilter('all'); setStatusFilter('all'); }} disabled={!logQuery && methodFilter === 'all' && statusFilter === 'all'}>Clear filters</button>
              </div>
              <div className="observer-table-scroll">
                <table>
                  <thead><tr><th>Time</th><th>Route</th><th>Status</th><th>Duration</th></tr></thead>
                  <tbody>
                    {filteredRequests.length ? filteredRequests.map((request, index) => (
                      <tr key={`${request.at}:${index}`}>
                        <td>{new Date(request.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                        <td><code><b>{request.method}</b> {request.path}</code></td>
                        <td><span className={`observer-status-code observer-code-${Math.floor(request.status / 100)}`}>{request.status}</span></td>
                        <td>{duration(request.duration_ms)}</td>
                      </tr>
                    )) : <tr><td colSpan={4} className="observer-empty">{runtime?.recent_requests.length ? 'No requests match these filters.' : 'No application requests recorded in this process yet.'}</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="observer-note">
              <Users aria-hidden="true" />
              <p>This view intentionally reports aggregate operational data only; it does not expose reading content, request bodies, query strings, IP addresses, or individual account details.</p>
            </section>
          </>
        )}
      </main>
    </AppShell>
  );
}
