import { useState, useEffect } from "react";
import { supabase } from "./lib/supabase";
import { getBillingStatus, openCustomerPortal } from "./lib/api";

type SessionDifficulty = "hard" | "normal" | "flowing";

interface Session {
  title: string;
  time: string;
  difficulty: SessionDifficulty;
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

const sessions: Session[] = [
  { title: "Wikipedia: Cognitive Load Theory", time: "2 hours ago", difficulty: "flowing" },
  { title: "Arxiv: Attention Is All You Need", time: "Yesterday", difficulty: "normal" },
  { title: "Medium: Understanding React Hooks", time: "2 days ago", difficulty: "hard" },
];

const feedbackItems: FeedbackItem[] = [
  { label: "Clearer",      pct: 65, barColor: "#004635" },
  { label: "Too Complex",  pct: 20, barColor: "#707974" },
  { label: "Too Simple",   pct: 10, barColor: "#707974" },
  { label: "Missed Point", pct:  5, barColor: "#ba1a1a" },
];

const difficultyMap: Record<SessionDifficulty, { bg: string; color: string; icon: string; label: string }> = {
  flowing: { bg: "#e4e2e1", color: "#004635", icon: "water",   label: "Flowing" },
  normal:  { bg: "#e4e2e1", color: "#5e5f5b", icon: "remove",  label: "Normal" },
  hard:    { bg: "#ffdad6", color: "#ba1a1a", icon: "warning", label: "Hard" },
};

function DifficultyPill({ difficulty }: { difficulty: SessionDifficulty }) {
  const d = difficultyMap[difficulty];
  return (
    <div className="flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold shrink-0"
      style={{ backgroundColor: d.bg, color: d.color }}>
      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{d.icon}</span> {d.label}
    </div>
  );
}

export default function Dashboard() {
  const [readingDay, setReadingDay] = useState<SessionDifficulty>("normal");
  const [user, setUser] = useState<any>(null);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        window.location.href = "/auth?tab=login";
        return;
      }
      setUser(user);

      try {
        const status = await getBillingStatus();
        setBilling(status);
      } catch (err) {
        console.error("Failed to load billing status", err);
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, []);

  async function handleManageBilling() {
    try {
      const url = await openCustomerPortal();
      window.location.href = url;
    } catch (err) {
      alert("Failed to open billing portal. Please try again.");
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/auth?tab=login";
  }

  return (
    <>
      {/* Google Fonts + Material Symbols + scoped utility styles */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,400;0,700;1,400;1,700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&display=swap');

        .shadow-tactile { box-shadow: 2px 2px 0px 0px rgba(0,70,53,0.15); }
        .font-serif { font-family: 'Source Serif 4', serif; }
        .font-body  { font-family: 'Atkinson Hyperlegible Next', sans-serif; }
        .material-symbols-outlined { font-family: 'Material Symbols Outlined'; font-weight: normal; font-style: normal; font-size: 20px; line-height: 1; letter-spacing: normal; text-transform: none; display: inline-block; white-space: nowrap; word-wrap: normal; direction: ltr; -webkit-font-feature-settings: 'liga'; -webkit-font-smoothing: antialiased; font-variation-settings: 'FILL' 1; }

        /* ── Scoped utility layer (Tailwind-compatible subset used by this page) ── */
        .dash ul { list-style: none; margin: 0; padding: 0; }
        .dash li { margin: 0; }

        .dash .flex { display: flex; }
        .dash .inline-flex { display: inline-flex; }
        .dash .grid { display: grid; }
        .dash .block { display: block; }
        .dash .flex-col { flex-direction: column; }
        .dash .flex-grow { flex-grow: 1; }
        .dash .flex-wrap { flex-wrap: wrap; }

        .dash .items-center { align-items: center; }
        .dash .items-start { align-items: flex-start; }
        .dash .items-end { align-items: flex-end; }
        .dash .justify-center { justify-content: center; }
        .dash .justify-between { justify-content: space-between; }

        .dash .gap-1 { gap: 0.25rem; }
        .dash .gap-2 { gap: 0.5rem; }
        .dash .gap-3 { gap: 0.75rem; }
        .dash .gap-4 { gap: 1rem; }
        .dash .gap-6 { gap: 1.5rem; }
        .dash .gap-10 { gap: 2.5rem; }

        .dash .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
        .dash .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }

        .dash .w-full { width: 100%; }
        .dash .w-2 { width: 0.5rem; }
        .dash .w-8 { width: 2rem; }
        .dash .w-24 { width: 6rem; }
        .dash .w-32 { width: 8rem; }
        .dash .h-2 { height: 0.5rem; }
        .dash .h-8 { height: 2rem; }
        .dash .h-32 { height: 8rem; }
        .dash .h-full { height: 100%; }

        .dash .mx-auto { margin-left: auto; margin-right: auto; }
        .dash .ml-2 { margin-left: 0.5rem; }
        .dash .mt-auto { margin-top: auto; }
        .dash .mt-0\\.5 { margin-top: 0.125rem; }
        .dash .mt-1 { margin-top: 0.25rem; }
        .dash .mt-4 { margin-top: 1rem; }
        .dash .mb-2 { margin-bottom: 0.5rem; }
        .dash .mb-4 { margin-bottom: 1rem; }
        .dash .mb-6 { margin-bottom: 1.5rem; }
        .dash .-mx-2 { margin-left: -0.5rem; margin-right: -0.5rem; }

        .dash .p-2 { padding: 0.5rem; }
        .dash .p-4 { padding: 1rem; }
        .dash .p-5 { padding: 1.25rem; }
        .dash .p-6 { padding: 1.5rem; }
        .dash .p-8 { padding: 2rem; }
        .dash .p-1\\.5 { padding: 0.375rem; }
        .dash .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
        .dash .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
        .dash .px-10 { padding-left: 2.5rem; padding-right: 2.5rem; }
        .dash .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
        .dash .py-1\\.5 { padding-top: 0.375rem; padding-bottom: 0.375rem; }
        .dash .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
        .dash .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
        .dash .py-16 { padding-top: 4rem; padding-bottom: 4rem; }
        .dash .py-0\\.5 { padding-top: 0.125rem; padding-bottom: 0.125rem; }
        .dash .pb-2 { padding-bottom: 0.5rem; }
        .dash .pb-3 { padding-bottom: 0.75rem; }
        .dash .pr-4 { padding-right: 1rem; }

        .dash .space-y-3 > * + * { margin-top: 0.75rem; }
        .dash .space-y-4 > * + * { margin-top: 1rem; }

        .dash .rounded { border-radius: 0.25rem; }
        .dash .rounded-lg { border-radius: 0.5rem; }
        .dash .rounded-xl { border-radius: 0.75rem; }
        .dash .rounded-full { border-radius: 9999px; }
        .dash .rounded-bl-full { border-bottom-left-radius: 9999px; }

        .dash .text-xs { font-size: 0.75rem; line-height: 1rem; }
        .dash .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
        .dash .text-lg { font-size: 1.125rem; line-height: 1.75rem; }
        .dash .text-2xl { font-size: 1.5rem; line-height: 2rem; }
        .dash .text-right { text-align: right; }

        .dash .font-medium { font-weight: 500; }
        .dash .font-semibold { font-weight: 600; }
        .dash .font-bold { font-weight: 700; }

        .dash .uppercase { text-transform: uppercase; }
        .dash .tracking-wider { letter-spacing: 0.05em; }
        .dash .tracking-widest { letter-spacing: 0.1em; }

        .dash .shrink-0 { flex-shrink: 0; }
        .dash .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dash .relative { position: relative; }
        .dash .absolute { position: absolute; }
        .dash .top-0 { top: 0; }
        .dash .right-0 { right: 0; }
        .dash .overflow-hidden { overflow: hidden; }
        .dash .opacity-50 { opacity: 0.5; }
        .dash .cursor-pointer { cursor: pointer; }

        .dash .transition-colors { transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease; }
        .dash .hover\\:opacity-80:hover { opacity: 0.8; }
        .dash .hover\\:underline:hover { text-decoration: underline; }

        @media (min-width: 640px) {
          .dash .sm\\:grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        }
        @media (min-width: 768px) {
          .dash .md\\:grid-cols-12 { grid-template-columns: repeat(12, minmax(0, 1fr)); }
          .dash .md\\:col-span-7 { grid-column: span 7 / span 7; }
          .dash .md\\:col-span-4 { grid-column: span 4 / span 4; }
          .dash .md\\:col-start-9 { grid-column-start: 9; }
        }
      `}</style>

      <div className="dash font-body" style={{ backgroundColor: "#fcf9f8", color: "#1b1c1c", minHeight: "100vh", display: "flex", flexDirection: "column" }}>

        {/* ── HEADER ─────────────────────────────────────────────── */}
        <header style={{ backgroundColor: "#fcf9f8", borderBottom: "1px solid #3d3d38" }}>
          <div className="flex justify-between items-center w-full px-10 py-4 mx-auto" style={{ maxWidth: 1140 }}>
            <div className="flex items-center gap-2 font-serif font-bold text-2xl" style={{ color: "#004635" }}>
              <span className="material-symbols-outlined">psychology</span>
              Synapse
            </div>
            <div className="flex items-center gap-2 cursor-pointer p-1.5 rounded-lg transition-colors hover:opacity-80" onClick={handleLogout}>
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold"
                style={{ backgroundColor: "#1b5e4b", color: "#94d5bd" }}>
                {user?.user_metadata?.full_name?.split(' ').map((n: string) => n[0]).join('') || user?.email?.[0].toUpperCase() || 'AA'}
              </div>
              <span className="material-symbols-outlined text-lg" style={{ color: "#5e5f5b", fontVariationSettings: "'FILL' 0" }}>logout</span>
            </div>
          </div>
        </header>

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
                    Load Reducer
                  </h2>
                </div>
                <button className="rounded px-3 py-1.5 text-xs font-semibold transition-colors hover:opacity-80"
                  style={{ border: "1px solid #004635", color: "#004635" }}>
                  Switch Profile
                </button>
              </div>
              <div className="relative" style={{ borderTop: "1px solid #3d3d38", paddingTop: 24 }}>
                <h3 className="text-xs font-semibold uppercase mb-4" style={{ color: "#404944", letterSpacing: "0.05em" }}>
                  Recent Adjustments Log
                </h3>
                <ul className="space-y-4">
                  <li className="flex items-start gap-3">
                    <span className="material-symbols-outlined mt-0.5" style={{ fontSize: 18, color: "#004635" }}>tune</span>
                    <div>
                      <p style={{ color: "#1b1c1c" }}>Synapse shortened your chunks because your read depth dropped below 40% yesterday.</p>
                      <span className="block mt-1 text-sm" style={{ color: "#5e5f5b" }}>2 hours ago</span>
                    </div>
                  </li>
                  <li className="flex items-start gap-3 pb-3" style={{ borderBottom: "1px solid #e4e2e1" }}>
                    <span className="material-symbols-outlined mt-0.5" style={{ fontSize: 18, color: "#004635" }}>contrast</span>
                    <div>
                      <p style={{ color: "#1b1c1c" }}>Increased contrast on background elements on medium-complexity pages.</p>
                      <span className="block mt-1 text-sm" style={{ color: "#5e5f5b" }}>1 day ago</span>
                    </div>
                  </li>
                </ul>
              </div>
            </section>

            {/* Activity Stats */}
            <section>
              <h2 className="font-serif font-semibold mb-6 pb-2 text-2xl"
                style={{ borderBottom: "1px solid #e4e2e1", color: "#1b1c1c" }}>
                Activity Overview
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { label: "Cards Generated", value: "342" },
                  { label: "Pages Visited",   value: "89" },
                  { label: "Words Processed", value: "45k" },
                  { label: "Time Saved",      value: "4h 12m" },
                ].map((stat) => (
                  <div key={stat.label} className="p-4 rounded shadow-tactile flex flex-col justify-between h-32"
                    style={{ backgroundColor: "#fcf9f8", border: "1px solid #3d3d38" }}>
                    <span className="text-xs font-semibold" style={{ color: "#5e5f5b", letterSpacing: "0.05em" }}>
                      {stat.label}
                    </span>
                    <div className="font-serif font-semibold" style={{ fontSize: 32, lineHeight: 1.2, color: "#004635" }}>
                      {stat.value}
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
                {feedbackItems.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-2">
                    <span className="text-sm w-24 shrink-0" style={{ color: "#1b1c1c" }}>{item.label}</span>
                    <div className="flex-grow h-2 rounded-full overflow-hidden" style={{ backgroundColor: "#e4e2e1" }}>
                      <div className="h-full rounded-full" style={{ width: `${item.pct}%`, backgroundColor: item.barColor }} />
                    </div>
                    <span className="text-xs font-semibold w-8 text-right" style={{ color: "#5e5f5b" }}>{item.pct}%</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Session History */}
            <section>
              <h3 className="font-serif font-semibold text-2xl mb-4 pb-2" style={{ borderBottom: "1px solid #e4e2e1", color: "#1b1c1c" }}>
                Recent Sessions
              </h3>
              <ul>
                {sessions.map((s, i) => (
                  <li key={i} className="py-3 flex justify-between items-center cursor-pointer px-2 -mx-2 rounded transition-colors hover:opacity-80"
                    style={{ borderBottom: "1px solid #e4e2e1" }}>
                    <div className="truncate pr-4">
                      <span className="block truncate" style={{ color: "#1b1c1c" }}>{s.title}</span>
                      <span className="text-sm" style={{ color: "#5e5f5b" }}>{s.time}</span>
                    </div>
                    <DifficultyPill difficulty={s.difficulty} />
                  </li>
                ))}
              </ul>
              <button className="mt-4 text-sm font-semibold hover:underline" style={{ color: "#004635" }}>
                View Full History
              </button>
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
                  {billing?.plan?.toUpperCase() || (isLoading ? '...' : 'FREE')}
                </span>
              </div>
              <div className="flex justify-between items-end">
                <div>
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
                </div>
                {billing && billing.plan !== 'free' && (
                  <button className="text-sm font-semibold hover:underline" style={{ color: "#004635" }} onClick={handleManageBilling}>Manage</button>
                )}
                {(!billing || billing.plan === 'free') && !isLoading && (
                   <a href="/#pricing" className="text-sm font-semibold hover:underline" style={{ color: "#004635", textDecoration: 'none' }}>Upgrade</a>
                )}
              </div>
            </section>

          </div>
        </main>

        {/* ── FOOTER (matches landing page) ──────────────────────── */}
        <footer className="footer">
          <div className="footer-shell">
            <a className="brand" href="/">Synapse</a>
            <div className="copyright">2026 Synapse. Built for the cognitive edge.</div>
            <nav aria-label="Footer navigation">
              <a href="/">Privacy Policy</a>
              <a href="/">Accessibility Statement</a>
              <a href="/#library">Research Library</a>
              <a href="/">Contact Support</a>
            </nav>
          </div>
        </footer>

      </div>
    </>
  );
}
