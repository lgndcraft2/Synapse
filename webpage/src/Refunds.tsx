import type { ReactNode } from 'react';
import LegalPage, { LegalSection, Mail } from './component/LegalPage';
import { TRIAL_DAYS } from './lib/plans';

/**
 * Refund Policy. Static, prerendered and hydrated like /privacy. Must agree
 * with the "Plans, trials, and payment" section of Terms.tsx.
 */

export const EFFECTIVE_DATE = '9 October 2026';

/** Days after a renewal charge in which a forgotten renewal can be refunded. */
const RENEWAL_GRACE_DAYS = 7;

const SECTIONS = [
  { id: 'summary', title: 'The short version' },
  { id: 'trial', title: 'Free trial' },
  { id: 'cancelling', title: 'Cancelling' },
  { id: 'refunds', title: 'When we give refunds' },
  { id: 'no-refunds', title: 'When we do not' },
  { id: 'plan-changes', title: 'Plan changes' },
  { id: 'deleting', title: 'Deleting your account' },
  { id: 'statutory', title: 'Your legal rights' },
  { id: 'how-to', title: 'How to ask for a refund' },
  { id: 'chargebacks', title: 'Disputes and chargebacks' },
];

function Section({ id, children }: { id: string; children: ReactNode }) {
  const title = SECTIONS.find((s) => s.id === id)?.title ?? id;
  return (
    <LegalSection id={id} title={title}>
      {children}
    </LegalSection>
  );
}

export default function Refunds() {
  return (
    <LegalPage
      title="Refund Policy"
      effectiveDate={EFFECTIVE_DATE}
      sections={SECTIONS}
      lede="How free trials, cancellations, and refunds work for Synapse subscriptions. This policy is part of our Terms of Service."
    >
      <Section id="summary">
        <ul>
          <li>Paid plans start with a {TRIAL_DAYS}-day free trial. Cancel before it ends and you pay nothing.</li>
          <li>Cancel any time. You keep your paid plan until the end of the period you have paid for.</li>
          <li>
            We do not refund partly used billing periods, but we will refund billing mistakes, and a renewal you forgot
            to cancel if you ask within {RENEWAL_GRACE_DAYS} days and have not used the paid plan since.
          </li>
        </ul>
      </Section>

      <Section id="trial">
        <p>
          Every paid plan starts with a {TRIAL_DAYS}-day free trial. You will not be charged if you cancel before the
          trial ends. The date your first payment will be taken is shown before checkout. If you do not cancel, your
          subscription begins automatically when the trial ends and the first billing period is charged.
        </p>
      </Section>

      <Section id="cancelling">
        <p>
          You can cancel at any time from your <a href="/subscription">subscription page</a>. Cancelling stops all
          future renewals. You keep access to your paid plan until the end of the period you have already paid for,
          then your account moves to the free plan. You can resume a cancelled subscription before that date without
          paying again.
        </p>
      </Section>

      <Section id="refunds">
        <p>We will refund you in full for a charge when:</p>
        <ul>
          <li>you were charged twice for the same period, or charged an amount you did not agree to;</li>
          <li>you were charged after you had already cancelled;</li>
          <li>
            your subscription renewed and you forgot to cancel, provided you ask within {RENEWAL_GRACE_DAYS} days of
            the charge and have not used the paid plan since it renewed;
          </li>
          <li>
            we removed a feature that was a material part of your plan, or closed your account without cause, in which
            case we refund the unused part of your current period;
          </li>
          <li>a refund is required by law.</li>
        </ul>
        <p>
          We may also give a refund in other situations at our discretion, for example after a long service outage.
          Doing so once does not oblige us to do it again.
        </p>
      </Section>

      <Section id="no-refunds">
        <p>Except as listed above, we do not give refunds or credits for:</p>
        <ul>
          <li>the unused part of a monthly or annual billing period after you cancel;</li>
          <li>unused usage allowance;</li>
          <li>periods in which you did not use Synapse;</li>
          <li>accounts suspended or closed because of a serious or repeated breach of our Terms of Service.</li>
        </ul>
      </Section>

      <Section id="plan-changes">
        <p>
          When you upgrade or downgrade, the price difference for the rest of your current billing period is adjusted
          on your next invoice, so you only pay for what you use on each plan. Changing plans is not treated as a
          refund request.
        </p>
      </Section>

      <Section id="deleting">
        <p>
          Deleting your account cancels your subscription <strong>immediately</strong>, and you lose access to your
          paid plan straight away. The remaining part of your billing period is not refunded. If you want to keep
          using your paid plan until the end of the period, cancel your subscription first and delete your account
          after it has ended.
        </p>
      </Section>

      <Section id="statutory">
        <p>
          Nothing in this policy limits rights you have under the consumer protection laws that apply to you, such as
          the Federal Competition and Consumer Protection Act in Nigeria, or the right to cancel a contract within
          14 days if you live in the European Union or the United Kingdom. If you are entitled to a refund under those
          laws, we will give it, including where this policy would otherwise say no.
        </p>
      </Section>

      <Section id="how-to">
        <p>Email <Mail /> from the address on your account, and include:</p>
        <ul>
          <li>the date and amount of the charge;</li>
          <li>the reason for the refund request.</li>
        </ul>
        <p>
          We reply within 3 business days. Approved refunds go back to your original payment method, usually within 5
          to 10 business days, depending on your bank. Refunds are made in the currency you paid in, and we cannot
          cover exchange-rate differences or fees charged by your bank.
        </p>
      </Section>

      <Section id="chargebacks">
        <p>
          If something looks wrong with a charge, please contact us before disputing it with your bank. We can usually
          sort it out faster. Disputing a valid charge may lead to your paid access being paused while the dispute is
          open.
        </p>
      </Section>
    </LegalPage>
  );
}
