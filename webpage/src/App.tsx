import {
  ArrowDown,
  ArrowLeft,
  BadgeCheck,
  Beaker,
  Brain,
  Check,
  Compass,
  Eye,
  Layers,
  Menu,
  Plus,
  Sparkles,
  ToggleRight,
  WandSparkles,
  Zap,
  TrendingUp,
} from 'lucide-react';
import { supabase } from './lib/supabase';
import { createCheckoutSession } from './lib/api';
import ConfigBanner from './component/ConfigBanner';

const navItems = ['Profile Engine', 'Solutions', 'Library', 'How it Works'];

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

const stats = [
  ['1.2B', 'Neurodivergent people worldwide'],
  ['$58B', 'Global Accessibility Market'],
  ['1 in 5', 'People with reading differences'],
  ['$4.8B', 'EdTech Segment Growth'],
];

const pricingPlans = [
  {
    name: 'Explorer',
    price: 'Free',
    priceId: '',
    description: 'For quick cleanup, light reading, and a single structured profile.',
    features: [
      'Section cards for dense pages',
      'Full page reformatting',
      'Single cognitive profile',
      'Basic adaptive feedback',
      '30 section reformats per month',
      'Chrome extension only',
    ],
    cta: 'Start Free',
  },
  {
    name: 'Thinker Lite',
    price: '$4',
    suffix: '/mo',
    priceId: import.meta.env.VITE_STRIPE_THINKER_LITE_PRICE_ID,
    description: 'For structured reading across web pages and documents.',
    features: [
      'Everything in Free',
      'Document Reader for PDF, TXT, CSV, and Markdown',
      'SQ4R focus questions',
      'Bionic reading and focus mode',
      'Google Docs support',
      'Up to 300 section reformats per month',
    ],
    cta: 'Upgrade',
    featured: true,
  },
  {
    name: 'Deep Thinker',
    price: '$8',
    suffix: '/mo',
    priceId: import.meta.env.VITE_STRIPE_DEEP_THINKER_PRICE_ID,
    description: 'For heavy reading sessions, research, and deeper adaptation.',
    features: [
      'Everything in Thinker Lite',
      'Full Google Docs and PDF support',
      'All cognitive profile modes',
      'Deeper cognitive pattern insights',
      'Full adaptive feedback loop',
      'Highest usage limits',
    ],
    cta: 'Go Deep',
  },
];

const faqs = [
  [
    'Is my reading data private?',
    'Completely. All cognitive modeling happens on-device or via encrypted, anonymized tokens. We never see what you are reading, only how you process the structure.',
  ],
  [
    'Does this work with Dark Mode?',
    "Yes. Synapse layers on top of existing styles to manage contrast, line-height, and paragraph spacing regardless of the site's theme.",
  ],
  [
    'What if I have multiple diagnoses?',
    "Our engine doesn't categorize you by diagnosis, but by trait. It adapts to your specific friction points, whether they stem from ADHD, dyslexia, or fatigue.",
  ],
  [
    'Can I use it on mobile?',
    'Currently available for Chrome. Firefox, Safari, and Edge support is on our roadmap.',
  ],
  [
    'Does it translate languages?',
    'No. We focus on structural translation, changing how information is presented visually, not the language it is written in.',
  ],
  [
    'How often does the model update?',
    'Your profile updates continuously based on your reading behaviour and the feedback you give on each section card.',
  ],
  [
    'Can I export my profile?',
    'Yes. You can take your cognitive profile data to any other device or share it with specialists if you choose.',
  ],
  [
    'Is there a student discount?',
    'We offer a 50% discount for anyone with a valid .edu email address or equivalent proof of study.',
  ],
];

const roadmap = [
  ['Now', 'Chrome extension with live AI section reformatting, cognitive profile engine, and adaptive feedback loop.', true],
  ['Next', 'Firefox and Safari support. PDF and document reformatting beyond web pages.'],
  ['Later', 'OpenAPI for third-party adaptive apps'],
  ['Future', 'Cognitive-first operating system'],
];

const heroSignals = ['On-device profile', 'Adaptive layouts', 'No data sold'];

const icons = {
  add: Plus,
  arrow_back_ios: ArrowLeft,
  auto_awesome: WandSparkles,
  bolt: Zap,
  check: Check,
  check_circle: BadgeCheck,
  compass: Compass,
  keyboard_arrow_down: ArrowDown,
  layers: Layers,
  menu: Menu,
  model_training: Sparkles,
  psychology: Brain,
  science: Beaker,
  toggle_on: ToggleRight,
  trending_up: TrendingUp,
  visibility: Eye,
};

function Icon({ name }: { name: keyof typeof icons | string }) {
  const LucideIcon = icons[name as keyof typeof icons] ?? Sparkles;
  return <LucideIcon className="app-icon" aria-hidden="true" strokeWidth={1.8} />;
}

function App() {
  async function handleUpgrade(priceId: string) {
    if (!priceId) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      window.location.href = '/auth?tab=signup';
      return;
    }

    try {
      const checkoutUrl = await createCheckoutSession(priceId);
      window.location.href = checkoutUrl;
    } catch (err) {
      alert('Failed to start checkout session. Please try again.');
    }
  }

  return (
    <>
      <ConfigBanner />
      <header className="topbar">
        <div className="nav-shell">
          <a className="brand" href="#top" aria-label="Synapse home">
            Synapse
          </a>
          <nav className="nav-links" aria-label="Primary navigation">
            {navItems.map((item) => (
              <a key={item} href={`#${item.toLowerCase().replaceAll(' ', '-')}`}>
                {item}
              </a>
            ))}
          </nav>
          <div className="nav-actions" style={{display: 'flex', gap: '12px', alignItems: 'center'}}>
            <a href="/auth?tab=login" className="nav-login" style={{textDecoration: 'none'}}>Login</a>
            <a href="/auth?tab=signup" className="button button-primary nav-cta" style={{textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}>Get Extension</a>
          </div>
          <button className="icon-button menu-button" aria-label="Open navigation">
            <Icon name="menu" />
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero page-section">
          <div className="hero-grid">
            <div className="hero-copy">
              <h1>The Internet wasn't Built for your Brain. <br /><span className="synapse_color">Synapse</span> is.</h1>
              <p>
                Traditional accessibility tools apply fixed presets and forget you. Synapse builds a persistent,
                evolving model of how you actually process information, reformatting every page you read in real time.
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
            <p>Live reformatting for onboarding flows, policy pages, forms, and dense research.</p>
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
            <h2>Choose Your Plan</h2>
            <p>No diagnosis required. No data sold. Ever.</p>
          </div>
          <div className="pricing-grid">
            {pricingPlans.map((plan) => (
              <article className={`price-card ${plan.featured ? 'featured offset-shadow' : ''}`} key={plan.name}>
                {plan.featured && <div className="badge">Recommended</div>}
                <h3>{plan.name}</h3>
                {plan.description && <p className="pricing-note">{plan.description}</p>}
                <div className="price">
                  {plan.price}
                  {plan.suffix && <span>{plan.suffix}</span>}
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
                  onClick={() => plan.priceId ? handleUpgrade(plan.priceId) : (window.location.href = '/auth?tab=signup')}
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
            {faqs.map(([question, answer]) => (
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
          <a className="brand" href="#top">Synapse</a>
          <div className="copyright">2026 Synapse. Built for the cognitive edge.</div>
          <nav aria-label="Footer navigation">
            <a href="#top">Privacy Policy</a>
            <a href="#top">Accessibility Statement</a>
            <a href="#library">Research Library</a>
            <a href="#top">Contact Support</a>
          </nav>
        </div>
      </footer>
    </>
  );
}

export default App;
