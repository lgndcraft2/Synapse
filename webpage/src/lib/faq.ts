/**
 * Help-centre content: FAQ entries, troubleshooting guides and the contact
 * form's topic list. Kept here so the landing page and /support stay in step,
 * the same way lib/plans.ts and lib/profile.ts work.
 */

export interface FaqEntry {
  question: string;
  answer: string;
  category: string;
  /** Optional deep link to the page that now actually does this. */
  link?: { href: string; label: string };
}

export interface Guide {
  id: string;
  title: string;
  /** One line on when this guide applies, shown under the title. */
  summary: string;
  steps: string[];
  icon: string;
}

export interface Topic {
  value: string;
  label: string;
}

export const FAQS: FaqEntry[] = [
  {
    question: 'Is my reading data private?',
    answer:
      'Completely. All cognitive modeling happens on-device or via encrypted, anonymized tokens. We never see what you are reading, only how you process the structure.',
    category: 'Privacy',
  },
  {
    question: 'Does this work with Dark Mode?',
    answer:
      "Yes. Synapse layers on top of existing styles to manage contrast, line-height, and paragraph spacing regardless of the site's theme.",
    category: 'Using Synapse',
  },
  {
    question: 'What if I have multiple diagnoses?',
    answer:
      "Our engine doesn't categorize you by diagnosis, but by trait. It adapts to your specific friction points, whether they stem from ADHD, dyslexia, or fatigue.",
    category: 'Your profile',
    link: { href: '/profile', label: 'Adjust your reading profile' },
  },
  {
    question: 'Can I use it on mobile?',
    answer:
      'Currently available for Chrome. Firefox, Safari, and Edge support is on our roadmap.',
    category: 'Using Synapse',
  },
  {
    question: 'Does it translate languages?',
    answer:
      'No. We focus on structural translation, changing how information is presented visually, not the language it is written in.',
    category: 'Using Synapse',
  },
  {
    question: 'How often does the model update?',
    answer:
      'Your profile updates continuously based on your reading behaviour and the feedback you give on each section card.',
    category: 'Your profile',
    link: { href: '/profile', label: 'See your adjustments log' },
  },
  {
    question: 'Can I export my profile?',
    answer:
      'Yes. You can take your cognitive profile data to any other device or share it with specialists if you choose.',
    category: 'Privacy',
    link: { href: '/profile', label: 'Export your profile as JSON' },
  },
  {
    question: 'Is there a student discount?',
    answer:
      'We offer a 50% discount for anyone with a valid .edu email address or equivalent proof of study. Get in touch with proof of study and we will apply it to your account.',
    category: 'Billing',
    link: { href: '#contact', label: 'Request a student discount' },
  },
];

export const GUIDES: Guide[] = [
  {
    id: 'not-reformatting',
    icon: 'auto_fix_off',
    title: "Synapse isn't reformatting a page",
    summary: 'The extension is installed but nothing changes when you read.',
    steps: [
      'Check the Synapse icon is visible in your Chrome toolbar. If it is not, the extension is not installed or has been disabled at chrome://extensions.',
      'Open the popup and look at the account line. If it says you are on the anonymous free tier, you are not signed in — see "The extension says I am signed out" below.',
      'Reload the page after enabling Synapse. The extension reads the page once on load, so a page opened beforehand will not be reformatted.',
      'Some pages block extensions entirely — Chrome settings pages, the Chrome Web Store, and a few banking sites. These cannot be reformatted by any extension.',
      'If it still does nothing, send us a ticket from this page with diagnostics attached and the URL you were reading.',
    ],
  },
  {
    id: 'profile-not-syncing',
    icon: 'sync_problem',
    title: "My profile changes aren't showing in the extension",
    summary: 'You edited your reading profile on the web but the extension still uses the old one.',
    steps: [
      'Open your dashboard once while signed in. The web app hands your session to the extension there, which is also when the extension picks up profile changes.',
      'Reopen the extension popup and confirm the reading type matches what you set.',
      'If the popup still shows the old values, sign out and back in on the web, then open the dashboard again.',
    ],
  },
  {
    id: 'hit-limit',
    icon: 'speed',
    title: "I've hit my limit",
    summary: 'Synapse has stopped reformatting and mentions a daily or monthly cap.',
    steps: [
      'Explorer (free) allows 100 reformats a day and 500 in total. The daily count resets at midnight UTC.',
      'Thinker Lite allows 300 reformats a month, resetting at the start of each calendar month.',
      'Deep Thinker has no cap at all.',
      'You can see exactly where you stand on your profile page, under Plan.',
    ],
  },
  {
    id: 'paid-no-plan',
    icon: 'credit_card_off',
    title: "I paid but my plan hasn't changed",
    summary: 'Checkout completed but Synapse still shows you on the old plan.',
    steps: [
      'Give it about a minute. Stripe notifies us separately from the page you were returned to, and that notification usually lands within seconds.',
      'Reload your dashboard. The plan chip in the Plan Status card reflects the live subscription.',
      'If it still has not moved after a few minutes, do not pay again — send us a ticket with diagnostics attached and we will reconcile it against Stripe.',
    ],
  },
  {
    id: 'signed-out',
    icon: 'link_off',
    title: 'The extension says I’m signed out',
    summary: 'The popup shows the anonymous free tier even though you have an account.',
    steps: [
      'Sign in on the web first — the extension does not have its own login, it receives your session from the web app.',
      'Open your dashboard once after signing in. That is what hands the session across.',
      'Reopen the popup. The account line should now show your email and plan.',
      'If your session keeps dropping, check that Chrome is not set to clear cookies and site data on close for this site.',
    ],
  },
];

export const TOPICS: Topic[] = [
  { value: 'billing', label: 'Billing and payments' },
  { value: 'extension', label: 'The extension is not working' },
  { value: 'account', label: 'Account and sign-in' },
  { value: 'profile', label: 'My cognitive profile' },
  { value: 'accessibility', label: 'Accessibility' },
  { value: 'other', label: 'Something else' },
];

export const TOPIC_LABELS: Record<string, string> = Object.fromEntries(
  TOPICS.map((t) => [t.value, t.label]),
);

export interface SearchResults {
  faqs: FaqEntry[];
  guides: Guide[];
  total: number;
}

/** One client-side filter over both content types, matching title and body. */
export function searchContent(query: string): SearchResults {
  const q = query.trim().toLowerCase();
  if (!q) return { faqs: FAQS, guides: GUIDES, total: FAQS.length + GUIDES.length };

  const faqs = FAQS.filter(
    (f) =>
      f.question.toLowerCase().includes(q) ||
      f.answer.toLowerCase().includes(q) ||
      f.category.toLowerCase().includes(q),
  );
  const guides = GUIDES.filter(
    (g) =>
      g.title.toLowerCase().includes(q) ||
      g.summary.toLowerCase().includes(q) ||
      g.steps.some((s) => s.toLowerCase().includes(q)),
  );
  return { faqs, guides, total: faqs.length + guides.length };
}

/** Expected first response, by plan. Shown on the support page. */
export const RESPONSE_TIMES: { plan: string; label: string; time: string }[] = [
  { plan: 'free', label: 'Explorer', time: '2–3 business days' },
  { plan: 'lite', label: 'Thinker Lite', time: '1 business day' },
  { plan: 'premium', label: 'Deep Thinker', time: 'Within 24 hours' },
];

export const SUPPORT_EMAIL: string =
  import.meta.env.VITE_SUPPORT_EMAIL || 'help@support.usesynapse.cv';
