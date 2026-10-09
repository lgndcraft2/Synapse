import {
  ArrowDown,
  ArrowLeft,
  BadgeCheck,
  Beaker,
  Brain,
  Check,
  Compass,
  Eye,
  FileText,
  Highlighter,
  History,
  Lasso,
  Layers,
  Menu,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  ToggleRight,
  WandSparkles,
  Zap,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { getSession, subscribeAuth } from './lib/auth';
import { PLANS, TRIAL_DAYS, formatPriceShort } from './lib/plans';
import { FAQS } from './lib/faq';
import ConfigBanner from './component/ConfigBanner';
import { BrandLockup } from './component/Brand';

const navItems = ['Explain', 'Profile Engine', 'Solutions', 'How it Works'];

const explainFeatures = [
  {
    icon: 'highlighter',
    title: 'Highlight to explain',
    text: 'Select a sentence, a term, or a whole paragraph. A plain-language explanation appears beside it, pitched to your reading profile.',
  },
  {
    icon: 'lasso',
    title: 'Circle anything',
    text: "Hold Alt+S (Option+S on a Mac) and trace around a chart, a diagram, an equation, or text you can't select. You see the exact area before anything is sent.",
  },
  {
    icon: 'refresh',
    title: 'Re-explain',
    text: 'Still unclear? Ask for a simpler version, more detail, or something specific, without starting over.',
  },
  {
    icon: 'file',
    title: 'Works in PDFs',
    text: 'Synapse opens PDFs in its own viewer, so highlighting and circling work there too, with the whole document as context.',
  },
  {
    icon: 'history',
    title: 'History that remembers where',
    text: 'Every explanation stays in a side panel. Click one and Synapse scrolls back to the passage it came from.',
  },
  {
    icon: 'shield',
    title: 'Context, with limits',
    text: 'Explanations read the surrounding page so they make sense in place. On email, messaging, and banking sites only the passage you chose is used.',
  },
];

const loopSteps = [
  { icon: 'visibility', title: 'Observe', text: 'Tracks reading patterns and friction points.' },
  { icon: 'model_training', title: 'Adapt', text: 'Updates your cognitive baseline model.' },
  { icon: 'auto_awesome', title: 'Refine', text: 'Delivers a clearer web next time.', active: true },
];

const howItWorks = [
  {
    icon: 'brain',
    title: '1. Onboard',
    text: 'Answer 5 questions about how you process information. Not your diagnosis - how you actually think.',
  },
  {
    icon: 'compass',
    title: '2. Browse',
    text: 'Read naturally across any site. Synapse learns where your attention breaks in real time.',
  },
  {
    icon: 'trending_up',
    title: '3. It Learns',
    text: 'Every re-read, every feedback tap, every section you engage with trains your profile. It gets more accurate every session.',
  },
];



const roadmap = [
  ['Now', 'Chrome extension with live AI section reformatting, highlight and circle to explain, a built-in PDF viewer, cognitive profile engine, and adaptive feedback loop.', true],
  ['Next', 'Firefox and Safari support. Google Docs and more document types.'],
  ['Later', 'OpenAPI for third-party adaptive apps'],
  ['Future', 'Cognitive-first operating system'],
];

const heroSignals = ['Highlight or circle to explain', 'Adaptive layouts', 'No data sold'];

const icons = {
  add: Plus,
  arrow_back_ios: ArrowLeft,
  auto_awesome: WandSparkles,
  bolt: Zap,
  check: Check,
  check_circle: BadgeCheck,
  compass: Compass,
  file: FileText,
  highlighter: Highlighter,
  history: History,
  keyboard_arrow_down: ArrowDown,
  lasso: Lasso,
  layers: Layers,
  menu: Menu,
  model_training: Sparkles,
  psychology: Brain,
  refresh: RefreshCw,
  science: Beaker,
  shield: ShieldCheck,
  toggle_on: ToggleRight,
  trending_up: TrendingUp,
  visibility: Eye,
};

function Icon({ name }: { name: keyof typeof icons | string }) {
  const LucideIcon = icons[name as keyof typeof icons] ?? Sparkles;
  return <LucideIcon className="app-icon" aria-hidden="true" strokeWidth={1.8} />;
}

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    setIsLoggedIn(Boolean(getSession()));
    return subscribeAuth((session) => setIsLoggedIn(Boolean(session)));
  }, []);

  // Send everyone to /billing to review the order before Stripe. Signed-out
  // visitors sign up first and land back on the same plan.
  async function handleUpgrade(tier: string) {
    const target = `/billing?plan=${tier}`;
    const session = getSession();
    window.location.href = session
      ? target
      : `/auth?tab=signup&next=${encodeURIComponent(target)}`;
  }

  return (
    <>
      <ConfigBanner />
      <header className="topbar">
        <div className="nav-shell">
          <BrandLockup href="#top" height={32} />
          <nav className="nav-links" aria-label="Primary navigation">
            {navItems.map((item) => (
              <a key={item} href={`#${item.toLowerCase().replaceAll(' ', '-')}`}>
                {item}
              </a>
            ))}
          </nav>
          <div className="nav-actions" style={{display: 'flex', gap: '12px', alignItems: 'center'}}>
            {isLoggedIn ? (
              <a href="/dashboard" className="nav-login" style={{textDecoration: 'none'}}>Dashboard</a>
            ) : (
              <a href="/auth?tab=login" className="nav-login" style={{textDecoration: 'none'}}>Login</a>
            )}
            <a href="/auth?tab=signup" className="button button-primary nav-cta" style={{textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}>Get Extension</a>
          </div>
          <button
            className="icon-button menu-button"
            type="button"
            aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileNavOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <Icon name="menu" />
          </button>
          <nav id="mobile-navigation" className={`mobile-nav ${mobileNavOpen ? 'is-open' : ''}`} aria-label="Mobile navigation">
            {navItems.map((item) => (
              <a key={item} href={`#${item.toLowerCase().replaceAll(' ', '-')}`} onClick={() => setMobileNavOpen(false)}>
                {item}
              </a>
            ))}
            <a className="button button-primary" href="/auth?tab=signup" onClick={() => setMobileNavOpen(false)}>
              Get Extension
            </a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="hero page-section">
          <div className="hero-grid">
            <div className="hero-copy">
              <h1>The Internet wasn't Built for your Brain. <br /><span className="synapse_color">Synapse</span> is.</h1>
              <p>
                Traditional accessibility tools apply fixed presets and forget you. Synapse builds a persistent,
                evolving model of how you actually process information, reformatting every page you read in real time
                and explaining anything you highlight or circle.
              </p>
              <div className="button-row">
                <a href="/auth?tab=signup" className="button button-primary" style={{textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}>Get the Extension</a>
                <button className="button button-secondary">See how it works</button>
              </div>
              <div className="hero-signals" aria-label="Product promises">
                {heroSignals.map((signal) => (
                  <span key={signal}>
                    <Icon name="check" />
                    {signal}
                  </span>
                ))}
              </div>
            </div>
            <div className="hero-visual offset-shadow" aria-label="Digital text being reorganized into clearer reading blocks">
              <div className="extension-shell">
                <div className="extension-top">
                  <div>
                    <strong>Synapse Active</strong>
                    <span>Article restructured</span>
                  </div>
                  <Icon name="toggle_on" />
                </div>
                <div className="extension-body">
                  <div className="dense-column">
                    <span>Before</span>
                    {Array.from({ length: 8 }).map((_, index) => (
                      <i key={index} />
                    ))}
                  </div>
                  <div className="clarity-column">
                    <span>After</span>
                    <div className="focus-title" />
                    <div className="reading-card">
                      <b />
                      <b />
                    </div>
                    <div className="reading-card small">
                      <b />
                      <b />
                    </div>
                  </div>
                </div>
                <div className="control-strip">
                  <label>
                    Spacing
                    <span><i /></span>
                  </label>
                  <label>
                    Focus
                    <span><i /></span>
                  </label>
                </div>
              </div>
            </div>
          </div>
          <div className="hero-bottom">
            <p>Live reformatting and instant explanations for policy pages, forms, dense research, and PDFs.</p>
            <a href="#solutions" aria-label="Scroll to solutions">
              <Icon name="keyboard_arrow_down" />
            </a>
          </div>
        </section>

        <section className="problem section-band" id="solutions">
          <div className="content-grid">
            <div className="section-copy">
              <h2>The One-Size-Fits-All Failure.</h2>
              <p>
                Existing tools give every dyslexic or ADHD user the same mode. They assume a single toggle can solve
                complex, individualized cognitive needs.
              </p>
              <p>
                We don't do modes. We do translation. Synapse understands the difference between chaotic information
                design and structured clarity tailored specifically to your cognitive profile.
              </p>
            </div>
            <div className="comparison">
              <article className="mock-panel chaotic">
                <span className="panel-label">Chaotic Web</span>
                {Array.from({ length: 7 }).map((_, index) => (
                  <div className={`skeleton skeleton-${index + 1}`} key={index} />
                ))}
              </article>
              <article className="mock-panel structured offset-shadow">
                <span className="panel-label panel-label-primary">
                  Synapse Restructuring
                  <Icon name="check_circle" />
                </span>
                <div className="reading-cluster">
                  <div />
                  <div />
                </div>
                <div className="reading-cluster">
                  <div />
                  <div />
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="explain" id="explain">
          <div className="content-grid">
            <div className="section-copy">
              <h2>Point at anything. Understand it.</h2>
              <p>
                Some pages don't need rebuilding, just one confusing paragraph explained. Highlight it, or circle it,
                and Synapse explains it right where you are, in the way your profile says you read best.
              </p>
              <p>
                No copying into a chatbot, no new tab, no losing your place.
              </p>
            </div>
            <div className="explain-grid">
              {explainFeatures.map((feature) => (
                <article className="feature-card" key={feature.title}>
                  <h4>
                    <Icon name={feature.icon} />
                    {feature.title}
                  </h4>
                  <p>{feature.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="feedback" id="profile-engine">
          <div className="center-copy">
            <h2>A product that gets smarter with every scroll.</h2>
            <p>
              Synapse relies on passive signals to update your profile weekly. It notes when you re-read sections,
              abandon long paragraphs, or engage deeply with specific formats.
            </p>
          </div>
          <div className="loop">
            {loopSteps.map((step, index) => (
              <div className="loop-segment" key={step.title}>
                <article className="loop-step">
                  <span className="loop-index">{String(index + 1).padStart(2, '0')}</span>
                  <div className={`loop-icon ${step.active ? 'active' : ''}`}>
                    <Icon name={step.icon} />
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </article>
                {index < loopSteps.length - 1 && <div className="flow-connector" aria-hidden="true"><span /></div>}
              </div>
            ))}
          </div>
        </section>

        <section className="how-band" id="how-it-works">
          <div className="how-card offset-shadow">
            <h2>How it Works</h2>
            <div className="steps-grid">
              {howItWorks.map((step) => (
                <article className="work-step" key={step.title}>
                  <div className="step-head">
                    <div className="step-icon">
                      <Icon name={step.icon} />
                    </div>
                    <span>{step.title.slice(0, 1).padStart(2, '0')}</span>
                  </div>
                  <h3>{step.title.slice(3)}</h3>
                  <p>{step.text}</p>
                  <div className="step-preview" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                </article>
              ))}
            </div>
            <blockquote className="quote">
              <p>"After 20 pages, Synapse knows how you read better than any tool you have ever used."</p>
            </blockquote>
          </div>
        </section>

        <section className="features page-section" id="library">
          <div className="feature-grid">
            <article className="feature-main offset-shadow">
              <Icon name="psychology" />
              <h3>Cognitive Profile Engine</h3>
              <p>
                Not a toggle, but a model. It learns that you lose threading after 3-step lists and spatial diagrams
                are your strength. It adapts the UI structure before you even realize you're struggling.
              </p>
              <div className="feature-status">
                <span />
                Continuous Learning
              </div>
            </article>
            <div className="feature-stack">
              <article className="feature-card">
                <h4>
                  <Icon name="layers" />
                  Ambient Intelligence
                </h4>
                <p>
                  A persistent layer on the web. Intercepts PDFs, Google Docs, and emails without behavior change. It
                  lives quietly in the background.
                </p>
              </article>
              <article className="feature-card">
                <h4>
                  <Icon name="science" />
                  Evidence-Based Formats
                </h4>
                <p>
                  Science-backed layouts mapping trait clusters to interventions. We don't guess what works; we apply
                  validated cognitive restructuring techniques.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="pricing full-section" id="pricing">
          <div className="section-heading">
            <h2>Choose Your Flow</h2>
            <p>No diagnosis required. No data sold. Ever. Paid plans start with a {TRIAL_DAYS}-day free trial.</p>
          </div>
          <div className="pricing-grid">
            {PLANS.map((plan) => (
              <article className={`price-card ${plan.featured ? 'featured offset-shadow' : ''}`} key={plan.name}>
                {plan.featured && <div className="badge">Recommended</div>}
                <h3>{plan.name}</h3>
                {plan.note && <p className="pricing-note">{plan.note}</p>}
                <div className="price">
                  {plan.monthly ? formatPriceShort(plan.monthly.amount) : 'Free'}
                  {plan.monthly && <span>/mo</span>}
                </div>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Icon name="check" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <button
                  className={`button ${plan.featured ? 'button-primary' : 'button-secondary'}`}
                  onClick={() => plan.monthly ? handleUpgrade(plan.tier) : (window.location.href = '/auth?tab=signup')}
                >
                  {plan.cta}
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="faq full-section surface-low">
          <h2>Frequently Asked Questions</h2>
          <div className="faq-grid">
            {FAQS.map(({ question, answer }) => (
              <article className="faq-item" key={question}>
                <h4>{question}</h4>
                <p>{answer}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="vision">
          <div className="vision-grid">
            <div>
              <h2>Building the cognitive edge for everyone.</h2>
              <p>
                Our vision is a world where the web is as fluid as thought. We are moving toward a headless internet
                where content is completely decoupled from presentation.
              </p>
            </div>
            <aside className="roadmap">
              <h3>Roadmap</h3>
              {roadmap.map(([label, text, active], index) => (
                <div className="roadmap-item" key={label.toString()}>
                  <div className="timeline">
                    <span className={active ? 'active' : ''} />
                    {index < roadmap.length - 1 && <i />}
                  </div>
                  <div>
                    <strong>{label}</strong>
                    <p>{text}</p>
                  </div>
                </div>
              ))}
            </aside>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer-shell">
          <BrandLockup href="#top" height={26} />
          <div className="copyright">2026 Synapse. Built for the cognitive edge.</div>
          <nav aria-label="Footer navigation">
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
            <a href="/refunds">Refund Policy</a>
            <a href="#library">Research Library</a>
            <a href="/support">Contact Support</a>
          </nav>
        </div>
      </footer>
    </>
  );
}

export default App;
