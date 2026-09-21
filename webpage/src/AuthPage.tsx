import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AuthError,
  exchangeOAuthCode,
  forgotPassword,
  resendVerification,
  resetPassword,
  signIn,
  signUp,
  startGoogleLogin,
  verifyEmail,
} from './lib/auth';
import ConfigBanner from './component/ConfigBanner';
import useToast from './lib/useToast';
import { BrandLockup } from './component/Brand';
import {
  BrandPanel,
  Busy,
  Field,
  FormError,
  GoogleButton,
  OrDivider,
  PasswordField,
  SubmitButton,
} from './component/AuthParts';

/**
 * /auth — every way in and out of an account.
 *
 * `login`, `signup` and `reset` are screens you navigate to. `verify` and
 * `new-password` are landed on from an emailed link, and `check-email` is shown
 * after a request that can only finish in the inbox. Each maps to one screen
 * component below; the page only owns routing, the URL, and the entry effects.
 */
type Mode = 'login' | 'signup' | 'reset' | 'new-password' | 'verify' | 'check-email';

/** Mirrors the backend's RegisterRequest / PasswordResetRequest bounds. */
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;
const PASSWORD_HINT = `At least ${PASSWORD_MIN} characters.`;

// ── URL helpers ───────────────────────────────────────────────────

function getParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * Where to land after signing in. Callers pass ?next= to preserve intent —
 * e.g. /billing?plan=premium when the upgrade flow bounced them here.
 * Only same-origin relative paths are honoured, so this can not become an
 * open redirect.
 */
function getNextPath(): string {
  const next = getParam('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/dashboard';
}

function getInitialMode(): Mode {
  const tab = getParam('tab');
  if (tab === 'login' || tab === 'reset' || tab === 'verify' || tab === 'new-password') return tab;
  return 'signup';
}

/** The /auth URL for a mode, carrying ?next= along so intent survives a mode switch. */
function urlFor(mode: Mode): string {
  // check-email has no URL of its own: a refresh there should land on login,
  // not on a "we sent you something" screen with nothing behind it.
  const params = new URLSearchParams({ tab: mode === 'check-email' ? 'login' : mode });
  const next = getParam('next');
  if (next) params.set('next', next);
  return `/auth?${params}`;
}

/** Strips one-shot params so a refresh cannot replay a spent token or code. */
function scrubUrl() {
  window.history.replaceState(null, '', urlFor('login'));
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Human-readable reasons the Google callback can bounce someone back here. */
const OAUTH_ERRORS: Record<string, string> = {
  oauth_state: 'That sign-in link could not be verified. Please try signing in again.',
  oauth_denied: 'Google sign-in was cancelled.',
  oauth_unverified: "Your Google account's email address is not verified, so we can't use it to sign in.",
  oauth_identity: 'We could not verify your Google identity. Please try again.',
  oauth_exchange: 'Google sign-in did not complete. Please try again.',
  oauth_unconfigured: 'Google sign-in is not available right now.',
  oauth_unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  oauth_failed: 'Something went wrong during Google sign-in. Please try again.',
};

// ── Form state ────────────────────────────────────────────────────

/**
 * Busy + error for one form. `busy` is only cleared on failure: a success
 * either navigates away or unmounts the form, and leaving the button disabled
 * until then stops a second submit racing the redirect.
 */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<void>, fallback: string) {
    setError(null);
    setBusy(true);
    try {
      await task();
    } catch (err) {
      setError(messageOf(err, fallback));
      setBusy(false);
    }
  }

  return { busy, error, run };
}

function fields(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  return (name: string) => String(data.get(name) ?? '');
}

// ── Screens ───────────────────────────────────────────────────────

type Go = (mode: Mode) => void;

function LoginForm({ go, onResend }: { go: Go; onResend: (email: string) => void }) {
  const { busy, error, run } = useSubmit();
  // Set when the server says the account exists but is unconfirmed, so the
  // error comes with a way out instead of a dead end.
  const [unverified, setUnverified] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    const get = fields(event);
    const email = get('email');
    setUnverified(null);
    run(async () => {
      try {
        await signIn(email, get('password'));
      } catch (err) {
        if (err instanceof AuthError && err.code === 'email_not_verified') setUnverified(email);
        throw err;
      }
      window.location.href = getNextPath();
    }, 'Could not sign you in. Please try again.');
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <Field label="Email" name="email" type="email" autoComplete="email" required disabled={busy} />
      <PasswordField
        label="Password"
        name="password"
        autoComplete="current-password"
        required
        disabled={busy}
        action={
          <button type="button" className="auth-inline-link" onClick={() => go('reset')}>
            Forgot password?
          </button>
        }
      />
      {error && (
        <FormError>
          {error}
          {unverified && (
            <button type="button" className="auth-inline-link" onClick={() => onResend(unverified)}>
              Resend confirmation email
            </button>
          )}
        </FormError>
      )}
      <SubmitButton busy={busy} busyLabel="Signing in…">
        Log in
      </SubmitButton>
    </form>
  );
}

function SignupForm({ onCreated }: { onCreated: (email: string) => void }) {
  const { busy, error, run } = useSubmit();

  function submit(event: FormEvent<HTMLFormElement>) {
    const get = fields(event);
    const email = get('email');
    run(async () => {
      if (get('password') !== get('passwordConfirm')) throw new Error('Those passwords do not match.');
      // No session comes back by design: the address has to be confirmed
      // before the account can sign in, so free AI usage cannot be farmed with
      // throwaway addresses.
      await signUp(email, get('password'), get('name').trim() || undefined);
      onCreated(email);
    }, 'Could not create your account. Please try again.');
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <Field label="Name" name="name" type="text" autoComplete="name" maxLength={80} required disabled={busy} />
      <Field label="Email" name="email" type="email" autoComplete="email" required disabled={busy} />
      <div className="auth-field-row">
        <PasswordField
          label="Password"
          name="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          hint={PASSWORD_HINT}
          required
          disabled={busy}
        />
        <PasswordField
          label="Confirm password"
          name="passwordConfirm"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          required
          disabled={busy}
        />
      </div>
      {error && <FormError>{error}</FormError>}
      <SubmitButton busy={busy} busyLabel="Creating account…">
        Create account
      </SubmitButton>
    </form>
  );
}

function ResetForm({ onSent }: { onSent: (email: string) => void }) {
  const { busy, error, run } = useSubmit();

  function submit(event: FormEvent<HTMLFormElement>) {
    const get = fields(event);
    const email = get('email');
    run(async () => {
      await forgotPassword(email);
      onSent(email);
    }, 'Could not send a reset link. Please try again.');
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="name@example.com"
        required
        disabled={busy}
      />
      {error && <FormError>{error}</FormError>}
      <SubmitButton busy={busy} busyLabel="Sending link…">
        Send reset link
      </SubmitButton>
    </form>
  );
}

function NewPasswordForm({ go }: { go: Go }) {
  const { busy, error, run } = useSubmit();
  const token = getParam('token');

  if (!token) {
    return (
      <div className="auth-stack">
        <FormError>This reset link is incomplete. Request a new one and use the link in that email.</FormError>
        <button className="button button-secondary" type="button" onClick={() => go('reset')}>
          Request a new link
        </button>
      </div>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    const get = fields(event);
    run(async () => {
      if (get('password') !== get('passwordConfirm')) throw new Error('Those passwords do not match.');
      await resetPassword(token!, get('password'));
      window.history.replaceState(null, '', '/auth');
      window.location.href = getNextPath();
    }, 'Could not update your password. Please try again.');
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-field-row">
        <PasswordField
          label="New password"
          name="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          hint={PASSWORD_HINT}
          required
          disabled={busy}
        />
        <PasswordField
          label="Confirm password"
          name="passwordConfirm"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          required
          disabled={busy}
        />
      </div>
      {error && <FormError>{error}</FormError>}
      <SubmitButton busy={busy} busyLabel="Saving…">
        Set new password
      </SubmitButton>
    </form>
  );
}

function VerifyState({ go }: { go: Go }) {
  if (getParam('token')) return <Busy>Confirming your email address…</Busy>;

  // Reachable by editing the URL or following a truncated link. The entry
  // effect only verifies when a token is present, so without this branch the
  // screen would spin forever.
  return (
    <div className="auth-stack">
      <p className="auth-note">Log in and we'll send you a fresh confirmation email.</p>
      <button className="button button-secondary" type="button" onClick={() => go('login')}>
        Go to log in
      </button>
    </div>
  );
}

function CheckEmailState({
  kind,
  email,
  onResend,
}: {
  kind: 'verify' | 'reset';
  email: string;
  onResend: (email: string) => void;
}) {
  return (
    <div className="auth-stack">
      <div className="auth-sent">
        <span>Sent to</span>
        <strong>{email}</strong>
      </div>
      <p className="auth-note">
        {kind === 'verify'
          ? 'Open the link in that email to finish setting up. It can take a minute to arrive — check spam if it does not.'
          : 'The link expires soon, so use it shortly. If nothing arrives, check spam or try another address.'}
      </p>
      {kind === 'verify' && (
        <button className="button button-secondary" type="button" onClick={() => onResend(email)}>
          Resend confirmation email
        </button>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

function AuthPage() {
  const { showToast, ToastContainer } = useToast();
  const [mode, setMode] = useState<Mode>(getInitialMode);
  // The address a check-email screen is talking about, and why.
  const [sent, setSent] = useState<{ email: string; kind: 'verify' | 'reset' } | null>(null);
  // True while trading the Google handoff code, which replaces the form.
  const [finishingGoogle, setFinishingGoogle] = useState(() => Boolean(getParam('code')));
  const [googleBusy, setGoogleBusy] = useState(false);

  // StrictMode runs effects twice in development. Both the Google code and
  // the verification token are single-use on the server, so the second run
  // would fail and flash an error over a sign-in that actually succeeded.
  const entryHandled = useRef(false);

  // The three ways to arrive mid-flow: back from the Google callback, from a
  // verification email, or with an OAuth error.
  useEffect(() => {
    if (entryHandled.current) return;
    entryHandled.current = true;

    const oauthError = getParam('error');
    if (oauthError) {
      showToast(OAUTH_ERRORS[oauthError] || 'Sign-in failed. Please try again.', 'error', 5000);
      scrubUrl();
      setMode('login');
      return;
    }

    const code = getParam('code');
    if (code) {
      exchangeOAuthCode(code)
        .then(() => {
          // Scrub before navigating so the one-time code never lands in
          // history, where a back-button press would replay a spent value.
          window.history.replaceState(null, '', '/auth');
          window.location.href = getNextPath();
        })
        .catch((err) => {
          showToast(messageOf(err, 'Could not complete Google sign-in.'), 'error', 5000);
          scrubUrl();
          setMode('login');
          setFinishingGoogle(false);
        });
      return;
    }

    const token = getParam('token');
    if (token && getInitialMode() === 'verify') {
      verifyEmail(token)
        .then(() => {
          showToast('Email confirmed. Welcome to Synapse.', 'success');
          window.location.href = getNextPath();
        })
        .catch((err) => {
          showToast(messageOf(err, 'This link is no longer valid.'), 'error', 5000);
          scrubUrl();
          setMode('login');
        });
    }
  }, []);

  function go(next: Mode) {
    setMode(next);
    window.history.replaceState(null, '', urlFor(next));
  }

  function showSent(email: string, kind: 'verify' | 'reset') {
    setSent({ email, kind });
    go('check-email');
  }

  async function handleResend(email: string) {
    try {
      await resendVerification(email);
      showToast('Confirmation email sent.', 'success');
    } catch (err) {
      showToast(messageOf(err, 'Could not resend the email.'), 'error');
    }
  }

  function handleGoogle() {
    setGoogleBusy(true);
    showToast('Redirecting to Google…', 'info');
    // A full-page navigation, not a fetch: the browser has to accept the
    // backend's HttpOnly state cookie and then follow a cross-origin redirect.
    startGoogleLogin(getNextPath());
  }

  const heading = finishingGoogle
    ? { eyebrow: 'Google sign-in', title: 'Signing you in.', body: 'One moment while we finish up.' }
    : headingFor(mode, sent);

  const showGoogle = !finishingGoogle && (mode === 'login' || mode === 'signup');

  let screen: ReactNode = null;
  if (finishingGoogle) {
    screen = <Busy>Finishing Google sign-in…</Busy>;
  } else if (mode === 'login') {
    screen = <LoginForm go={go} onResend={handleResend} />;
  } else if (mode === 'signup') {
    screen = <SignupForm onCreated={(email) => showSent(email, 'verify')} />;
  } else if (mode === 'reset') {
    screen = <ResetForm onSent={(email) => showSent(email, 'reset')} />;
  } else if (mode === 'new-password') {
    screen = <NewPasswordForm go={go} />;
  } else if (mode === 'verify') {
    screen = <VerifyState go={go} />;
  } else if (sent) {
    screen = <CheckEmailState kind={sent.kind} email={sent.email} onResend={handleResend} />;
  }

  return (
    <>
      <ConfigBanner />
      <ToastContainer />
      <main className="auth">
        <BrandPanel />

        <div className="auth-main">
          <header className="auth-topbar">
            {/* <BrandLockup href="/" height={28} className="auth-topbar-brand" label="Back to Synapse home" /> */}
            <a className="auth-back" href="/">
              <ArrowLeft className="app-icon" aria-hidden="true" />
              Back to home
            </a>
          </header>

          <section className="auth-panel" aria-labelledby="auth-title">
            <div className="auth-heading">
              <span className="auth-eyebrow">{heading.eyebrow}</span>
              <h1 id="auth-title">{heading.title}</h1>
              <p>{heading.body}</p>
            </div>

            {screen}

            {showGoogle && (
              <>
                <OrDivider />
                <GoogleButton onClick={handleGoogle} disabled={googleBusy}>
                  {mode === 'signup' ? 'Sign up with Google' : 'Continue with Google'}
                </GoogleButton>
              </>
            )}

            {!finishingGoogle && (
              <p className="auth-switch">
                {mode === 'login' ? (
                  <>
                    New to Synapse?{' '}
                    <button type="button" onClick={() => go('signup')}>
                      Create an account
                    </button>
                  </>
                ) : mode === 'signup' ? (
                  <>
                    Already have an account?{' '}
                    <button type="button" onClick={() => go('login')}>
                      Log in
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => go('login')}>
                    <ArrowLeft className="app-icon" aria-hidden="true" />
                    Back to log in
                  </button>
                )}
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

function headingFor(mode: Mode, sent: { email: string; kind: 'verify' | 'reset' } | null) {
  switch (mode) {
    case 'login':
      return { eyebrow: 'Welcome back', title: 'Log in to Synapse.', body: 'Pick up where your reading profile left off.' };
    case 'signup':
      return {
        eyebrow: 'Get started',
        title: 'Create your account.',
        body: 'Build a reading profile that follows you across the web.',
      };
    case 'reset':
      return {
        eyebrow: 'Password help',
        title: 'Reset your password.',
        body: "Enter your account's email and we'll send you a link to choose a new one.",
      };
    case 'new-password':
      return {
        eyebrow: 'Password help',
        title: 'Choose a new password.',
        body: "Pick something you haven't used here before. You'll be signed in right after.",
      };
    case 'verify':
      // The heading has to agree with the body: without a token there is
      // nothing to confirm, and promising "one moment" would be a lie.
      return getParam('token')
        ? { eyebrow: 'Confirm email', title: 'Confirming your email.', body: 'One moment while we finish setting up your account.' }
        : { eyebrow: 'Confirm email', title: 'That link looks incomplete.', body: 'We could not read a confirmation code from it.' };
    case 'check-email':
      return sent?.kind === 'reset'
        ? { eyebrow: 'Check your inbox', title: 'Check your email.', body: 'If that address has an account, a reset link is on its way.' }
        : { eyebrow: 'Check your inbox', title: 'Confirm your email.', body: 'We sent you a link to confirm your address.' };
  }
}

export default AuthPage;
