import { ArrowLeft, ArrowRight, Eye, EyeOff, LogIn } from 'lucide-react';
import { FormEvent, useMemo, useState, useEffect } from 'react';
import { supabase } from './lib/supabase';
import { syncUser } from './lib/api';
import ConfigBanner from './component/ConfigBanner';
import useToast from './lib/useToast';

type AuthTab = 'login' | 'signup' | 'reset';

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
  const { showToast, ToastContainer } = useToast();
  const [activeTab, setActiveTab] = useState<AuthTab>(getInitialTab);
  const [visiblePasswords, setVisiblePasswords] = useState<VisiblePasswords>({
    signup: false,
    confirm: false,
    login: false,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    // Check if we just returned from a Google login or email verification
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        setIsLoading(true);
        showToast('Synchronizing profile...', 'info');
        try {
          await syncUser();
          window.location.href = '/dashboard';
        } catch (err: any) {
          showToast(err.message || 'Failed to sync user data', 'error');
          setIsLoading(false);
        }
      }
    });

    return () => subscription.unsubscribe();
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

  async function handleGoogleLogin() {
    setIsLoading(true);
    showToast('Redirecting to Google...', 'info');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/auth',
      },
    });
    if (error) {
      showToast(error.message, 'error');
      setIsLoading(false);
    }
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
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: name },
            emailRedirectTo: window.location.origin + '/auth',
          },
        });
        if (error) throw error;
        
        if (data.session) {
          showToast('Account created! Syncing...', 'success');
          await syncUser();
          window.location.href = '/dashboard';
        } else {
          setSuccessMessage('Check your email for the confirmation link.');
          showToast('Check your email to verify.', 'success');
          setIsLoading(false);
        }
      } else if (activeTab === 'login') {
        showToast('Logging in...', 'info');
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (activeTab === 'reset') {
        showToast('Sending reset link...', 'info');
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + '/auth?tab=login',
        });
        if (error) throw error;
        setSuccessMessage('Password reset link sent to your email.');
        showToast('Reset link sent!', 'success');
        setIsLoading(false);
      }
    } catch (err: any) {
      showToast(err.message || 'Authentication failed', 'error');
      setIsLoading(false);
    }
  }

  return (
    <>
      <ConfigBanner />
      <ToastContainer />
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
            <h1 id="auth-title">
              {successMessage ? 'Success!' : copy.title}
            </h1>
            <p>{successMessage || copy.body}</p>
          </div>

          {successMessage ? (
             <div className="auth-success-state">
                <button className="button button-secondary w-full" onClick={() => { setSuccessMessage(null); setActiveTab('login'); }}>
                  Return to Login
                </button>
             </div>
          ) : activeTab === 'reset' ? (
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>
                <span>Email Address</span>
                <input id="email-reset" name="email" type="email" autoComplete="email" placeholder="name@example.com" required />
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
                <input id="name" name="name" type="text" autoComplete="name" required />
              </label>
              <label>
                <span>Email</span>
                <input id="email-signup" name="email" type="email" autoComplete="email" required />
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
                      required
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
                <input id="email-login" name="email" type="email" autoComplete="email" required />
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
                    required
                  />
                  <PasswordToggle isVisible={visiblePasswords.login} onClick={() => togglePassword('login')} />
                </div>
              </label>
              <button className="button button-primary auth-submit" type="submit" disabled={isLoading}>
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
