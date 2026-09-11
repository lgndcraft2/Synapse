import type { ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { pushLogoutToExtension } from '../lib/extensionBridge';
import ConfigBanner from './ConfigBanner';

/** Initials for the header avatar, matching the dashboard's derivation. */
export function initialsFor(user: any): string {
  const fullName: string | undefined = user?.user_metadata?.full_name;
  if (fullName) {
    return fullName
      .split(' ')
      .map((n: string) => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
  return user?.email?.[0]?.toUpperCase() || '·';
}

export async function signOut() {
  pushLogoutToExtension();
  await supabase.auth.signOut();
  window.location.href = '/auth?tab=login';
}

interface AppHeaderProps {
  user: any;
  /** Optional breadcrumb shown beside the wordmark, e.g. "Billing". */
  backTo?: { href: string; label: string };
}

/**
 * The app-shell header shared by /dashboard, /billing and /billing/success:
 * wordmark on the left, avatar + logout on the right.
 */
export function AppHeader({ user, backTo }: AppHeaderProps) {
  return (
    <header style={{ backgroundColor: '#fcf9f8', borderBottom: '1px solid #3d3d38' }}>
      <div
        className="flex justify-between items-center w-full px-10 py-4 mx-auto"
        style={{ maxWidth: 1140 }}
      >
        <div className="flex items-center gap-6">
          <a
            href="/dashboard"
            className="flex items-center gap-2 font-serif font-bold text-2xl"
            style={{ color: '#004635' }}
          >
            <span className="material-symbols-outlined">psychology</span>
            Synapse
          </a>
          {backTo && (
            <a
              href={backTo.href}
              className="hidden md:inline-flex items-center gap-1 text-sm font-semibold transition-colors hover:opacity-80"
              style={{ color: '#5e5f5b' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                arrow_back
              </span>
              {backTo.label}
            </a>
          )}
        </div>
        <div
          className="flex items-center gap-2 cursor-pointer p-1.5 rounded-lg transition-colors hover:opacity-80"
          onClick={signOut}
          title="Sign out"
        >
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold"
            style={{ backgroundColor: '#1b5e4b', color: '#94d5bd' }}
          >
            {initialsFor(user)}
          </div>
          <span
            className="material-symbols-outlined text-lg"
            style={{ color: '#5e5f5b', fontVariationSettings: "'FILL' 0" }}
          >
            logout
          </span>
        </div>
      </div>
    </header>
  );
}

/** The landing page's footer, reused verbatim across the app shell. */
export function AppFooter() {
  return (
    <footer className="footer">
      <div className="footer-shell">
        <a className="brand" href="/">
          Synapse
        </a>
        <div className="copyright">2026 Synapse. Built for the cognitive edge.</div>
        <nav aria-label="Footer navigation">
          <a href="/">Privacy Policy</a>
          <a href="/">Accessibility Statement</a>
          <a href="/#library">Research Library</a>
          <a href="/">Contact Support</a>
        </nav>
      </div>
    </footer>
  );
}

interface AppShellProps {
  user: any;
  backTo?: { href: string; label: string };
  children: ReactNode;
}

/** Page chrome: config banner, header, main slot, footer. */
export default function AppShell({ user, backTo, children }: AppShellProps) {
  return (
    <>
      <ConfigBanner />
      <div
        className="dash font-body"
        style={{
          backgroundColor: '#fcf9f8',
          color: '#1b1c1c',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <AppHeader user={user} backTo={backTo} />
        {children}
        <AppFooter />
      </div>
    </>
  );
}
