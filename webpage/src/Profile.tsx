import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import {
  deleteAccount,
  getBillingStatus,
  getProfile,
  getProfileHistory,
  getUsage,
  syncUser,
  updateProfile,
} from './lib/api';
import {
  CHUNK_SIZES,
  FIELD_LABELS,
  FORMATS,
  NESTING_DEPTHS,
  NOTES_MAX,
  PROFILE_TYPE_LABELS,
  READING_TYPES,
  TOGGLES,
  changedKeys,
  formatFieldValue,
  toFields,
  type ChunkSize,
  type NestingDepth,
  type PreferredFormat,
  type ProfileFields,
  type ProfileType,
} from './lib/profile';
import { PLAN_LABELS, formatDate } from './lib/plans';
import AppShell, { initialsFor } from './component/AppShell';
import { CARD, INSET, Eyebrow, Notice, Section, Segmented, Skeleton } from './component/ui';

interface HistoryEntry {
  changed_at: string;
  change_summary: string;
  previous_state: Record<string, unknown>;
  new_state: Record<string, unknown>;
}

interface BillingInfo {
  plan: string;
  status: string;
  cancel_at_period_end?: boolean;
  renews_at?: string | null;
}

interface Usage {
  plan: string;
  unlimited: boolean;
  limit_type: string;
  used: number;
  limit?: number | null;
  remaining?: number | null;
  resets_at?: string | null;
}

/** The backend caps /profile/history at 20 rows. */
const HISTORY_LIMIT = 20;

const SIDE_PANEL: React.CSSProperties = {
  backgroundColor: '#fcf9f8',
  border: '1px solid #3d3d38',
  maxWidth: '100%',
  minWidth: 0,
};

const PROFILE_ACTION: React.CSSProperties = {
  border: '1px solid #004635',
  color: '#004635',
  backgroundColor: 'transparent',
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  overflowWrap: 'anywhere',
};

export default function Profile() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<Record<string, any> | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);

  // `saved` is the last known server state; `draft` is what the form shows.
  // Everything dirty-related is derived from the difference between the two.
  const [saved, setSaved] = useState<ProfileFields | null>(null);
  const [draft, setDraft] = useState<ProfileFields | null>(null);

  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');

  const [loading, setLoading] = useState({ profile: true, history: true, billing: true, usage: true });
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  useEffect(() => {
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        window.location.href = `/auth?tab=login&next=${encodeURIComponent('/profile')}`;
        return;
      }
      setUser(user);
      const initialName = user.user_metadata?.full_name || '';
      setName(initialName);
      setSavedName(initialName);

      const done = (key: keyof typeof loading) => setLoading((p) => ({ ...p, [key]: false }));
      const settle = <T,>(p: Promise<T>, key: keyof typeof loading, apply: (v: T) => void) =>
        p
          .then(apply)
          .catch((err) => console.error(`Profile ${key} load error`, err))
          .finally(() => done(key));

      await Promise.all([
        settle(getProfile(), 'profile', (p) => {
          setProfile(p);
          const fields = toFields(p);
          setSaved(fields);
          setDraft(fields);
        }),
        settle(getProfileHistory(), 'history', (h) => setHistory(h || [])),
        settle(getBillingStatus(), 'billing', setBilling),
        settle(getUsage(), 'usage', setUsage),
      ]);
    }
    load();
  }, []);

  const dirtyFields = saved && draft ? changedKeys(saved, draft) : [];
  const nameDirty = name.trim() !== savedName.trim();
  const dirtyCount = dirtyFields.length + (nameDirty ? 1 : 0);
  const isDirty = dirtyCount > 0;

  function set<K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setNotice(null);
  }

  function discard() {
    if (saved) setDraft(saved);
    setName(savedName);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!draft || !saved || busy || !isDirty) return;
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      // Send only what changed — PATCH /profile is a true partial update, and
      // every call writes a history row, so a no-op patch would pollute the log.
      if (dirtyFields.length > 0) {
        const patch: Record<string, unknown> = {};
        for (const key of dirtyFields) patch[key] = draft[key];
        const updated = await updateProfile(patch);
        setProfile(updated);
        const fields = toFields(updated);
        setSaved(fields);
        setDraft(fields);
        getProfileHistory().then((h) => setHistory(h || [])).catch(() => {});
      }

      // users.name has no PATCH endpoint — it is written by /auth/sync from
      // the Supabase session, so update the metadata first, then re-sync.
      if (nameDirty) {
        const { error: authError } = await supabase.auth.updateUser({
          data: { full_name: name.trim() },
        });
        if (authError) throw new Error(authError.message);
        await syncUser();
        setSavedName(name.trim());
        setUser((u: any) => ({ ...u, user_metadata: { ...u?.user_metadata, full_name: name.trim() } }));
      }

      setNotice('Your profile has been updated.');
    } catch (err: any) {
      setError(err?.message || 'We could not save your changes. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  function exportProfile() {
    // Everything we hold about this account, assembled client-side — the
    // landing page promises users can take their profile elsewhere.
    const payload = {
      exported_at: new Date().toISOString(),
      account: {
        email: user?.email,
        name: savedName || null,
        plan: billing?.plan || 'free',
        member_since: user?.created_at || null,
      },
      cognitive_profile: saved,
      profile_history: history,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `synapse-profile-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setNotice('Your profile has been downloaded.');
  }

  async function handleDelete() {
    if (busy) return;
    setBusy('delete');
    setError(null);
    try {
      await deleteAccount();
      await supabase.auth.signOut();
      window.location.href = '/';
    } catch (err: any) {
      setError(err?.message || 'We could not delete your account.');
      setBusy(null);
    }
  }

  const tier = billing?.plan || 'free';
  const provider = user?.app_metadata?.provider;

  return (
    <AppShell user={user} backTo={{ href: '/dashboard', label: 'Back to dashboard' }}>
      <main className="flex-grow w-full mx-auto px-10 py-16" style={{ maxWidth: 1140 }}>
        <section className="mb-10">
          <h1
            className="font-serif font-bold mb-4"
            style={{ fontSize: 48, lineHeight: 1.1, letterSpacing: '-0.02em', color: '#1b1c1c' }}
          >
            Your profile.
          </h1>
          <p className="text-lg" style={{ lineHeight: 1.6, color: '#5e5f5b', maxWidth: 620 }}>
            This is the model Synapse reads you with. Change anything here and every page you
            open afterwards is reshaped to match — no re-onboarding, no starting over.
          </p>
        </section>

        {(error || notice) && (
          <div className="mb-8">
            {error ? <Notice kind="error">{error}</Notice> : <Notice kind="success">{notice}</Notice>}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-12 gap-10">
          {/* ── LEFT ──────────────────────────────────────────────── */}
          <div className="md:col-span-7 flex flex-col gap-10" style={{ minWidth: 0 }}>
            {/* Account */}
            <section className="rounded-xl p-8 shadow-tactile relative overflow-hidden" style={CARD}>
              <div
                className="absolute top-0 right-0 w-32 h-32 rounded-bl-full opacity-50"
                style={{ backgroundColor: '#e4e2e1', zIndex: 0 }}
              />
              <div className="relative">
                <Eyebrow>Account</Eyebrow>

                <div className="flex items-center gap-4 mt-4 mb-6">
                  <div
                    className="rounded-full flex items-center justify-center font-semibold shrink-0"
                    style={{ width: 56, height: 56, backgroundColor: '#1b5e4b', color: '#94d5bd', fontSize: 18 }}
                    aria-hidden="true"
                  >
                    {initialsFor(user)}
                  </div>
                  <div className="truncate">
                    <p className="font-serif font-semibold truncate" style={{ fontSize: 24, color: '#004635' }}>
                      {loading.profile ? <Skeleton style={{ width: 210, height: 30 }} /> : savedName || user?.email?.split('@')[0] || '—'}
                    </p>
                    <p className="text-sm truncate" style={{ color: '#5e5f5b' }}>
                      {user?.email || '—'}
                    </p>
                  </div>
                </div>

                <label className="block mb-4">
                  <span className="field-label">Display name</span>
                  <input
                    type="text"
                    className="field"
                    value={name}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="What should we call you?"
                  />
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4" style={{ borderTop: '1px solid #3d3d38' }}>
                  <div>
                    <Eyebrow>Signs in with</Eyebrow>
                    <p className="mt-1 flex items-center gap-2" style={{ color: '#1b1c1c' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#004635' }}>
                        {provider === 'google' ? 'account_circle' : 'mail'}
                      </span>
                      {provider === 'google' ? 'Google' : 'Email and password'}
                    </p>
                  </div>
                  <div>
                    <Eyebrow>Member since</Eyebrow>
                    <p className="mt-1" style={{ color: '#1b1c1c' }}>
                      {user?.created_at ? formatDate(user.created_at) : '—'}
                    </p>
                  </div>
                </div>

                <p className="field-hint mt-4">
                  Your email address comes from how you sign in and can't be changed here.
                  {provider !== 'google' && (
                    <>
                      {' '}
                      To change your password, use{' '}
                      <a href="/auth?tab=reset" className="font-semibold hover:underline" style={{ color: '#004635' }}>
                        reset password
                      </a>
                      .
                    </>
                  )}
                </p>
              </div>
            </section>

            {/* Reading type */}
            <Section title="How you read">
              <p className="text-sm mb-4" style={{ color: '#5e5f5b', lineHeight: 1.6 }}>
                This drives everything else. Pick whichever is closest — it isn't a diagnosis.
              </p>
              {loading.profile || !draft ? (
                <div className="flex flex-col gap-3" aria-label="Loading reading profile">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="choice-card" style={{ cursor: 'default' }}>
                      <Skeleton style={{ width: 20, height: 20, borderRadius: 999, marginTop: 2 }} />
                      <span style={{ flex: 1 }}>
                        <Skeleton style={{ width: i === 0 ? '72%' : '58%', height: 18 }} />
                        <Skeleton style={{ width: '92%', height: 15, marginTop: 8 }} />
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {READING_TYPES.map((type) => (
                    <label
                      key={type.value}
                      className="choice-card"
                      data-on={draft.profile_type === type.value}
                    >
                      <input
                        type="radio"
                        name="profile_type"
                        value={type.value}
                        checked={draft.profile_type === type.value}
                        onChange={() => set('profile_type', type.value as ProfileType)}
                      />
                      <span>
                        <span className="option-title">{type.title}</span>
                        <span className="option-desc">{type.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </Section>

            {/* Shape of the output */}
            {loading.profile || !draft ? (
              <Section title="How pages get rebuilt">
                <div className="flex flex-col gap-6" aria-label="Loading page rebuild settings">
                  <Skeleton style={{ width: '100%', height: 44 }} />
                  <Skeleton style={{ width: 260, height: 42 }} />
                  <Skeleton style={{ width: 220, height: 42 }} />
                  <Skeleton style={{ width: '100%', height: 96 }} />
                </div>
              </Section>
            ) : (
              <Section title="How pages get rebuilt">
                <div className="flex flex-col gap-6">
                  <label className="block">
                    <span className="field-label">Preferred format</span>
                    <select
                      className="field"
                      value={draft.preferred_format}
                      onChange={(e) => set('preferred_format', e.target.value as PreferredFormat)}
                    >
                      {FORMATS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label} — {f.hint}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div>
                    <span className="field-label">Chunk size</span>
                    <Segmented
                      ariaLabel="Chunk size"
                      value={draft.chunk_size}
                      options={CHUNK_SIZES}
                      onChange={(v) => set('chunk_size', v as ChunkSize)}
                    />
                    <span className="field-hint">How much text Synapse puts in one block.</span>
                  </div>

                  <div>
                    <span className="field-label">Nesting depth</span>
                    <Segmented
                      ariaLabel="Nesting depth"
                      value={draft.max_nesting_depth}
                      options={NESTING_DEPTHS}
                      onChange={(v) => set('max_nesting_depth', v as NestingDepth)}
                    />
                    <span className="field-hint">
                      {NESTING_DEPTHS.find((n) => n.value === draft.max_nesting_depth)?.hint}
                    </span>
                  </div>

                  <div>
                    <span className="field-label">Refinements</span>
                    <div className="flex flex-col gap-3">
                      {TOGGLES.map((t) => (
                        <label key={t.key} className="option-row" data-on={draft[t.key]}>
                          <input
                            type="checkbox"
                            checked={draft[t.key]}
                            onChange={(e) => set(t.key, e.target.checked)}
                          />
                          <span>
                            <span className="option-title">{t.title}</span>
                            <span className="option-desc">{t.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="block">
                    <span className="field-label">Anything else Synapse should know</span>
                    <textarea
                      className="field"
                      value={draft.notes}
                      maxLength={NOTES_MAX}
                      onChange={(e) => set('notes', e.target.value)}
                      placeholder="e.g. I lose focus after 3 nested points. I need concrete examples before abstract concepts. I have ADHD."
                    />
                    <span className="field-hint">
                      Passed to the model verbatim. {draft.notes.length} / {NOTES_MAX}
                    </span>
                  </label>
                </div>
              </Section>
            )}

            {/* History */}
            <Section title="Adjustments log">
              {loading.history ? (
                <ul className="flex flex-col gap-4" aria-label="Loading adjustment history">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <li key={i} className="p-4 rounded-lg" style={INSET}>
                      <div className="flex justify-between items-start gap-4 mb-2">
                        <Skeleton style={{ width: i === 0 ? '72%' : '56%', height: 18 }} />
                        <Skeleton style={{ width: 78, height: 14 }} />
                      </div>
                      <Skeleton style={{ width: '88%', height: 14, marginTop: 10 }} />
                    </li>
                  ))}
                </ul>
              ) : history.length > 0 ? (
                <>
                  <ul className="flex flex-col gap-4">
                    {(showAllHistory ? history : history.slice(0, 5)).map((entry, i) => (
                      <li key={i} className="p-4 rounded-lg" style={INSET}>
                        <div className="flex justify-between items-start gap-4 mb-2">
                          <p className="font-medium" style={{ color: '#1b1c1c' }}>
                            {entry.change_summary}
                          </p>
                          <span className="text-xs shrink-0" style={{ color: '#5e5f5b' }}>
                            {formatDate(entry.changed_at)}
                          </span>
                        </div>
                        <Diff previous={entry.previous_state} next={entry.new_state} />
                      </li>
                    ))}
                  </ul>
                  {history.length > 5 && (
                    <button
                      className="mt-4 text-sm font-semibold hover:underline"
                      style={{ color: '#004635', background: 'none', border: 0, padding: 0 }}
                      onClick={() => setShowAllHistory((v) => !v)}
                    >
                      {showAllHistory ? 'Show less' : `Show all ${history.length} changes`}
                    </button>
                  )}
                  {history.length >= HISTORY_LIMIT && (
                    <p className="field-hint mt-2">Showing your most recent {HISTORY_LIMIT} changes.</p>
                  )}
                </>
              ) : (
                <p className="text-sm italic" style={{ color: '#5e5f5b' }}>
                  No adjustments yet. Changes you make here, and the ones Synapse makes as it learns, will show up in this log.
                </p>
              )}
            </Section>
          </div>

          {/* ── RIGHT ─────────────────────────────────────────────── */}
          <div className="md:col-span-4 md:col-start-9 flex flex-col gap-10" style={{ minWidth: 0 }}>
            {loading.profile || !draft ? <PreviewSkeleton /> : <Preview fields={draft} />}

            {/* Plan & usage */}
            <section className="p-6 rounded-lg" style={SIDE_PANEL}>
              <h3 className="font-serif font-semibold text-2xl mb-4" style={{ color: '#1b1c1c' }}>
                Plan
              </h3>
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm" style={{ color: '#5e5f5b' }}>Current</span>
                <span
                  className="text-xs px-2 py-0.5 rounded font-semibold uppercase"
                  style={{ backgroundColor: tier === 'free' ? '#5e5f5b' : '#004635', color: '#fff' }}
                >
                  {loading.billing ? <Skeleton style={{ width: 72, height: 14 }} /> : PLAN_LABELS[tier] || tier}
                </span>
              </div>
              {loading.usage ? (
                <div aria-label="Loading usage">
                  <Skeleton style={{ width: '72%', height: 16 }} />
                  <Skeleton style={{ width: '100%', height: 8, marginTop: 14, borderRadius: 999 }} />
                </div>
              ) : usage && !usage.unlimited && usage.limit ? (
                <>
                  <div className="flex justify-between items-baseline mb-2">
                    <span className="text-sm" style={{ color: '#5e5f5b' }}>
                      {usage.limit_type === 'monthly' ? 'This month' : 'Today'}
                    </span>
                    <span className="text-sm font-semibold" style={{ color: '#1b1c1c' }}>
                      {usage.used} / {usage.limit}
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full overflow-hidden" style={{ backgroundColor: '#e4e2e1' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (usage.used / usage.limit) * 100)}%`,
                        backgroundColor: usage.used / usage.limit > 0.9 ? '#ba1a1a' : '#004635',
                      }}
                    />
                  </div>
                </>
              ) : usage?.unlimited ? (
                <p className="text-sm flex items-center gap-2" style={{ color: '#004635' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>all_inclusive</span>
                  Unlimited reformats
                </p>
              ) : null}
              <a
                href="/subscription"
                className="block w-full text-center rounded px-4 py-3 mt-4 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                style={{ ...PROFILE_ACTION, display: 'block' }}
              >
                Manage subscription
              </a>
            </section>

            {/* Data & privacy */}
            <section className="p-6 rounded-lg" style={SIDE_PANEL}>
              <h3 className="font-serif font-semibold text-2xl mb-2" style={{ color: '#1b1c1c' }}>
                Your data
              </h3>
              <p className="text-sm mb-4" style={{ color: '#5e5f5b', lineHeight: 1.6 }}>
                Your profile is yours. Take it to another device, or share it with a specialist.
              </p>
              <button
                className="w-full rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80 flex items-center justify-center gap-2"
                style={{ ...PROFILE_ACTION, display: 'flex' }}
                onClick={exportProfile}
                disabled={loading.profile}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                Export as JSON
              </button>

              <div className="mt-6 pt-4" style={{ borderTop: '1px solid #e4e2e1' }}>
                {!confirmingDelete ? (
                  <button
                    className="text-sm font-semibold hover:underline"
                    style={{ color: '#ba1a1a', background: 'none', border: 0, padding: 0 }}
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete my account
                  </button>
                ) : (
                  <div className="rounded-lg p-4" style={{ border: '2px solid #ba1a1a', backgroundColor: '#fcf9f8' }}>
                    <Eyebrow>This cannot be undone</Eyebrow>
                    <p className="text-sm mt-2 mb-3" style={{ color: '#1b1c1c', lineHeight: 1.6 }}>
                      Your profile, reading history and feedback are erased permanently. Any active
                      subscription is cancelled first.
                    </p>
                    <label className="block mb-3">
                      <span className="field-label">Type your email to confirm</span>
                      <input
                        type="text"
                        className="field"
                        value={deleteConfirmText}
                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                        placeholder={user?.email || ''}
                        autoComplete="off"
                      />
                    </label>
                    <div className="flex flex-col gap-2">
                      <button
                        className="w-full rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                        style={{
                          backgroundColor: '#ba1a1a',
                          color: '#fff',
                          border: '1px solid #ba1a1a',
                          boxSizing: 'border-box',
                          width: '100%',
                          maxWidth: '100%',
                          minWidth: 0,
                          opacity: deleteConfirmText.trim().toLowerCase() === user?.email?.toLowerCase() ? 1 : 0.5,
                        }}
                        onClick={handleDelete}
                        disabled={
                          busy === 'delete' ||
                          deleteConfirmText.trim().toLowerCase() !== user?.email?.toLowerCase()
                        }
                      >
                        {busy === 'delete' ? 'Deleting…' : 'Delete my account'}
                      </button>
                      <button
                        className="w-full rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                        style={PROFILE_ACTION}
                        onClick={() => {
                          setConfirmingDelete(false);
                          setDeleteConfirmText('');
                        }}
                      >
                        Keep my account
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>

        {/* Save bar — only present when there is something to save. */}
        {isDirty && (
          <div className="save-bar" role="region" aria-label="Unsaved changes">
            <span className="font-medium flex items-center gap-2" style={{ color: '#1b1c1c' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#8a4b24' }}>
                edit
              </span>
              {dirtyCount} unsaved {dirtyCount === 1 ? 'change' : 'changes'}
            </span>
            <div className="flex gap-3">
              <button
                className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                style={{ border: '1px solid #707974', color: '#5e5f5b', backgroundColor: 'transparent' }}
                onClick={discard}
                disabled={busy === 'save'}
              >
                Discard
              </button>
              <button
                className="rounded px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors hover:opacity-80"
                style={{ backgroundColor: '#004635', color: '#fff', border: '1px solid #004635' }}
                onClick={save}
                disabled={busy === 'save'}
              >
                {busy === 'save' ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        )}
      </main>
    </AppShell>
  );
}

/** Before → after rows for one history entry, showing only what moved. */
function Diff({
  previous,
  next,
}: {
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}) {
  const changed = Object.keys(FIELD_LABELS).filter((k) => previous?.[k] !== next?.[k]);
  if (changed.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1">
      {changed.map((field) => (
        <li key={field} className="flex items-center gap-2 text-sm flex-wrap">
          <span style={{ color: '#5e5f5b' }}>{FIELD_LABELS[field]}</span>
          <span style={{ color: '#5e5f5b', textDecoration: 'line-through' }}>
            {formatFieldValue(field, previous?.[field])}
          </span>
          <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#004635' }}>
            arrow_forward
          </span>
          <span className="font-semibold" style={{ color: '#004635' }}>
            {formatFieldValue(field, next?.[field])}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PreviewSkeleton() {
  return (
    <section className="p-6 rounded-lg" style={{ backgroundColor: '#fcf9f8', border: '1px solid #3d3d38' }}>
      <h3 className="font-serif font-semibold text-2xl mb-2" style={{ color: '#1b1c1c' }}>
        Preview
      </h3>
      <Skeleton style={{ width: '70%', height: 17, marginBottom: 22 }} />
      <div className="rounded-lg p-4 flex flex-col gap-3" style={{ backgroundColor: '#f6f3f2', border: '1px solid #bfc9c3' }}>
        <Skeleton style={{ width: '55%', height: 10, borderRadius: 2 }} />
        <Skeleton style={{ width: 112, height: 30 }} />
        <Skeleton style={{ width: '88%', height: 8, borderRadius: 999 }} />
        <Skeleton style={{ width: '81%', height: 8, borderRadius: 999 }} />
        <Skeleton style={{ width: '74%', height: 8, borderRadius: 999 }} />
        <Skeleton style={{ width: 136, height: 16, marginTop: 4 }} />
      </div>
      <Skeleton style={{ width: '62%', height: 14, marginTop: 14 }} />
    </section>
  );
}

/**
 * A mock of a reformatted section that reacts to the current (unsaved)
 * settings. These options are abstract — seeing the shape they produce is the
 * difference between guessing and choosing.
 */
function Preview({ fields }: { fields: ProfileFields }) {
  const lines = fields.chunk_size === 'short' ? 2 : fields.chunk_size === 'medium' ? 3 : 5;
  const isList = fields.preferred_format === 'bullet points' || fields.preferred_format === 'numbered steps';
  const numbered = fields.preferred_format === 'numbered steps';

  const bar = (width: string, indent = 0) => (
    <div
      style={{
        height: 8,
        width,
        marginLeft: indent * 14,
        borderRadius: 999,
        backgroundColor: indent > 0 ? '#c8c6c0' : '#bfc9c3',
      }}
    />
  );

  return (
    <section className="p-6 rounded-lg" style={{ backgroundColor: '#fcf9f8', border: '1px solid #3d3d38' }}>
      <h3 className="font-serif font-semibold text-2xl mb-2" style={{ color: '#1b1c1c' }}>
        Preview
      </h3>
      <p className="text-sm mb-4" style={{ color: '#5e5f5b' }}>
        Roughly how a section will be rebuilt.
      </p>

      <div className="rounded-lg p-4 flex flex-col gap-3" style={{ backgroundColor: '#f6f3f2', border: '1px solid #bfc9c3' }}>
        {fields.use_headers && (
          <div style={{ height: 10, width: '55%', borderRadius: 2, backgroundColor: '#004635' }} />
        )}

        {fields.needs_examples_first && (
          <div
            className="rounded px-2 py-1 text-xs font-semibold self-start"
            style={{ backgroundColor: '#aef0d7', color: '#004635' }}
          >
            Example first
          </div>
        )}

        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            {isList && (
              <span className="shrink-0 text-xs font-semibold" style={{ color: '#004635', width: 12 }}>
                {numbered ? `${i + 1}.` : '•'}
              </span>
            )}
            {bar(`${88 - i * 7}%`)}
          </div>
        ))}

        {fields.max_nesting_depth >= 2 && isList && (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs" style={{ color: '#707974', width: 12, marginLeft: 14 }}>◦</span>
            {bar('62%')}
          </div>
        )}
        {fields.max_nesting_depth >= 3 && isList && (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs" style={{ color: '#707974', width: 12, marginLeft: 28 }}>▪</span>
            {bar('48%')}
          </div>
        )}

        {fields.simplify_vocab && (
          <div className="flex items-center gap-1 text-xs mt-1" style={{ color: '#5e5f5b' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#004635' }}>translate</span>
            Plainer wording
          </div>
        )}
      </div>

      <p className="field-hint mt-3">
        {PROFILE_TYPE_LABELS[fields.profile_type]} · {fields.chunk_size} chunks ·{' '}
        {fields.max_nesting_depth === 1 ? 'flat' : `${fields.max_nesting_depth} levels`}
      </p>
    </section>
  );
}
