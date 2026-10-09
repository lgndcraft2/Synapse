/**
 * Build-time render entry, used only by scripts/prerender.mjs.
 *
 * Most AI crawlers (GPTBot, ClaudeBot, PerplexityBot) and many link
 * unfurlers never run JavaScript, so without this they see an empty
 * #root. The landing page and the legal pages are rendered for real and
 * hydrated by main.tsx.
 * /support can't render on the server (AppShell reads window.location
 * during render), so it gets a plain, crawlable copy of its help content
 * that the SPA replaces on boot.
 */
import { StrictMode, type ComponentType } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import App from './App';
import Privacy from './Privacy';
import Refunds from './Refunds';
import Terms from './Terms';
import { LEGAL_META } from './lib/legal';
import { FAQS, GUIDES, SUPPORT_EMAIL } from './lib/faq';
import { PLANS, TRIAL_DAYS } from './lib/plans';

export { FAQS, LEGAL_META, PLANS, TRIAL_DAYS };

export function renderLanding(): string {
  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

const LEGAL_PAGES: Record<string, ComponentType> = {
  '/privacy': Privacy,
  '/terms': Terms,
  '/refunds': Refunds,
};

/** Renders a legal page by path ("/privacy", "/terms", "/refunds"). */
export function renderLegal(path: string): string {
  const Page = LEGAL_PAGES[path];
  return renderToString(
    <StrictMode>
      <Page />
    </StrictMode>,
  );
}

function SupportStatic() {
  return (
    <main>
      <h1>Synapse support and FAQ</h1>
      <p>
        Answers on privacy, browser support, billing, and how the Synapse reading profile works.
        Need a human? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
      <section>
        <h2>Frequently asked questions</h2>
        {FAQS.map((faq) => (
          <article key={faq.question}>
            <h3>{faq.question}</h3>
            <p>{faq.answer}</p>
          </article>
        ))}
      </section>
      <section>
        <h2>Troubleshooting guides</h2>
        {GUIDES.map((guide) => (
          <article key={guide.id} id={guide.id}>
            <h3>{guide.title}</h3>
            <p>{guide.summary}</p>
            <ol>
              {guide.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </article>
        ))}
      </section>
      <p>
        <a href="/">Back to Synapse</a>
      </p>
    </main>
  );
}

export function renderSupport(): string {
  return renderToStaticMarkup(<SupportStatic />);
}
