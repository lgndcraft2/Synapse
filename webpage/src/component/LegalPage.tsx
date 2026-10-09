import type { ReactNode } from 'react';
import { BrandLockup } from './Brand';
import { LEGAL_PAGES, OPERATOR } from '../lib/legal';

/**
 * Shared shell for /privacy, /terms and /refunds. These pages render at build
 * time (scripts/prerender.mjs) and hydrate, so nothing here may read window,
 * storage or the session during render.
 */

export interface LegalSectionMeta {
  id: string;
  title: string;
}

export function LegalSection({ id, title, children }: LegalSectionMeta & { children: ReactNode }) {
  return (
    <section id={id} className="legal-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Mail() {
  return <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>;
}

export function OperatorAddress() {
  return (
    <address className="legal-address">
      {OPERATOR.name}
      <br />
      {OPERATOR.address.map((line) => (
        <span key={line}>
          {line}
          <br />
        </span>
      ))}
      Email: <Mail />
    </address>
  );
}

export default function LegalPage({
  title,
  effectiveDate,
  lede,
  sections,
  children,
}: {
  title: string;
  effectiveDate: string;
  lede: ReactNode;
  sections: LegalSectionMeta[];
  children: ReactNode;
}) {
  return (
    <>
      <header className="topbar">
        <div className="nav-shell">
          <BrandLockup href="/" height={32} />
          <a href="/support" className="nav-login" style={{ textDecoration: 'none' }}>
            Support
          </a>
        </div>
      </header>

      <main className="legal">
        <div className="legal-head">
          <h1>{title}</h1>
          <p className="legal-meta">Effective {effectiveDate}</p>
          <p className="legal-lede">{lede}</p>
        </div>

        <nav className="legal-toc" aria-label="Contents">
          <h2>Contents</h2>
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        {children}

        <nav className="legal-related" aria-label="Legal">
          {LEGAL_PAGES.filter((p) => p.label !== title).map((p) => (
            <a key={p.href} href={p.href}>
              {p.label}
            </a>
          ))}
          <a href="/">Back to Synapse</a>
        </nav>
      </main>
    </>
  );
}
