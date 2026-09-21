import { ArrowLeft, ArrowRight, Eye, EyeOff, LogIn } from 'lucide-react';
import { FormEvent, useMemo, useState, useEffect } from 'react';
import {
  signIn,
  signUp,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  exchangeOAuthCode,
  startGoogleLogin,
  AuthError,
} from './lib/auth';
import ConfigBanner from './component/ConfigBanner';
import useToast from './lib/useToast';
import { BrandLockup } from './component/Brand';

// 'verify' and 'new-password' are landing states reached from an emailed
// link, not tabs the user can click. Supabase hosted both of those pages for
// us; they now live here.
type AuthTab = 'login' | 'signup' | 'reset' | 'verify' | 'new-password';

type VisiblePasswords = Record<'signup' | 'confirm' | 'login', boolean>;

/**
 * Where to land after signing in. Callers pass ?next= to preserve intent —
 * e.g. /billing?plan=premium when the upgrade flow bounced them here.
 * Only same-origin relative paths are honoured, so this can not become an
 * open redirect.
 */
function getNextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/dashboard";
}

function getInitialTab(): AuthTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  if (tab === 'login') return 'login';
  if (tab === 'reset') return 'reset';
  if (tab === 'verify') return 'verify';
  if (tab === 'new-password') return 'new-password';
  return 'signup';
}

function getParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/** Strips one-shot params so a refresh cannot replay a spent token or code. */
function scrubUrl() {
  window.history.replaceState(null, '', '/auth?tab=login');
}

/** Human-readable reasons the Google callback can bounce someone back here. */
const OAUTH_ERRORS: Record<string, string> = {
  oauth_state:
    'That sign-in link could not be verified. Please try signing in again.',
  oauth_denied: 'Google sign-in was cancelled.',
  oauth_unverified:
    "Your Google account's email address is not verified, so we can't use it to sign in.",
  oauth_identity: 'We could not verify your Google identity. Please try again.',
  oauth_exchange: 'Google sign-in did not complete. Please try again.',
  oauth_unconfigured: 'Google sign-in is not available right now.',
  oauth_unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  oauth_failed: 'Something went wrong during Google sign-in. Please try again.',
};

function PasswordToggle({
  isVisible,
  onClick,
}: {
  isVisible: boolean;
  onClick: () => void;
}) {
  const Icon = isVisible ? EyeOff : Eye;

  return (
    <button className="auth-password-toggle" type="button" onClick={onClick} aria-label={isVisible ? 'Hide password' : 'Show password'}>
      <Icon className="app-icon" aria-hidden="true" />
    </button>
  );
}

function AuthPage() {
  const { showToast, ToastContainer } = useToast();
  const [activeTab, setActiveTab] = useState<AuthTab>(getInitialTab);
  const [visiblePasswords, setVisiblePasswords] = useState<VisiblePasswords>({
    signup: false,
    confirm: false,
    login: false,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // Set when a signup or an unverified login tells us which address is
  // awaiting confirmation, so "resend" has something to send to.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  // Handles the three ways a user can arrive here mid-flow: back from the
  // Google callback, from a verification email, or from a reset email.
  //
  // Sign-in used to be driven by supabase's onAuthStateChange, which fired for
  // every one of these. A token model has no such global event, so each entry
  // point is handled explicitly — which also removes the "why didn't my
  // redirect fire" class of bug the old indirection created.
  useEffect(() => {
    const oauthError = getParam('error');
    if (oauthError) {
      showToast(OAUTH_ERRORS[oauthError] || 'Sign-in failed. Please try again.', 'error');
      scrubUrl();
      setActiveTab('login');
      return;
    }

    const code = getParam('code');
    if (code) {
      setIsLoading(true);
      exchangeOAuthCode(code)
        .then(() => {
          // Scrub before navigating so the one-time code never lands in
          // history, where a back-button press would replay a spent value.
          window.history.replaceState(null, '', '/auth');
          window.location.href = getNextPath();
        })
        .catch((err: any) => {
          showToast(err?.message || 'Could not complete Google sign-in.', 'error');
          scrubUrl();
          setIsLoading(false);
        });
      return;
    }

    const token = getParam('token');
    if (token && getInitialTab() === 'verify') {
      setIsLoading(true);
      verifyEmail(token)
        .then(() => {
          showToast('Email confirmed. Welcome to Synapse.', 'success');
          window.location.href = getNextPath();
        })
        .catch((err: any) => {
          showToast(err?.message || 'This link is no longer valid.', 'error');
          setActiveTab('login');
          setIsLoading(false);
        });
    }
  }, []);

  const copy = useMemo(() => {
    if (activeTab === 'signup') {
      return {
        title: 'Join the cognitive edge.',
        body: 'Create your account to start building your profile.',
      };
    }
    if (activeTab === 'reset') {
      return {
        title: 'Reset your password.',
        body: "Enter your email address and we'll send you a link to reset your password.",
      };
    }
    if (activeTab === 'new-password') {
      return {
        title: 'Choose a new password.',
        body: 'Pick something you have not used here before.',
      };
    }
    if (activeTab === 'verify') {
      // The heading has to agree with the body below it: without a token there
      // is nothing to confirm, and promising "one moment" would be a lie.
      return getParam('token')
        ? {
            title: 'Confirming your email.',
            body: 'One moment while we finish setting up your account.',
          }
        : {
            title: 'That link looks incomplete.',
            body: 'We could not read a confirmation code from this link.',
          };
    }
    return {
      title: 'Welcome back.',
      body: 'Access your portable cognitive identity.',
    };
  }, [activeTab]);

  // Only login and signup are things you navigate to. reset, verify and
  // new-password are arrived at, so they get no tab strip and no Google button.
  const isTabbed = activeTab === 'login' || activeTab === 'signup';

  function switchTab(tab: AuthTab) {
    setActiveTab(tab);
    window.history.replaceState(null, '', `/auth?tab=${tab}`);
  }

  function togglePassword(key: keyof VisiblePasswords) {
    setVisiblePasswords((current) => ({ ...current, [key]: !current[key] }));
  }

  function handleGoogleLogin() {
    setIsLoading(true);
    showToast('Redirecting to Google...', 'info');
    // A full-page navigation, not a fetch: the browser has to accept the
    // backend's HttpOnly state cookie and then follow a cross-origin redirect.
    // Google will not serve its consent screen to XHR.
    startGoogleLogin(getNextPath());
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuccessMessage(null);
    setIsLoading(true);

    const formData = new FormData(event.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;
    const name = formData.get('name') as string;
    const passwordConfirm = formData.get('passwordConfirm') as string;

    try {
      if (activeTab === 'signup') {
        if (password !== passwordConfirm) {
          throw new Error('Passwords do not match');
        }
        showToast('Creating account...', 'info');
        await signUp(email, password, name);
        // No session yet by design — the address has to be confirmed before
        // the account can sign in, so free AI usage cannot be farmed with
        // throwaway addresses.
        setPendingEmail(email);
        setSuccessMessage('Check your email for a link to confirm your address.');
        showToast('Check your email to confirm.', 'success');
        setIsLoading(false);
      } else if (activeTab === 'login') {
        showToast('Logging in...', 'info');
        await signIn(email, password);
        // Redirect explicitly rather than waiting on a global auth event.
        window.location.href = getNextPath();
      } else if (activeTab === 'reset') {
        showToast('Sending reset link...', 'info');
        await forgotPassword(email);
        // Deliberately identical whether or not the address exists — the
        // backend always answers 202 for the same reason.
        setSuccessMessage('If that address has an account, a reset link is on its way.');
        showToast('Reset link sent!', 'success');
        setIsLoading(false);
      } else if (activeTab === 'new-password') {
        const token = getParam('token');
        if (!token) throw new Error('This reset link is incomplete.');
        if (password !== passwordConfirm) {
          throw new Error('Passwords do not match');
        }
        showToast('Updating password...', 'info');
        await resetPassword(token, password);
        window.history.replaceState(null, '', '/auth');
        window.location.href = getNextPath();
      }
    } catch (err: any) {
      // An unverified account gets an actionable path rather than a dead end.
      if (err instanceof AuthError && err.code === 'email_not_verified') {
        setPendingEmail(email);
        showToast(err.message, 'error');
        setIsLoading(false);
        return;
      }
      showToast(err?.message || 'Authentication failed', 'error');
      setIsLoading(false);
    }
  }

  async function handleResend() {
    if (!pendingEmail) return;
    try {
      await resendVerification(pendingEmail);
      showToast('Confirmation email sent.', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not resend the email.', 'error');
    }
  }

  return (
    <>
      <ConfigBanner />
      <ToastContainer />
      <main className="auth-page">
      <BrandLockup href="/" height={34} className="auth-brand" label="Back to Synapse home" />
      <a className="auth-back" href="/">
        <ArrowLeft className="app-icon" aria-hidden="true" />
        Back to home
      </a>

      <section className="auth-shell offset-shadow" aria-labelledby="auth-title">
        {isTabbed && (
          <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
            <button className={activeTab === 'signup' ? 'active' : ''} type="button" onClick={() => switchTab('signup')}>
              Sign Up
            </button>
            <button className={activeTab === 'login' ? 'active' : ''} type="button" onClick={() => switchTab('login')}>
              Login
            </button>
          </div>
        )}

        <div className="auth-content">
          <div className="auth-heading">
            <h1 id="auth-title">
              {successMessage ? 'Success!' : copy.title}
            </h1>
            <p>{successMessage || copy.body}</p>
          </div>

          {successMessage ? (
             <div className="auth-success-state">
                {pendingEmail && (
                  <button className="button button-primary" type="button" onClick={handleResend}>
                    Resend confirmation email
                  </button>
                )}
                <button className="button button-secondary" onClick={() => { setSuccessMessage(null); setPendingEmail(null); setActiveTab('login'); }}>
                  Return to Login
                </button>
             </div>
          ) : activeTab === 'verify' ? (
            <div className="auth-success-state">
              {getParam('token') ? (
                // The heading and subtitle above already say what is happening,
                // so repeating it here was pure duplication.
                <p className="auth-busy" role="status">Confirming your email address…</p>
              ) : (
                // Reachable by editing the URL or following a truncated link.
                // Previously this sat on "Confirming…" forever, because the
                // effect that verifies only fires when a token is present.
                <>
                  <p className="field-hint">
                    Sign in to have a new confirmation email sent.
                  </p>
                  <button className="button button-secondary" onClick={() => switchTab('login')}>
                    Return to Login
                  </button>
                </>
              )}
            </div>
          ) : activeTab === 'new-password' ? (
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>
                <span>New password</span>
                <div className="auth-input-wrap">
                  <input
                    className="auth-input"
                    id="password-new"
                    name="password"
                    type={visiblePasswords.signup ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={10}
                    required
                  />
                  <PasswordToggle isVisible={visiblePasswords.signup} onClick={() => togglePassword('signup')} />
                </div>
              </label>
              <label>
                <span>Confirm new password</span>
                <div className="auth-input-wrap">
                  <input
                    className="auth-input"
                    id="password-new-confirm"
                    name="passwordConfirm"
                    type={visiblePasswords.confirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={10}
                    required
                  />
                  <PasswordToggle isVisible={visiblePasswords.confirm} onClick={() => togglePassword('confirm')} />
                </div>
              </label>
              <button className="button button-primary auth-submit" type="submit" disabled={isLoading}>
                Set new password
              </button>
            </form>
          ) : activeTab === 'reset' ? (
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>
                <span>Email Address</span>
                <input className="auth-input" id="email-reset" name="email" type="email" autoComplete="email" placeholder="name@example.com" required />
              </label>
              <button
                className="button button-primary auth-submit"
                type="submit"
                disabled={isLoading}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
              >
                Send Reset Link
                <ArrowRight className="app-icon" aria-hidden="true" />
              </button>
              <div className="auth-reset-back">
                <button type="button" onClick={() => switchTab('login')}>
                  <ArrowLeft className="app-icon" aria-hidden="true" />
                  Back to Login
                </button>
              </div>
            </form>
          ) : activeTab === 'signup' ? (
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>
                <span>Name</span>
                <input className="auth-input" id="name" name="name" type="text" autoComplete="name" required />
              </label>
              <label>
                <span>Email</span>
                <input className="auth-input" id="email-signup" name="email" type="email" autoComplete="email" required />
              </label>
              <div className="auth-field-row">
                <label>
                  <span>Password</span>
                  <div className="auth-input-wrap">
                    <input
                      className="auth-input"
                      id="password-signup"
                      name="password"
                      type={visiblePasswords.signup ? 'text' : 'password'}
                      autoComplete="new-password"
                      required
                    />
                    <PasswordToggle isVisible={visiblePasswords.signup} onClick={() => togglePassword('signup')} />
                  </div>
                </label>
                <label>
                  <span>Confirm Password</span>
                  <div className="auth-input-wrap">
                    <input
                      className="auth-input"
                      id="password-confirm"
                      name="passwordConfirm"
                      type={visiblePasswords.confirm ? 'text' : 'password'}
                      autoComplete="new-password"
                      required
                    />
                    <PasswordToggle isVisible={visiblePasswords.confirm} onClick={() => togglePassword('confirm')} />
                  </div>
                </label>
              </div>
              <button className="button button-primary auth-submit" type="submit" disabled={isLoading}>
                Create Account
              </button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>
                <span>Email</span>
                <input className="auth-input" id="email-login" name="email" type="email" autoComplete="email" required />
              </label>
              <label>
                <span className="auth-label-row">
                  Password
                  <button type="button" className="auth-link-button" onClick={() => switchTab('reset')}>
                    Forgot?
                  </button>
                </span>
                <div className="auth-input-wrap">
                  <input
                    className="auth-input"
                    id="password-login"
                    name="password"
                    type={visiblePasswords.login ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                  />
                  <PasswordToggle isVisible={visiblePasswords.login} onClick={() => togglePassword('login')} />
                </div>
              </label>
              <button className="button button-primary auth-submit" type="submit" disabled={isLoading}>
                Login
              </button>
              {pendingEmail && (
                <button type="button" className="auth-link-button" onClick={handleResend}>
                  Resend confirmation email
                </button>
              )}
            </form>
          )}

          {isTabbed && !successMessage && (
            <>
              <div className="auth-divider">
                <span />
                <b>OR</b>
                <span />
              </div>

              <button 
                className="auth-google" 
                type="button" 
                onClick={handleGoogleLogin}
                disabled={isLoading}
              >
                <LogIn className="app-icon" aria-hidden="true" />
                {activeTab === 'signup' ? 'Sign up with Google' : 'Sign in with Google'}
              </button>
            </>
          )}
        </div>
      </section>
    </main>
    </>
  );
}

export default AuthPage;
