/**
 * Facts shared by the legal pages (/privacy, /terms, /refunds), so the
 * operator's name, address and contact never disagree between them.
 */
import { SUPPORT_EMAIL } from './faq';

/** Who runs Synapse. Update here if Synapse is registered as a business. */
export const OPERATOR = {
  name: 'Akapo Abdul-Raheem',
  // City only until there is a business or virtual-office address: the repo
  // is public, so anything here is published in its history.
  address: ['Lagos, Nigeria'],
  email: SUPPORT_EMAIL,
};

export const LEGAL_PAGES = [
  { href: '/terms', label: 'Terms of Service' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/refunds', label: 'Refund Policy' },
];

/** <head> copy for each legal page, shared by main.tsx and the prerender. */
export const LEGAL_META: Record<string, { title: string; description: string }> = {
  '/privacy': {
    title: 'Privacy Policy - Synapse',
    description:
      'What Synapse collects, why, which AI and service providers handle it, how long it is kept, and how to export or delete your data.',
  },
  '/terms': {
    title: 'Terms of Service - Synapse',
    description:
      'The agreement for using Synapse: accounts, subscriptions and free trials, acceptable use, AI output, and liability.',
  },
  '/refunds': {
    title: 'Refund Policy - Synapse',
    description: 'How Synapse free trials, cancellations, and refunds work, and how to request a refund.',
  },
};
