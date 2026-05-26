const navItems = ['Profile Engine', 'Solutions', 'Library', 'How it Works'];

const loopSteps = [
  { icon: 'visibility', title: 'Observe', text: 'Tracks reading patterns and friction points.' },
  { icon: 'model_training', title: 'Adapt', text: 'Updates your cognitive baseline model.' },
  { icon: 'auto_awesome', title: 'Refine', text: 'Delivers a clearer web next time.', active: true },
];

const howItWorks = [
  {
    icon: 'arrow_back_ios',
    title: '1. Onboard',
    text: 'A 2-minute calibration captures your baseline reading speed and retention patterns.',
  },
  {
    icon: 'add',
    title: '2. Browse',
    text: 'Read naturally across any site. Synapse learns where your attention breaks in real time.',
  },
  {
    icon: 'layers',
    title: '3. It Learns',
    text: 'Your profile updates weekly, automatically adjusting layouts to your changing needs.',
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
    features: ['Web reformatting', 'Single profile'],
    cta: 'Start Free',
  },
  {
    name: 'Deep Thinker',
    price: '$8',
    suffix: '/mo',
    features: ['Full Google Docs/PDF support', 'Cognitive pattern insights', 'Multiple reading profiles'],
    cta: 'Go Pro',
    featured: true,
  },
  {
    name: 'Campus',
    price: 'Custom',
    features: ['Institutional SSO', 'Bulk seat management'],
    cta: 'Contact Sales',
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
    'The extension is currently available for desktop browsers: Chrome, Safari, and Edge. A dedicated mobile reading app is on our roadmap.',
  ],
  [
    'Does it translate languages?',
    'No. We focus on structural translation, changing how information is presented visually, not the language it is written in.',
  ],
  [
    'How often does the model update?',
    'The engine recalibrates every Sunday based on your weekly browsing habits to ensure the UI stays in sync with your needs.',
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
  ['Now', 'v2.0 Engine with multi-device sync', true],
  ['Next', 'Native iOS/Android Safari extension'],
  ['Later', 'OpenAPI for third-party adaptive apps'],
  ['Future', 'Cognitive-first operating system'],
];

function Icon({ name }: { name: string }) {
  return (
    <span className="material-symbols-outlined" aria-hidden="true">
      {name}
    </span>
  );
}

function App() {
  return (
    <>
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
          <button className="button button-primary nav-cta">Get Extension</button>
          <button className="icon-button menu-button" aria-label="Open navigation">
            <Icon name="menu" />
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero page-section">
          <div className="hero-grid">
            <div className="hero-copy">
              <h1>The internet wasn't built for your brain. Synapse is.</h1>
              <p>
                Traditional accessibility tools apply fixed presets and forget you. Synapse builds a persistent,
                evolving model of how you actually process information, reformatting every page you read in real time.
              </p>
              <div className="button-row">
                <button className="button button-primary">Get the Extension</button>
                <button className="button button-secondary">See how it works</button>
              </div>
            </div>
            <div className="hero-visual offset-shadow" aria-label="Digital text being reorganized into clearer reading blocks">
              <div className="browser-card">
                <div className="line line-wide" />
                <div className="line" />
                <div className="line line-mid" />
                <div className="divider" />
                <div className="transform-row">
                  <div className="focus-block" />
                  <div className="structured-lines">
                    <div />
                    <div />
                    <div />
                  </div>
                </div>
              </div>
            </div>
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
                  <div className={`loop-icon ${step.active ? 'active' : ''}`}>
                    <Icon name={step.icon} />
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </article>
                {index < loopSteps.length - 1 && <Icon name="arrow_forward" />}
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
                  <div className="step-icon">
                    <Icon name={step.icon} />
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </article>
              ))}
            </div>
            <blockquote className="quote">
              <p>"After 20 pages, Synapse knows how you read better than any tool you have ever used."</p>
            </blockquote>
          </div>
        </section>

        <section className="market full-section">
          <div className="content-grid">
            <div className="stats-grid">
              {stats.map(([value, label]) => (
                <article className="stat-card" key={label}>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </article>
              ))}
            </div>
            <aside className="compliance-card">
              <h3>Regulatory Compliance</h3>
              <p>
                Synapse doesn't just meet WCAG/ADA standards. It exceeds them by providing individualized accommodation
                that static checklists can't match.
              </p>
            </aside>
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

        <section className="pricing full-section">
          <div className="section-heading">
            <h2>Choose Your Flow</h2>
            <p>No diagnosis required. No data sold. Ever.</p>
          </div>
          <div className="pricing-grid">
            {pricingPlans.map((plan) => (
              <article className={`price-card ${plan.featured ? 'featured offset-shadow' : ''}`} key={plan.name}>
                {plan.featured && <div className="badge">Recommended</div>}
                <h3>{plan.name}</h3>
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
                <button className={`button ${plan.featured ? 'button-primary' : 'button-secondary'}`}>{plan.cta}</button>
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
          <div className="copyright">2024 Synapse. Built for the cognitive edge.</div>
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
