import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { signOut as authSignOut } from '../lib/auth';
import { pushLogoutToExtension } from '../lib/extensionBridge';
import ConfigBanner from './ConfigBanner';
import { Skeleton } from './ui';
import { BrandLockup } from './Brand';

/** Initials for the header avatar, matching the dashboard's derivation. */
export function initialsFor(user: any): string {
  const fullName: string | undefined = user?.name;
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
  // Revokes the refresh token server-side, which Supabase used to handle for
  // us. Clears local state even if the call fails, so a network error can
  // never leave someone stuck signed in.
  await authSignOut();
  window.location.href = '/auth?tab=login';
}

/** Destinations in the account dropdown, in the order they are read out. */
const ACCOUNT_LINKS = [
  { href: '/dashboard', icon: 'space_dashboard', label: 'Dashboard' },
  { href: '/profile', icon: 'person', label: 'Your profile' },
  { href: '/subscription', icon: 'credit_card', label: 'Subscription' },
  { href: '/observer', icon: 'monitoring', label: 'Observer panel' },
  { href: '/support', icon: 'help', label: 'Help and support' },
];

/**
 * Account dropdown. Replaces the old avatar-link-plus-logout-icon pair, which
 * put an irreversible action one stray click from the profile link and left
 * the rest of the account screens reachable only by typing a URL.
 *
 * Follows the menu-button pattern: the trigger owns aria-expanded, the popover
 * is a role="menu", and arrows move between items so the whole thing is usable
 * without a mouse.
 */
function UserMenu({ user }: { user: any }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const fullName: string | undefined = user?.name;
  const displayName = fullName || user?.email?.split('@')[0] || 'Your account';
  const path = window.location.pathname;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      // Escape hands focus back to the trigger rather than dropping the
      // keyboard user at the top of the document.
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function focusItem(index: number) {
    const items = itemRefs.current.filter(Boolean) as HTMLElement[];
    if (!items.length) return;
    items[(index + items.length) % items.length].focus();
  }

  function onMenuKeyDown(event: ReactKeyboardEvent) {
    const items = itemRefs.current.filter(Boolean) as HTMLElement[];
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(current + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(items.length - 1);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
    // The items mount with the popover, so wait a frame before reaching in.
    requestAnimationFrame(() => focusItem(event.key === 'ArrowUp' ? -1 : 0));
  }

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="user-avatar" aria-hidden="true">
          {initialsFor(user)}
        </span>
        <span className="user-name">{displayName}</span>
        <span className="material-symbols-outlined user-chevron" aria-hidden="true">
          expand_more
        </span>
        <span className="sr-only">Account menu</span>
      </button>

      {open && (
        <div className="user-popover" role="menu" aria-label="Account" onKeyDown={onMenuKeyDown}>
          <div className="user-popover-head">
            <p className="user-popover-name">{displayName}</p>
            {user?.email && <p className="user-popover-email">{user.email}</p>}
          </div>

          {ACCOUNT_LINKS.filter((link) => link.href !== '/observer' || user?.is_observer).map((link, index) => {
            const current = path === link.href || path.startsWith(`${link.href}/`);
            return (
              <a
                key={link.href}
                href={link.href}
                role="menuitem"
                tabIndex={-1}
                ref={(el) => {
              itemRefs.current[index] = el;
                }}
                className="user-menu-item"
                aria-current={current ? 'page' : undefined}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {link.icon}
                </span>
                {link.label}
              </a>
            );
          })}

          <div className="user-menu-sep" role="separator" />

          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            ref={(el) => {
              itemRefs.current[ACCOUNT_LINKS.filter((link) => link.href !== '/observer' || user?.is_observer).length] = el;
            }}
            className="user-menu-item"
            onClick={signOut}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              logout
            </span>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

interface AppHeaderProps {
  user: any;
  /**
   * False while the session is still being read. Without it a signed-in user
   * sees "Log in / Get Extension" flash before the account menu replaces it,
   * because "not known yet" is indistinguishable from "signed out".
   * Defaults true so a caller that hasn't been updated keeps the old behaviour
   * rather than showing a placeholder forever.
   */
  authChecked?: boolean;
  /** Optional breadcrumb shown beside the wordmark, e.g. "Billing". */
  backTo?: { href: string; label: string };
}

/**
 * The app-shell header shared by /dashboard, /billing and /billing/success:
 * wordmark on the left, avatar + logout on the right.
 */
export function AppHeader({ user, authChecked = true, backTo }: AppHeaderProps) {
  return (
    <header style={{ backgroundColor: '#fcf9f8', borderBottom: '1px solid #3d3d38' }}>
      <div
        className="flex justify-between items-center w-full px-10 py-4 mx-auto"
        style={{ maxWidth: 1140 }}
      >
        <div className="flex items-center gap-6">
          <BrandLockup href="/dashboard" height={30} label="Synapse dashboard" />
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
        {!authChecked ? (
          /* Auth not resolved yet. Shaped like the signed-in trigger so the
             swap costs no layout shift in the common case; the name bar is
             hidden below 768px exactly as .user-name is. */
          <div className="user-trigger-placeholder" aria-hidden="true">
            {/* Avatar, name and chevron, at the trigger's own metrics: below
                768px this comes to exactly the trigger's width, and above it
                lands within a few px of a typical name. */}
            <Skeleton style={{ width: 32, height: 32, borderRadius: 999 }} />
            <Skeleton className="user-trigger-placeholder-name" style={{ width: 90, height: 14 }} />
            <Skeleton style={{ width: 20, height: 20, borderRadius: 4 }} />
          </div>
        ) : user ? (
          <UserMenu user={user} />
        ) : (
          /* Public app-shell pages (e.g. /support) are reachable signed out,
             so mirror the landing page's actions rather than an empty corner.
             Both read as buttons: the bare text link beside a solid one made
             the pair look unfinished. */
          <div className="flex items-center gap-3">
            <a href="/auth?tab=login" className="header-action">
              Log in
            </a>
            <a href="/auth?tab=signup" className="header-action header-action-primary">
              Get Extension
            </a>
          </div>
        )}
      </div>
    </header>
  );
}

/** The landing page's footer, reused verbatim across the app shell. */
export function AppFooter() {
  return (
    <footer className="footer">
      <div className="footer-shell">
        <BrandLockup href="/" height={26} />
        <div className="copyright">2026 Synapse. Built for the cognitive edge.</div>
        <nav aria-label="Footer navigation">
          <a href="/">Privacy Policy</a>
          <a href="/">Accessibility Statement</a>
          <a href="/#library">Research Library</a>
          <a href="/support">Contact Support</a>
        </nav>
      </div>
    </footer>
  );
}

interface AppShellProps {
  user: any;
  /** See AppHeaderProps.authChecked. */
  authChecked?: boolean;
  backTo?: { href: string; label: string };
  children: ReactNode;
}

/** Page chrome: config banner, header, main slot, footer. */
export default function AppShell({ user, authChecked = true, backTo, children }: AppShellProps) {
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
        <AppHeader user={user} authChecked={authChecked} backTo={backTo} />
        {children}
        <AppFooter />
      </div>
    </>
  );
}
