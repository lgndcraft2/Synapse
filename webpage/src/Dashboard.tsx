import { useState, useEffect } from "react";
import { requireAuth, getSession, subscribeAuth } from "./lib/auth";
import { confirmCheckout, getBillingStatus, getDashboardStats, getProfile, getProfileHistory, getReadingSessions, updateProfile } from "./lib/api";
import { pushSessionToExtension, pushLogoutToExtension } from "./lib/extensionBridge";
import { PLAN_LABELS } from "./lib/plans";
import ConfigBanner from "./component/ConfigBanner";
import { Pager, Skeleton } from "./component/ui";
import { useOffsetPage } from "./lib/usePaging";
import { AppFooter, AppHeader } from "./component/AppShell";

type SessionDifficulty = "hard" | "normal" | "flowing";

interface Session {
  id: string;
  page_title: string;
  created_at: string;
  session_difficulty: SessionDifficulty;
}

interface FeedbackItem {
  label: string;
  pct: number;
  barColor: string;
}

interface BillingInfo {
  plan: string;
  status: string;
  renews_at?: string;
  trial_ends_at?: string;
}

interface ProfileInfo {
  profile_type: string;
}

interface HistoryEntry {
  changed_at: string;
  change_summary: string;
  previous_state: Record<string, unknown>;
  new_state: Record<string, unknown>;
}

// Order the "Switch Profile" button cycles through. Mirrors the backend's
// ProfileUpdate Literal for profile_type.
const PROFILE_TYPES = ["load-reducer", "comprehension-gap", "hyperfocus"];

function titleCase(value: string) {
  return value.replace("-", " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

interface StatsInfo {
  cards_this_week: number;
  cards_this_month: number;
  pages_visited: number;
  words_processed: number;
  time_saved_minutes: number;
  recent_sessions: Session[];
  feedback_breakdown: Record<string, number>;
}

const difficultyMap: Record<SessionDifficulty, { bg: string; color: string; icon: string; label: string }> = {
  flowing: { bg: "#e4e2e1", color: "#004635", icon: "water",   label: "Flowing" },
  normal:  { bg: "#e4e2e1", color: "#5e5f5b", icon: "remove",  label: "Normal" },
  hard:    { bg: "#ffdad6", color: "#ba1a1a", icon: "warning", label: "Hard" },
};

function DifficultyPill({ difficulty }: { difficulty: SessionDifficulty }) {
  const d = difficultyMap[difficulty] || difficultyMap["normal"];
  return (
    <div className="flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold shrink-0"
      style={{ backgroundColor: d.bg, color: d.color }}>
      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{d.icon}</span> {d.label}
    </div>
  );
}

function timeSince(dateString: string) {
  const date = new Date(dateString);
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
  let interval = seconds / 31536000;

  if (interval > 1) return Math.floor(interval) + " years ago";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + " months ago";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + " days ago";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + " hours ago";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + " minutes ago";
  return Math.floor(seconds) + " seconds ago";
}

const HISTORY_PER_PAGE = 4;
const SESSIONS_PER_PAGE = 5;

export default function Dashboard() {
  const [readingDay, setReadingDay] = useState<SessionDifficulty>(() => {
    if (typeof localStorage === "undefined") return "normal";
    const saved = localStorage.getItem("synapse_reading_day");
    return saved === "hard" || saved === "flowing" || saved === "normal" ? saved : "normal";
  });
  const [user, setUser] = useState<any>(null);
  // False until the session has been read — see AppHeaderProps.authChecked.
  const [checkedAuth, setCheckedAuth] = useState(false);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [stats, setStats] = useState<StatsInfo | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Both lists page against the server; the dashboard shows short pages since
  // it is a summary view, with the full log on /profile.
  const historyPage = useOffsetPage<HistoryEntry>(getProfileHistory, HISTORY_PER_PAGE);
  const sessionPage = useOffsetPage<Session>(getReadingSessions, SESSIONS_PER_PAGE);

  // Persist the "How are you reading today?" selection across visits.
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("synapse_reading_day", readingDay);
    }
  }, [readingDay]);

  useEffect(() => {
    async function loadData() {
      const user = await requireAuth();
      if (!user) return;
      setUser(user);
      setCheckedAuth(true);

      // Hand the current session to the extension so it stays signed in.
      pushSessionToExtension(getSession());

      // Returning from Stripe Checkout: confirm the session directly so the plan
      // reflects immediately, without waiting on the webhook. Then clean the URL.
      const checkoutSessionId = new URLSearchParams(window.location.search).get("session_id");
      if (checkoutSessionId) {
        try {
          await confirmCheckout(checkoutSessionId);
        } catch (err) {
          console.error("Checkout confirmation failed", err);
        }
        window.history.replaceState({}, "", "/dashboard");
      }

      // Load each panel independently so one failing endpoint doesn't blank the rest.
      const [status, profileData, statsData] = await Promise.allSettled([
        getBillingStatus(),
        getProfile(),
        getDashboardStats(),
      ]);

      if (status.status === "fulfilled") setBilling(status.value);
      if (profileData.status === "fulfilled") setProfile(profileData.value);
      if (statsData.status === "fulfilled") setStats(statsData.value);

      for (const r of [status, profileData, statsData]) {
        if (r.status === "rejected") console.error("Dashboard load error", r.reason);
      }

      setIsLoading(false);
    }
    loadData();
  }, []);

  // Keep the extension's session fresh, and tell it to sign out when we do.
  useEffect(() => {
    return subscribeAuth((session) => {
      if (session) pushSessionToExtension(session);
      else pushLogoutToExtension();
    });
  }, []);

  async function handleSwitchProfile() {
    if (!profile || isSwitching) return;
    const currentIndex = PROFILE_TYPES.indexOf(profile.profile_type);
    const nextType = PROFILE_TYPES[(currentIndex + 1) % PROFILE_TYPES.length];

    setIsSwitching(true);
    try {
      const updated = await updateProfile({ profile_type: nextType });
      setProfile(updated);
      // The backend logs a history entry for the change — the newest page now
      // holds it, so go back to the top of the log.
      historyPage.reset();
    } catch (err) {
      alert("Failed to switch profile. Please try again.");
    } finally {
      setIsSwitching(false);
    }
  }

  const feedbackItems: FeedbackItem[] = stats ? [
    { label: "Clearer",      pct: stats.feedback_breakdown["clearer"] || 0, barColor: "#004635" },
    { label: "Too Complex",  pct: stats.feedback_breakdown["complex"] || 0, barColor: "#707974" },
    { label: "Too Simple",   pct: stats.feedback_breakdown["simple"] || 0, barColor: "#707974" },
    { label: "Missed Point", pct: stats.feedback_breakdown["off-topic"] || 0, barColor: "#ba1a1a" },
  ] : [];

  // Calculate percentages
  const totalFeedback = feedbackItems.reduce((acc, item) => acc + item.pct, 0);
  const normalizedFeedback = feedbackItems.map(item => ({
    ...item,
    pct: totalFeedback > 0 ? Math.round((item.pct / totalFeedback) * 100) : 0
  }));

  const displayStats = [
    { label: "Cards Generated", value: stats?.cards_this_month.toString() || "0" },
    { label: "Pages Visited",   value: stats?.pages_visited.toString() || "0" },
    { label: "Words Processed", value: stats ? (stats.words_processed > 1000 ? (stats.words_processed / 1000).toFixed(1) + "k" : stats.words_processed.toString()) : "0" },
    { label: "Time Saved",      value: stats ? (stats.time_saved_minutes > 60 ? Math.floor(stats.time_saved_minutes / 60) + "h " + (stats.time_saved_minutes % 60) + "m" : stats.time_saved_minutes + "m") : "0m" },
  ];

  return (
    <>
      <ConfigBanner />
      <div className="dash font-body" style={{ backgroundColor: "#fcf9f8", color: "#1b1c1c", minHeight: "100vh", display: "flex", flexDirection: "column" }}>

        {/* ── HEADER ─────────────────────────────────────────────── */}
        <AppHeader user={user} authChecked={checkedAuth} />

        {/* ── MAIN ───────────────────────────────────────────────── */}
        <main className="flex-grow w-full mx-auto px-10 py-16 grid grid-cols-1 md:grid-cols-12 gap-10" style={{ maxWidth: 1140 }}>

          {/* LEFT COLUMN */}
          <div className="md:col-span-7 flex flex-col gap-10">

            {/* Session readiness widget */}
            <section>
              <div className="inline-flex items-center gap-4 p-2 rounded-xl shadow-tactile"
                style={{ backgroundColor: "#f6f3f2", border: "1px solid #3d3d38" }}>
                <span className="text-xs font-semibold uppercase tracking-wider ml-2" style={{ color: "#5e5f5b", letterSpacing: "0.05em" }}>
                  How are you reading today?
                </span>
                <div className="flex gap-1">
                  {(["hard", "normal", "flowing"] as SessionDifficulty[]).map((val) => (
                    <button
                      key={val}
                      onClick={() => setReadingDay(val)}
                      className="px-3 py-1.5 rounded text-xs font-semibold transition-colors"
                      style={readingDay === val
                        ? { backgroundColor: "#004635", color: "#ffffff" }
                        : { color: "#5e5f5b", backgroundColor: "transparent" }
                      }
                    >
                      {val === "hard" ? "Hard Day" : val === "normal" ? "Normal" : "Flowing"}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* Welcome */}
            <section>
              <h1 className="font-serif font-bold mb-4" style={{ fontSize: 48, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#1b1c1c" }}>
                Welcome back, {user?.user_metadata?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || 'Alex'}.
              </h1>
              <p className="text-lg" style={{ lineHeight: 1.6, color: "#5e5f5b", maxWidth: 600 }}>
                Here is your cognitive activity summary for this week. We've made a few adjustments to your profile to optimize reading flow.
              </p>
            </section>

            {/* Cognitive Profile Card */}
            <section className="rounded-xl p-8 shadow-tactile relative overflow-hidden"
              style={{ backgroundColor: "#f6f3f2", border: "1px solid #3d3d38" }}>
              <div className="absolute top-0 right-0 w-32 h-32 rounded-bl-full opacity-50"
                style={{ backgroundColor: "#e4e2e1", zIndex: 0 }} />
              <div className="relative flex justify-between items-start mb-6">
                <div>
                  <span className="block mb-2 text-xs font-semibold uppercase tracking-widest" style={{ color: "#5e5f5b", letterSpacing: "0.08em" }}>
                    Current Active Profile
                  </span>
                  <h2 className="font-serif font-semibold" style={{ fontSize: 32, lineHeight: 1.2, color: "#004635" }}>
                    {isLoading && !profile ? (
                      <Skeleton style={{ width: 220, height: 38 }} />
                    ) : (
                      profile?.profile_type ? titleCase(profile.profile_type) : "Load Reducer"
                    )}
                  </h2>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button className="rounded px-3 py-1.5 text-xs font-semibold transition-colors hover:opacity-80"
                    style={{ border: "1px solid #004635", color: "#004635", opacity: (!profile || isSwitching) ? 0.5 : 1, cursor: (!profile || isSwitching) ? "default" : "pointer" }}
                    onClick={handleSwitchProfile}
                    disabled={!profile || isSwitching}>
                    {isSwitching ? "Switching…" : "Switch Profile"}
                  </button>
                  <a href="/profile" className="rounded px-3 py-1.5 text-xs font-semibold transition-colors hover:opacity-80"
                    style={{ backgroundColor: "#004635", color: "#ffffff", border: "1px solid #004635" }}>
                    Edit
                  </a>
                </div>
              </div>
              <div className="relative" style={{ borderTop: "1px solid #3d3d38", paddingTop: 24 }}>
                <h3 className="text-xs font-semibold uppercase mb-4" style={{ color: "#404944", letterSpacing: "0.05em" }}>
                  Recent Adjustments Log
                </h3>
                <ul className="space-y-4" aria-busy={historyPage.busy}>
                  {historyPage.loading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <li key={i} className="flex items-start gap-3">
                        <Skeleton style={{ width: 18, height: 18, borderRadius: 999, marginTop: 2 }} />
                        <div style={{ flex: 1 }}>
                          <Skeleton style={{ width: i === 1 ? '78%' : '92%', height: 18 }} />
                          <Skeleton style={{ width: 84, height: 14, marginTop: 8 }} />
                        </div>
                      </li>
                    ))
                  ) : historyPage.items.length > 0 ? (
                    historyPage.items.map((h, i) => (
                      <li key={i} className="flex items-start gap-3">
                        <span className="material-symbols-outlined mt-0.5" style={{ fontSize: 18, color: "#004635" }}>tune</span>
                        <div>
                          <p style={{ color: "#1b1c1c" }}>{h.change_summary}</p>
                          <span className="block mt-1 text-sm" style={{ color: "#5e5f5b" }}>{timeSince(h.changed_at)}</span>
                        </div>
                      </li>
                    ))
                  ) : (
                    <li className="flex items-start gap-3">
                      <span className="material-symbols-outlined mt-0.5" style={{ fontSize: 18, color: "#004635" }}>tune</span>
                      <div>
                        <p style={{ color: "#1b1c1c" }}>Synapse initialised your profile model. Start reading to see adjustments here.</p>
                        <span className="block mt-1 text-sm" style={{ color: "#5e5f5b" }}>Just now</span>
                      </div>
                    </li>
                  )}
                </ul>
                {historyPage.showPager && (
                  <Pager
                    label="Recent adjustments"
                    page={historyPage.page}
                    pageCount={historyPage.pageCount}
                    rangeStart={historyPage.rangeStart}
                    rangeEnd={historyPage.rangeEnd}
                    total={historyPage.total}
                    hasMore={historyPage.hasMore}
                    busy={historyPage.busy}
                    onPrev={historyPage.prev}
                    onNext={historyPage.next}
                  />
                )}
              </div>
            </section>

            {/* Activity Stats */}
            <section>
              <h2 className="font-serif font-semibold mb-6 pb-2 text-2xl"
                style={{ borderBottom: "1px solid #e4e2e1", color: "#1b1c1c" }}>
                Activity Overview
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {displayStats.map((stat) => (
                  <div key={stat.label} className="p-4 rounded shadow-tactile flex flex-col justify-between h-32"
                    style={{ backgroundColor: "#fcf9f8", border: "1px solid #3d3d38" }}>
                    <span className="text-xs font-semibold" style={{ color: "#5e5f5b", letterSpacing: "0.05em" }}>
                      {stat.label}
                    </span>
                    <div className="font-serif font-semibold" style={{ fontSize: 32, lineHeight: 1.2, color: "#004635" }}>
                      {isLoading ? <Skeleton style={{ width: 62, height: 34 }} /> : stat.value}
                    </div>
                  </div>
                ))}
              </div>
            </section>

          </div>

          {/* RIGHT COLUMN */}
          <div className="md:col-span-4 md:col-start-9 flex flex-col gap-10">

            {/* Feedback Insights */}
            <section className="p-6 rounded-lg" style={{ backgroundColor: "#fcf9f8", border: "1px solid #3d3d38" }}>
              <h3 className="font-serif font-semibold text-2xl mb-2" style={{ color: "#1b1c1c" }}>Feedback Insights</h3>
              <p className="text-sm mb-6" style={{ color: "#5e5f5b" }}>Based on your interactions with reformatted cards.</p>
              <div className="space-y-3">
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <Skeleton style={{ width: 74, height: 16 }} />
                      <Skeleton style={{ flex: 1, height: 8, borderRadius: 999 }} />
                      <Skeleton style={{ width: 26, height: 14 }} />
                    </div>
                  ))
                ) : normalizedFeedback.length > 0 ? normalizedFeedback.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-2">
                    <span className="text-sm w-24 shrink-0" style={{ color: "#1b1c1c" }}>{item.label}</span>
                    <div className="flex-grow h-2 rounded-full overflow-hidden" style={{ backgroundColor: "#e4e2e1" }}>
                      <div className="h-full rounded-full" style={{ width: `${item.pct}%`, backgroundColor: item.barColor }} />
                    </div>
                    <span className="text-xs font-semibold w-8 text-right" style={{ color: "#5e5f5b" }}>{item.pct}%</span>
                  </div>
                )) : (
                  <p className="text-sm" style={{ color: "#5e5f5b", fontStyle: "italic" }}>No feedback collected yet.</p>
                )}
              </div>
            </section>

            {/* Session History */}
            <section>
              <h3 className="font-serif font-semibold text-2xl mb-4 pb-2" style={{ borderBottom: "1px solid #e4e2e1", color: "#1b1c1c" }}>
                Recent Sessions
              </h3>
              <ul aria-busy={sessionPage.busy}>
                {sessionPage.loading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <li key={i} className="py-3 flex justify-between items-center px-2 -mx-2" style={{ borderBottom: "1px solid #e4e2e1" }}>
                      <div style={{ flex: 1 }}>
                        <Skeleton style={{ width: i === 0 ? '82%' : '64%', height: 18 }} />
                        <Skeleton style={{ width: 92, height: 14, marginTop: 7 }} />
                      </div>
                      <Skeleton style={{ width: 78, height: 24 }} />
                    </li>
                  ))
                ) : sessionPage.items.length > 0 ? sessionPage.items.map((s, i) => (
                  <li key={i} className="py-3 flex justify-between items-center cursor-pointer px-2 -mx-2 rounded transition-colors hover:opacity-80"
                    style={{ borderBottom: "1px solid #e4e2e1" }}>
                    <div className="truncate pr-4">
                      <span className="block truncate" style={{ color: "#1b1c1c" }}>{s.page_title || "Untitled Session"}</span>
                      <span className="text-sm" style={{ color: "#5e5f5b" }}>{timeSince(s.created_at)}</span>
                    </div>
                    <DifficultyPill difficulty={s.session_difficulty} />
                  </li>
                )) : (
                  <li className="py-3 text-sm" style={{ color: "#5e5f5b", fontStyle: "italic" }}>No reading sessions recorded.</li>
                )}
              </ul>
              {sessionPage.showPager && (
                <Pager
                  label="Recent sessions"
                  page={sessionPage.page}
                  pageCount={sessionPage.pageCount}
                  rangeStart={sessionPage.rangeStart}
                  rangeEnd={sessionPage.rangeEnd}
                  total={sessionPage.total}
                  hasMore={sessionPage.hasMore}
                  busy={sessionPage.busy}
                  onPrev={sessionPage.prev}
                  onNext={sessionPage.next}
                />
              )}
            </section>

            {/* Billing */}
            <section className="p-5 rounded shadow-tactile mt-auto"
              style={{ backgroundColor: "#f0eded", border: "1px solid #3d3d38" }}>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold uppercase" style={{ color: "#5e5f5b", letterSpacing: "0.05em" }}>
                  Plan Status
                </span>
                <span className="text-xs px-2 py-0.5 rounded font-semibold"
                  style={{ backgroundColor: (billing?.plan || 'free') === 'free' ? '#5e5f5b' : '#004635', color: "#ffffff" }}>
                  {billing?.plan
                    ? (PLAN_LABELS[billing.plan] || billing.plan).toUpperCase()
                    : (isLoading ? <Skeleton style={{ width: 46, height: 14 }} /> : 'FREE')}
                </span>
              </div>
              <div className="flex justify-between items-end">
                <div>
                  {isLoading ? (
                    <>
                      <Skeleton style={{ width: 128, height: 20 }} />
                      <Skeleton style={{ width: 174, height: 16, marginTop: 8 }} />
                    </>
                  ) : (
                    <>
                      <p className="font-medium" style={{ color: "#1b1c1c" }}>
                        {billing?.status === 'trialing' ? 'Free Trial' : 'Monthly Access'}
                      </p>
                      <p className="text-sm mt-1" style={{ color: "#5e5f5b" }}>
                        {billing?.renews_at 
                          ? `Renews on ${new Date(billing.renews_at).toLocaleDateString()}` 
                          : billing?.trial_ends_at 
                            ? `Trial ends ${new Date(billing.trial_ends_at).toLocaleDateString()}`
                            : 'Free tier limits apply'}
                      </p>
                    </>
                  )}
                </div>
                {billing && billing.plan !== 'free' && (
                  <a href="/subscription" className="text-sm font-semibold hover:underline" style={{ color: "#004635", textDecoration: 'none' }}>Manage</a>
                )}
                {(!billing || billing.plan === 'free') && !isLoading && (
                   <a href="/billing" className="text-sm font-semibold hover:underline" style={{ color: "#004635", textDecoration: 'none' }}>Upgrade</a>
                )}
              </div>
            </section>

          </div>
        </main>

        {/* ── FOOTER (matches landing page) ──────────────────────── */}
        <AppFooter />

      </div>
    </>
  );
}
