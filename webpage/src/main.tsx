import { StrictMode, type ComponentType } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App';
import AuthPage from './AuthPage';
import Dashboard from './Dashboard';
import Billing from './Billing';
import CheckoutResult from './CheckoutResult';
import Subscription from './Subscription';
import Profile from './Profile';
import Support from './Support';
import Observer from './Observer';
import Privacy from './Privacy';
import Terms from './Terms';
import Refunds from './Refunds';
import { LEGAL_META } from './lib/legal';
import { applyRouteMeta, type RouteMeta } from './lib/seo';
import './styles.css';

const LANDING: RouteMeta = {
  title: 'Synapse - Adaptive Reading for Neurodivergent Brains',
  description:
    'Synapse is a Chrome extension that builds a living model of how you read and reformats every page in real time. Built for ADHD, dyslexia, autism, and anyone the default web tires out.',
  canonical: '/',
};

// Order matters: the specific /billing/* screens must be matched before the
// bare /billing prefix catches them. Anything unmatched falls through to the
// landing page, so it canonicalises back to "/" rather than reading as a
// duplicate of it.
const routes: { test: RegExp; component: ComponentType; meta: RouteMeta }[] = [
  {
    test: /^\/auth/,
    component: AuthPage,
    meta: {
      title: 'Sign in or create your account - Synapse',
      description: 'Sign in to Synapse, or create an account to start your cognitive profile.',
      noindex: true,
    },
  },
  {
    test: /^\/support/,
    component: Support,
    meta: {
      title: 'Support and FAQ - Synapse',
      description:
        'Answers on privacy, browser support, billing, and how the Synapse cognitive profile works - plus how to reach a human.',
      canonical: '/support',
    },
  },
  { test: /^\/privacy\/?$/, component: Privacy, meta: { ...LEGAL_META['/privacy'], canonical: '/privacy' } },
  { test: /^\/terms\/?$/, component: Terms, meta: { ...LEGAL_META['/terms'], canonical: '/terms' } },
  { test: /^\/refunds\/?$/, component: Refunds, meta: { ...LEGAL_META['/refunds'], canonical: '/refunds' } },
  {
    test: /^\/profile/,
    component: Profile,
    meta: {
      title: 'Your cognitive profile - Synapse',
      description: 'Review and adjust the reading profile Synapse has built for you.',
      noindex: true,
    },
  },
  {
    test: /^\/(subscription|billing\/manage)/,
    component: Subscription,
    meta: {
      title: 'Manage your subscription - Synapse',
      description: 'Change plan, update payment details, or cancel your Synapse subscription.',
      noindex: true,
    },
  },
  {
    test: /^\/billing\/(success|cancelled)/,
    component: CheckoutResult,
    meta: {
      title: 'Checkout - Synapse',
      description: 'Your Synapse checkout result.',
      noindex: true,
    },
  },
  {
    test: /^\/billing/,
    component: Billing,
    meta: {
      title: 'Choose your plan - Synapse',
      description: 'Review your Synapse plan before checkout.',
      noindex: true,
    },
  },
  {
    test: /^\/dashboard/,
    component: Dashboard,
    meta: {
      title: 'Dashboard - Synapse',
      description: 'Your reading stats, active profile, and adaptation history.',
      noindex: true,
    },
  },
  {
    test: /^\/observer/,
    component: Observer,
    meta: {
      title: 'Observer panel - Synapse',
      description: 'Internal Synapse operations observer.',
      noindex: true,
    },
  },
];

const { pathname } = window.location;
const match = routes.find((route) => route.test.test(pathname));
const Root = match?.component ?? App;

applyRouteMeta(match?.meta ?? { ...LANDING, noindex: pathname !== '/' });

const container = document.getElementById('root')!;
const tree = (
  <StrictMode>
    <Root />
  </StrictMode>
);

// scripts/prerender.mjs bakes the landing page and the legal pages into
// dist/, marked with data-prerendered. Hydrate those rather than repaint them.
// Every other route either has no markup or a static crawler copy
// (dist/support), which createRoot replaces.
const HYDRATABLE = new Map<ComponentType, string>([
  [App, 'landing'],
  [Privacy, 'privacy'],
  [Terms, 'terms'],
  [Refunds, 'refunds'],
]);
if (HYDRATABLE.get(Root) === container.dataset.prerendered) {
  hydrateRoot(container, tree);
} else {
  createRoot(container).render(tree);
}
