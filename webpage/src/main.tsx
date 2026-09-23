import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthPage from './AuthPage';
import Dashboard from './Dashboard';
import Billing from './Billing';
import CheckoutResult from './CheckoutResult';
import Subscription from './Subscription';
import Profile from './Profile';
import Support from './Support';
import Observer from './Observer';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
