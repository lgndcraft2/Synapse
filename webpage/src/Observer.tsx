import { Activity, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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

export default function Observer() {
  const [user, setUser] = useState(() => getSession()?.user ?? null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

            <section className="observer-note">
              <Users aria-hidden="true" />
              <p>This view intentionally reports aggregate operational data only; it does not expose reading content or individual account details.</p>
            </section>
          </>
        )}
      </main>
    </AppShell>
  );
}
