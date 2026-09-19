import { useEffect, useMemo, useState } from 'react';
import { supabase } from './lib/supabase';
import { createSupportTicket, getBillingStatus, getMyTickets, getProfile } from './lib/api';
import { pingExtension, type ExtensionInfo } from './lib/extensionBridge';
import {
  RESPONSE_TIMES,
  SUPPORT_EMAIL,
  TOPICS,
  TOPIC_LABELS,
  searchContent,
  type FaqEntry,
  type Guide,
} from './lib/faq';
import { PLAN_LABELS, formatDate } from './lib/plans';
import { PROFILE_TYPE_LABELS, type ProfileType } from './lib/profile';
import AppShell from './component/AppShell';
import { CARD, INSET, Eyebrow, Notice, Pager, Section } from './component/ui';
import { useOffsetPage } from './lib/usePaging';

interface Ticket {
  id: string;
  reference: string;
  topic: string;
  subject: string;
  message: string;
  email: string;
  status: string;
  reply?: string | null;
  replied_at?: string | null;
  created_at: string;
}

const MESSAGE_MAX = 5000;
const TICKETS_PER_PAGE = 5;
const SUBJECT_MAX = 200;

const TICKET_STATUS: Record<string, { label: string; bg: string }> = {
  open: { label: 'Open', bg: '#8a4b24' },
  answered: { label: 'Answered', bg: '#004635' },
  closed: { label: 'Closed', bg: '#5e5f5b' },
};

export default function Support() {
  const [user, setUser] = useState<any>(null);
  const [checkedAuth, setCheckedAuth] = useState(false);
  const [billing, setBilling] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [extension, setExtension] = useState<ExtensionInfo | null>(null);

  const [query, setQuery] = useState('');

  const [topic, setTopic] = useState(TOPICS[0].value);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [attachDiagnostics, setAttachDiagnostics] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Ticket | null>(null);

  useEffect(() => {
    async function load() {
      // This page must work signed out — someone whose sign-in is broken is
      // exactly the person who needs it. No redirect guard here.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setUser(user || null);
      setCheckedAuth(true);

      pingExtension().then(setExtension);

      if (!user) return;
      getBillingStatus().then(setBilling).catch(() => {});
      getProfile().then(setProfile).catch(() => {});
    }
    load();

    // Deep link from the FAQ's "Request a student discount" link.
    if (window.location.hash === '#contact') {
      setTimeout(() => document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' }), 400);
    }
  }, []);

  // Only signed-in callers have tickets; the hook stays idle until auth is known.
  const ticketPage = useOffsetPage<Ticket>(getMyTickets, TICKETS_PER_PAGE, {
    enabled: Boolean(user),
  });

  const results = useMemo(() => searchContent(query), [query]);

  const diagnostics = useMemo(() => {
    const data: Record<string, unknown> = {
      plan: billing?.plan || (user ? 'free' : 'not signed in'),
      subscription_status: billing?.status || null,
      extension: extension
        ? extension.installed
          ? `installed (v${extension.version || 'unknown'})`
          : 'not detected'
        : 'checking…',
      browser: navigator.userAgent,
      page_language: navigator.language,
    };
    if (profile) {
      data.reading_profile =
        `${PROFILE_TYPE_LABELS[profile.profile_type as ProfileType] || profile.profile_type}` +
        ` · ${profile.preferred_format} · ${profile.chunk_size} chunks · ${profile.max_nesting_depth} levels`;
    }
    return data;
  }, [billing, profile, extension, user]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (!subject.trim() || !message.trim()) {
      setError('Please add a subject and tell us what is happening.');
      return;
    }
    if (!user && !email.trim()) {
      setError('Please add an email address so we can reply to you.');
      return;
    }

    setBusy(true);
    try {
      const ticket: Ticket = await createSupportTicket({
        topic,
        subject: subject.trim(),
        message: message.trim(),
        ...(user ? {} : { email: email.trim() }),
        diagnostics: attachDiagnostics ? (diagnostics as Record<string, unknown>) : null,
      });
      setSent(ticket);
      // Back to the newest page rather than prepending: the row belongs to
      // page 1 and the total has changed.
      ticketPage.reset();
      setSubject('');
      setMessage('');
    } catch (err: any) {
      setError(err?.message || 'We could not send your ticket. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const planTier = billing?.plan || 'free';

  return (
    <AppShell
      user={user}
      authChecked={checkedAuth}
      backTo={user ? { href: '/dashboard', label: 'Back to dashboard' } : undefined}
    >
      <main className="flex-grow w-full mx-auto px-10 py-16" style={{ maxWidth: 1140 }}>
        <section className="mb-8">
          <h1
            className="font-serif font-bold mb-4"
            style={{ fontSize: 48, lineHeight: 1.1, letterSpacing: '-0.02em', color: '#1b1c1c' }}
          >
            How can we help?
          </h1>
          <p className="text-lg" style={{ lineHeight: 1.6, color: '#5e5f5b', maxWidth: 620 }}>
            Most problems have a fix below. If yours doesn't, send us a ticket — we read every one,
            and you don't need to explain your setup twice.
          </p>
        </section>

        {/* Search */}
        <section className="mb-10">
          <label className="block" style={{ maxWidth: 620 }}>
            <span className="field-label">Search help</span>
            <div className="relative">
              <input
                type="text"
                className="field"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. limit, refund, not reformatting"
              />
            </div>
            {query.trim() && (
              <span className="field-hint">
                {results.total === 0
                  ? 'Nothing matched. Try fewer words, or send us a ticket below.'
                  : `${results.total} ${results.total === 1 ? 'result' : 'results'}`}
                {' · '}
                <button
                  type="button"
                  className="font-semibold hover:underline"
                  style={{ color: '#004635', background: 'none', border: 0, padding: 0, font: 'inherit' }}
                  onClick={() => setQuery('')}
                >
                  Clear
                </button>
              </span>
            )}
          </label>
        </section>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-10">
          {/* ── LEFT ──────────────────────────────────────────────── */}
          <div className="md:col-span-7 flex flex-col gap-10">
            {results.guides.length > 0 && (
              <Section title="Fix it yourself">
                <div className="flex flex-col gap-3">
                  {results.guides.map((guide) => (
                    <GuideBlock key={guide.id} guide={guide} />
                  ))}
                </div>
              </Section>
            )}

            {results.faqs.length > 0 && (
              <Section title="Common questions">
                <div className="flex flex-col gap-3">
                  {results.faqs.map((faq) => (
                    <FaqBlock key={faq.question} faq={faq} />
                  ))}
                </div>
              </Section>
            )}

            {/* Contact */}
            <section id="contact" className="rounded-xl p-8 shadow-tactile" style={CARD}>
              <Eyebrow>Still stuck?</Eyebrow>
              <h2 className="font-serif font-semibold mt-2 mb-2" style={{ fontSize: 28, lineHeight: 1.2, color: '#004635' }}>
                Send us a ticket
              </h2>
              <p className="text-sm mb-6" style={{ color: '#5e5f5b', lineHeight: 1.6 }}>
                We'll email you a confirmation with a reference, and reply to that address.
              </p>

              {sent ? (
                <div>
                  <Notice kind="success">
                    We've got it. Your reference is <strong>{sent.reference}</strong> — quote it if
                    you need to follow up. A confirmation is on its way to{' '}
                    <strong style={{ overflowWrap: 'anywhere' }}>{sent.email}</strong>.
                  </Notice>
                  <div
                    className="mt-6 p-4 rounded-lg flex items-start gap-3"
                    style={{ ...INSET, border: 'none' }}
                  >
                    <span className="material-symbols-outlined shrink-0" style={{ fontSize: 18, color: '#004635' }}>
                      schedule
                    </span>
                    <p className="text-sm" style={{ color: '#5e5f5b', lineHeight: 1.6, margin: 0 }}>
                      We usually reply within{' '}
                      {RESPONSE_TIMES.find((r) => r.plan === planTier)?.time.toLowerCase() ||
                        '2–3 business days'}
                      . Replying to that confirmation email reaches us directly.
                    </p>
                  </div>
                  <button
                    className="rounded px-4 py-3 mt-6 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                    style={{ backgroundColor: '#004635', color: '#fff', border: '1px solid #004635' }}
                    onClick={() => setSent(null)}
                  >
                    Send another
                  </button>
                </div>
              ) : (
                <form onSubmit={submit} className="flex flex-col gap-4">
                  <label className="block">
                    <span className="field-label">What's it about?</span>
                    <select className="field" value={topic} onChange={(e) => setTopic(e.target.value)}>
                      {TOPICS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {checkedAuth && !user && (
                    <label className="block">
                      <span className="field-label">Your email</span>
                      <input
                        type="email"
                        className="field"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="so we can reply"
                        required
                      />
                    </label>
                  )}

                  <label className="block">
                    <span className="field-label">Subject</span>
                    <input
                      type="text"
                      className="field"
                      value={subject}
                      maxLength={SUBJECT_MAX}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="One line on what's wrong"
                      required
                    />
                  </label>

                  <label className="block">
                    <span className="field-label">What's happening?</span>
                    <textarea
                      className="field"
                      value={message}
                      maxLength={MESSAGE_MAX}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="What you did, what you expected, and what happened instead. A page URL helps."
                      required
                    />
                    <span className="field-hint">
                      {message.length} / {MESSAGE_MAX}
                    </span>
                  </label>

                  <label className="option-row" data-on={attachDiagnostics}>
                    <input
                      type="checkbox"
                      checked={attachDiagnostics}
                      onChange={(e) => setAttachDiagnostics(e.target.checked)}
                    />
                    <span>
                      <span className="option-title">Attach my setup details</span>
                      <span className="option-desc">
                        Your plan, reading profile, extension version and browser — shown in full on
                        the right. It saves a round trip, and you can leave it off.
                      </span>
                    </span>
                  </label>

                  {error && <Notice kind="error">{error}</Notice>}

                  <button
                    type="submit"
                    className="rounded px-4 py-4 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80 flex items-center justify-center gap-2"
                    style={{
                      backgroundColor: '#004635',
                      color: '#fff',
                      border: '1px solid #004635',
                      opacity: busy ? 0.6 : 1,
                    }}
                    disabled={busy}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                      send
                    </span>
                    {busy ? 'Sending…' : 'Send ticket'}
                  </button>
                </form>
              )}
            </section>

            {/* My tickets */}
            {user && ticketPage.items.length > 0 && (
              <Section title="Your tickets">
                <ul className="flex flex-col gap-3" aria-busy={ticketPage.busy}>
                  {ticketPage.items.map((t) => {
                    const chip = TICKET_STATUS[t.status] || TICKET_STATUS.open;
                    return (
                      <li key={t.id} className="p-4 rounded-lg" style={INSET}>
                        <div className="flex justify-between items-start gap-4 mb-1">
                          <span className="font-medium" style={{ color: '#1b1c1c' }}>
                            {t.subject}
                          </span>
                          <span
                            className="text-xs px-2 py-0.5 rounded font-semibold uppercase shrink-0"
                            style={{ backgroundColor: chip.bg, color: '#fff', letterSpacing: '0.05em' }}
                          >
                            {chip.label}
                          </span>
                        </div>
                        <p className="text-sm" style={{ color: '#5e5f5b' }}>
                          {t.reference} · {TOPIC_LABELS[t.topic] || t.topic} · {formatDate(t.created_at)}
                        </p>
                        {t.reply && (
                          <div className="mt-3 pt-3" style={{ borderTop: '1px solid #e4e2e1' }}>
                            <Eyebrow>Our reply</Eyebrow>
                            <p className="text-sm mt-1" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                              {t.reply}
                            </p>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {ticketPage.error && (
                  <div className="mt-4">
                    <Notice kind="error">{ticketPage.error}</Notice>
                  </div>
                )}
                {ticketPage.showPager && (
                  <Pager
                    label="Your tickets"
                    page={ticketPage.page}
                    pageCount={ticketPage.pageCount}
                    rangeStart={ticketPage.rangeStart}
                    rangeEnd={ticketPage.rangeEnd}
                    total={ticketPage.total}
                    hasMore={ticketPage.hasMore}
                    busy={ticketPage.busy}
                    onPrev={ticketPage.prev}
                    onNext={ticketPage.next}
                  />
                )}
              </Section>
            )}
          </div>

          {/* ── RIGHT ─────────────────────────────────────────────── */}
          <div className="md:col-span-4 md:col-start-9 flex flex-col gap-10">
            {/* Diagnostics */}
            <section className="p-6 rounded-lg" style={{ backgroundColor: '#fcf9f8', border: '1px solid #3d3d38' }}>
              <h3 className="font-serif font-semibold text-2xl mb-2" style={{ color: '#1b1c1c' }}>
                Your setup
              </h3>
              <p className="text-sm mb-4" style={{ color: '#5e5f5b', lineHeight: 1.6 }}>
                {attachDiagnostics
                  ? 'This goes with your ticket. Nothing you read is included.'
                  : "This won't be sent — you've turned the attachment off."}
              </p>
              <dl className="flex flex-col gap-3" style={{ opacity: attachDiagnostics ? 1 : 0.5 }}>
                <DiagRow label="Plan" value={user ? PLAN_LABELS[planTier] || planTier : 'Not signed in'} />
                <DiagRow
                  label="Extension"
                  value={
                    !extension
                      ? 'Checking…'
                      : extension.installed
                        ? `Installed (v${extension.version || '?'})`
                        : 'Not detected'
                  }
                  warn={extension ? !extension.installed : false}
                />
                {profile && (
                  <DiagRow
                    label="Reading profile"
                    value={PROFILE_TYPE_LABELS[profile.profile_type as ProfileType] || profile.profile_type}
                  />
                )}
                <DiagRow label="Browser" value={shortUA(navigator.userAgent)} />
              </dl>
            </section>

            {/* Contact & response times */}
            <section className="p-6 rounded-lg" style={{ backgroundColor: '#fcf9f8', border: '1px solid #3d3d38' }}>
              <h3 className="font-serif font-semibold text-2xl mb-4" style={{ color: '#1b1c1c' }}>
                Reaching us
              </h3>
              <Eyebrow>Email</Eyebrow>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="block mt-1 mb-4 font-semibold hover:underline"
                style={{ color: '#004635', overflowWrap: 'anywhere' }}
              >
                {SUPPORT_EMAIL}
              </a>

              <Eyebrow>First response</Eyebrow>
              <ul className="mt-2 mb-4 flex flex-col gap-2">
                {RESPONSE_TIMES.map((r) => (
                  <li
                    key={r.plan}
                    className="flex justify-between items-center gap-2 text-sm"
                    style={{ color: r.plan === planTier && user ? '#004635' : '#5e5f5b' }}
                  >
                    <span style={{ fontWeight: r.plan === planTier && user ? 600 : 400 }}>{r.label}</span>
                    <span>{r.time}</span>
                  </li>
                ))}
              </ul>

              <p className="text-xs pt-3" style={{ color: '#5e5f5b', borderTop: '1px solid #e4e2e1', lineHeight: 1.6 }}>
                If a reading difference makes any of this hard to use, say so in your ticket and
                we'll reply however works for you.
              </p>
            </section>
          </div>
        </div>
      </main>
    </AppShell>
  );
}

function DiagRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between items-start gap-3 text-sm">
      <dt className="shrink-0" style={{ color: '#5e5f5b' }}>
        {label}
      </dt>
      <dd
        className="text-right"
        style={{ color: warn ? '#ba1a1a' : '#1b1c1c', margin: 0, overflowWrap: 'anywhere' }}
      >
        {value}
      </dd>
    </div>
  );
}

/** Native <details> keeps keyboard and screen-reader behaviour for free. */
function GuideBlock({ guide }: { guide: Guide }) {
  return (
    <details className="rounded-lg" style={{ ...CARD, padding: 0 }}>
      <summary className="flex items-start gap-3 p-4 cursor-pointer">
        <span className="material-symbols-outlined shrink-0" style={{ fontSize: 20, color: '#004635' }}>
          {guide.icon}
        </span>
        <span>
          <span className="option-title">{guide.title}</span>
          <span className="option-desc">{guide.summary}</span>
        </span>
      </summary>
      <ol className="px-4 pb-4 flex flex-col gap-2" style={{ listStyle: 'none', counterReset: 'step' }}>
        {guide.steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3 text-sm" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
            <span
              className="shrink-0 rounded-full flex items-center justify-center text-xs font-semibold"
              style={{ width: 22, height: 22, backgroundColor: '#e4e2e1', color: '#004635' }}
            >
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function FaqBlock({ faq }: { faq: FaqEntry }) {
  return (
    <details className="rounded-lg" style={{ ...CARD, padding: 0 }}>
      <summary className="flex items-start justify-between gap-3 p-4 cursor-pointer">
        <span className="option-title">{faq.question}</span>
        <span
          className="text-xs px-2 py-0.5 rounded font-semibold shrink-0"
          style={{ backgroundColor: '#e4e2e1', color: '#5e5f5b' }}
        >
          {faq.category}
        </span>
      </summary>
      <div className="px-4 pb-4">
        <p className="text-sm" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
          {faq.answer}
        </p>
        {faq.link && (
          <a
            href={faq.link.href}
            className="inline-flex items-center gap-1 mt-3 text-sm font-semibold hover:underline"
            style={{ color: '#004635' }}
          >
            {faq.link.label}
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
              arrow_forward
            </span>
          </a>
        )}
      </div>
    </details>
  );
}

/** "Chrome 140 on Windows" beats 120 characters of user-agent string. */
function shortUA(ua: string): string {
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[0]?.replace('Edg/', 'Edge ') ||
    /Chrome\/(\d+)/.exec(ua)?.[0]?.replace('Chrome/', 'Chrome ') ||
    /Firefox\/(\d+)/.exec(ua)?.[0]?.replace('Firefox/', 'Firefox ') ||
    /Version\/(\d+).*Safari/.exec(ua)?.[1]?.replace(/^/, 'Safari ') ||
    'Unknown browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Linux/.test(ua)
        ? 'Linux'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad/.test(ua)
            ? 'iOS'
            : '';
  return os ? `${browser} on ${os}` : browser;
}
