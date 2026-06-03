import { ArrowLeft, ArrowRight, Eye, EyeOff, LogIn } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';

type AuthTab = 'signup' | 'login' | 'reset';
type VisiblePasswords = Record<'signup' | 'confirm' | 'login', boolean>;

function getInitialTab(): AuthTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  if (tab === 'login') return 'login';
  if (tab === 'reset') return 'reset';
  return 'signup';
}

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
  const [activeTab, setActiveTab] = useState<AuthTab>(getInitialTab);
  const [visiblePasswords, setVisiblePasswords] = useState<VisiblePasswords>({
    signup: false,
    confirm: false,
    login: false,
  });

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
    return {
      title: 'Welcome back.',
      body: 'Access your portable cognitive identity.',
    };
  }, [activeTab]);

  function switchTab(tab: AuthTab) {
    setActiveTab(tab);
    window.history.replaceState(null, '', `/auth?tab=${tab}`);
  }

  function togglePassword(key: keyof VisiblePasswords) {
    setVisiblePasswords((current) => ({ ...current, [key]: !current[key] }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
  }

  return (
    <main className="auth-page">
      <a className="auth-brand brand" href="/" aria-label="Back to Synapse home">
        Synapse
      </a>
      <a className="auth-back" href="/">
        <ArrowLeft className="app-icon" aria-hidden="true" />
        Back to home
      </a>

      <section className="auth-shell offset-shadow" aria-labelledby="auth-title">
        {activeTab !== 'reset' && (
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
            <h1 id="auth-title">{copy.title}</h1>
            <p>{copy.body}</p>
          </div>

          {activeTab === 'reset' ? (
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>
                <span>Email Address</span>
                <input id="email-reset" name="email" type="email" autoComplete="email" placeholder="name@example.com" required />
              </label>
              <button
                className="button button-primary auth-submit"
                type="submit"
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
                <input id="name" name="name" type="text" autoComplete="name" />
              </label>
              <label>
                <span>Email</span>
                <input id="email-signup" name="email" type="email" autoComplete="email" />
              </label>
              <div className="auth-field-row">
                <label>
                  <span>Password</span>
                  <div className="auth-input-wrap">
                    <input
                      id="password-signup"
                      name="password"
                      type={visiblePasswords.signup ? 'text' : 'password'}
                      autoComplete="new-password"
                    />
                    <PasswordToggle isVisible={visiblePasswords.signup} onClick={() => togglePassword('signup')} />
                  </div>
                </label>
                <label>
                  <span>Confirm Password</span>
                  <div className="auth-input-wrap">
                    <input
                      id="password-confirm"
                      name="passwordConfirm"
                      type={visiblePasswords.confirm ? 'text' : 'password'}
                      autoComplete="new-password"
                    />
                    <PasswordToggle isVisible={visiblePasswords.confirm} onClick={() => togglePassword('confirm')} />
                  </div>
                </label>
              </div>
              <button className="button button-primary auth-submit" type="submit">
                Create Account
              </button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>
                <span>Email</span>
                <input id="email-login" name="email" type="email" autoComplete="email" />
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
                    id="password-login"
                    name="password"
                    type={visiblePasswords.login ? 'text' : 'password'}
                    autoComplete="current-password"
                  />
                  <PasswordToggle isVisible={visiblePasswords.login} onClick={() => togglePassword('login')} />
                </div>
              </label>
              <button className="button button-primary auth-submit" type="submit">
                Login
              </button>
            </form>
          )}

          {activeTab !== 'reset' && (
            <>
              <div className="auth-divider">
                <span />
                <b>OR</b>
                <span />
              </div>

              <button className="auth-google" type="button">
                <LogIn className="app-icon" aria-hidden="true" />
                {activeTab === 'signup' ? 'Sign up with Google' : 'Sign in with Google'}
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

export default AuthPage;
