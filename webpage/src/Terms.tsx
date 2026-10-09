import type { ReactNode } from 'react';
import LegalPage, { LegalSection, Mail, OperatorAddress } from './component/LegalPage';
import { OPERATOR } from './lib/legal';
import { TRIAL_DAYS } from './lib/plans';

/**
 * Terms of Service. Static, prerendered and hydrated like /privacy. Keep
 * backend internals (limit mechanics, model routing) out of it; describe what
 * the user experiences.
 */

export const EFFECTIVE_DATE = '9 October 2026';

const SECTIONS = [
  { id: 'agreement', title: 'Agreeing to these terms' },
  { id: 'who-we-are', title: 'Who we are' },
  { id: 'service', title: 'The Service' },
  { id: 'eligibility', title: 'Who can use Synapse' },
  { id: 'accounts', title: 'Your account' },
  { id: 'plans', title: 'Plans, trials, and payment' },
  { id: 'acceptable-use', title: 'Acceptable use' },
  { id: 'your-content', title: 'Your content' },
  { id: 'ai-output', title: 'AI output and health' },
  { id: 'third-party', title: 'Third-party sites and services' },
  { id: 'our-rights', title: 'Our intellectual property' },
  { id: 'feedback', title: 'Feedback' },
  { id: 'changes-service', title: 'Changes to the Service' },
  { id: 'termination', title: 'Suspension and termination' },
  { id: 'disclaimers', title: 'Disclaimers' },
  { id: 'liability', title: 'Limitation of liability' },
  { id: 'indemnity', title: 'Indemnity' },
  { id: 'law', title: 'Governing law and disputes' },
  { id: 'changes-terms', title: 'Changes to these terms' },
  { id: 'general', title: 'General' },
  { id: 'contact', title: 'Contact' },
];

function Section({ id, children }: { id: string; children: ReactNode }) {
  const title = SECTIONS.find((s) => s.id === id)?.title ?? id;
  return (
    <LegalSection id={id} title={title}>
      {children}
    </LegalSection>
  );
}

export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      effectiveDate={EFFECTIVE_DATE}
      sections={SECTIONS}
      lede="These terms are the agreement between you and Synapse when you use our website, dashboard, and browser extension. Please read them. They cover your subscription, what you may and may not do, and the limits of our responsibility."
    >
      <Section id="agreement">
        <p>
          By creating an account, installing the extension, or otherwise using the Service, you agree to these Terms
          of Service, our <a href="/privacy">Privacy Policy</a>, and our <a href="/refunds">Refund Policy</a>. If you
          do not agree, do not use the Service. If you use Synapse on behalf of an organisation, you confirm that you
          are authorised to accept these terms for it, and “you” includes that organisation.
        </p>
      </Section>

      <Section id="who-we-are">
        <p>
          Synapse is operated by {OPERATOR.name} (“Synapse”, “we”, “us”). The website at usesynapse.cv, the Synapse
          dashboard, and the Synapse browser extension are together called the “Service”.
        </p>
        <OperatorAddress />
      </Section>

      <Section id="service">
        <p>
          Synapse helps you read and understand content on the web. Depending on your plan, you can highlight or
          circle content to have it explained, reformat pages into a structure that suits you, open PDFs in the
          Synapse viewer, and keep a reading profile that adapts to your feedback. The Service uses third-party AI
          models to produce explanations and reformatted content.
        </p>
        <p>
          Synapse is currently available for Google Chrome on desktop. Features differ between plans, as described on
          our <a href="/#pricing">pricing section</a> at the time you subscribe.
        </p>
      </Section>

      <Section id="eligibility">
        <p>
          You must be at least 13 years old to use Synapse. If you are under 18, or under the age of legal majority
          where you live, you may use Synapse only with the permission of a parent or guardian, who agrees to these
          terms on your behalf and is responsible for your use, including any payments.
        </p>
      </Section>

      <Section id="accounts">
        <ul>
          <li>Give accurate information when you sign up, and keep your email address up to date.</li>
          <li>
            Keep your password secure and do not share your account. You are responsible for activity on your account
            unless it results from our failure to keep the Service secure.
          </li>
          <li>Tell us straight away at <Mail /> if you think someone else has access to your account.</li>
          <li>One person per account. Accounts may not be shared, resold, or transferred.</li>
        </ul>
        <p>
          You can delete your account at any time from your profile page. Deleting your account cancels any active
          subscription immediately and permanently deletes your data, as described in the Privacy Policy.
        </p>
      </Section>

      <Section id="plans">
        <h3>Free and paid plans</h3>
        <p>
          Synapse offers a free plan and paid subscription plans. Each plan includes the features and usage allowances
          shown when you subscribe. Usage allowances reset each period and unused allowance does not carry over.
        </p>

        <h3>Free trial</h3>
        <p>
          Paid plans start with a {TRIAL_DAYS}-day free trial. You need to add a payment method to start it. If you do
          not cancel before the trial ends, your subscription starts automatically and you are charged for the first
          billing period. You can only have one free trial.
        </p>

        <h3>Billing and automatic renewal</h3>
        <p>
          Subscriptions are billed in advance, monthly or annually depending on the option you choose, and{' '}
          <strong>renew automatically</strong> at the end of each period at the then-current price until you cancel.
          Prices are shown in US dollars unless stated otherwise. Your bank may charge currency conversion or
          international transaction fees, which are your responsibility. Prices may not include taxes, which we will
          add where the law requires.
        </p>
        <p>
          Payments are processed by our payment provider, Stripe, under its own terms. You authorise us and Stripe to
          charge your payment method for each billing period, and for any plan change you make.
        </p>

        <h3>Changing plans</h3>
        <p>
          You can upgrade or downgrade at any time from your subscription page. When you change plans, the price
          difference for the rest of the current period is adjusted on your next invoice.
        </p>

        <h3>Cancelling</h3>
        <p>
          You can cancel at any time from your subscription page. Cancelling stops future renewals. You keep access to
          your paid plan until the end of the period you have paid for, after which your account moves to the free
          plan. Refunds are covered by our <a href="/refunds">Refund Policy</a>.
        </p>

        <h3>Price changes</h3>
        <p>
          We may change our prices. We will tell you at least 30 days before a price change affects your subscription,
          and the new price applies from your next renewal after that notice. If you do not agree, you can cancel
          before the change takes effect.
        </p>

        <h3>Failed payments</h3>
        <p>
          If a payment fails, we may retry it and ask you to update your payment method. If payment is still not
          received, we may move your account to the free plan.
        </p>

        <h3>Discounts</h3>
        <p>
          Student and regional pricing is offered at our discretion, may require proof of eligibility, and may be
          withdrawn if eligibility ends or the proof provided was not genuine.
        </p>
      </Section>

      <Section id="acceptable-use">
        <p>You agree not to:</p>
        <ul>
          <li>use the Service for anything illegal, or to infringe anyone’s rights, including copyright and privacy;</li>
          <li>
            submit content you do not have the right to use, or other people’s personal information without a lawful
            reason;
          </li>
          <li>
            try to get around plan limits, usage allowances, or security measures, including by creating multiple
            accounts or free trials;
          </li>
          <li>
            access the Service through automated means such as bots, scripts, or scrapers, or use it to build a
            competing product;
          </li>
          <li>
            copy, modify, decompile, or reverse engineer the Service, its extension, or its software, except where the
            law expressly allows it;
          </li>
          <li>resell, sublicense, or provide the Service to others as part of your own service;</li>
          <li>
            interfere with or overload the Service, or try to gain unauthorised access to it, its systems, or other
            users’ accounts;
          </li>
          <li>
            use the Service to create harmful, abusive, or deceptive content, or in breach of the usage policies of
            the AI providers we rely on.
          </li>
        </ul>
      </Section>

      <Section id="your-content">
        <p>
          “Your content” means the text, images, and other material you send to Synapse, such as passages you
          highlight, areas you circle, pages you reformat, notes, and feedback. You keep all rights you have in your
          content. You give us a worldwide, non-exclusive, royalty-free licence to use, process, and store your
          content only as needed to provide, secure, and improve the Service for you, including sending it to our AI
          providers. This licence ends when your content is deleted, except for copies we must keep by law.
        </p>
        <p>
          You are responsible for your content and for making sure you are allowed to submit it. Explanations and
          reformatted content produced for you are yours to use, subject to any rights others have in the original
          material and to applicable law.
        </p>
      </Section>

      <Section id="ai-output">
        <p>
          Explanations and reformatted content are generated by AI and can be incomplete, inaccurate, or out of date.
          Check anything important against the original source. Synapse is a reading aid. It is not medical,
          psychological, legal, financial, or other professional advice.
        </p>
        <p>
          Synapse is designed to support people with ADHD, dyslexia, autism, and others who find dense content hard
          to read, but it is <strong>not a medical device</strong>. It does not diagnose, treat, or monitor any
          condition, and your reading profile is not a clinical assessment.
        </p>
      </Section>

      <Section id="third-party">
        <p>
          Synapse works on websites and documents owned by others. We do not control and are not responsible for
          them, and using Synapse on a site does not give you any extra rights to its content. The Service relies on
          third-party providers, such as AI model providers, Google sign-in, and Stripe, whose own terms may also
          apply to you.
        </p>
      </Section>

      <Section id="our-rights">
        <p>
          The Service, including its software, extension, design, text, graphics, and the Synapse name and logo, is
          owned by us or our licensors and protected by intellectual property laws. Subject to these terms, we give
          you a personal, non-exclusive, non-transferable, revocable licence to use the Service for your own personal
          or internal purposes. All rights not expressly granted are reserved.
        </p>
      </Section>

      <Section id="feedback">
        <p>
          If you send us suggestions or ideas, we may use them without any obligation to you. This does not cover your
          content or the feedback ratings you give on results, which are handled under the Privacy Policy.
        </p>
      </Section>

      <Section id="changes-service">
        <p>
          We are constantly improving Synapse and may add, change, or remove features. The extension may update
          automatically. If we remove a feature that is a material part of a paid plan you are subscribed to, we will
          tell you in advance where we reasonably can, and you may cancel and request a refund for the unused part of
          your current period.
        </p>
      </Section>

      <Section id="termination">
        <p>
          We may suspend or close your account, or limit your use of the Service, if you seriously or repeatedly break
          these terms, if your use creates a risk or legal exposure for us or others, if payment fails, or if the law
          requires it. Where reasonable, we will tell you why and give you a chance to fix the problem first. If we
          close your account without cause, we will refund the unused part of any prepaid period.
        </p>
        <p>
          You can stop using the Service and delete your account at any time. Sections that by their nature should
          continue after termination, including those on content, disclaimers, liability, indemnity, and governing
          law, continue to apply.
        </p>
      </Section>

      <Section id="disclaimers">
        <p>
          To the fullest extent allowed by law, the Service is provided <strong>“as is” and “as available”</strong>,
          without warranties of any kind, whether express or implied, including warranties of merchantability, fitness
          for a particular purpose, accuracy, and non-infringement. We do not promise that the Service will be
          uninterrupted, error-free, or work on every website or document. Nothing in these terms limits rights you
          have under consumer protection laws that cannot be excluded.
        </p>
      </Section>

      <Section id="liability">
        <p>To the fullest extent allowed by law:</p>
        <ul>
          <li>
            we are not liable for indirect, incidental, special, consequential, or punitive damages, or for loss of
            profits, revenue, data, or goodwill, arising from your use of the Service;
          </li>
          <li>
            our total liability for any claim relating to the Service is limited to the greater of the amount you paid
            us in the 12 months before the claim arose, or US$50.
          </li>
        </ul>
        <p>
          These limits do not apply to liability that cannot be limited by law, such as for death or personal injury
          caused by negligence, or for fraud.
        </p>
      </Section>

      <Section id="indemnity">
        <p>
          To the extent allowed by law, you agree to compensate us for claims, losses, and reasonable costs, including
          legal fees, arising from content you submit or your breach of these terms. This does not apply if you are
          using the Service as a consumer in a country where such terms are not permitted.
        </p>
      </Section>

      <Section id="law">
        <p>
          These terms are governed by the laws of the Federal Republic of Nigeria. Before starting any formal dispute,
          please email us at <Mail /> so we can try to resolve it informally. If we cannot resolve it within 30 days,
          either of us may bring the dispute before the courts of Lagos State, Nigeria.
        </p>
        <p>
          If you are a consumer, you also keep the protection of the mandatory laws of the country where you live, and
          you may bring proceedings in your local courts where those laws allow it.
        </p>
      </Section>

      <Section id="changes-terms">
        <p>
          We may update these terms. The effective date at the top shows when they last changed. If a change is
          material, we will tell you by email or in the Service at least 30 days before it takes effect. If you keep
          using Synapse after that, you accept the new terms. If you do not agree, you can cancel and delete your
          account before they take effect.
        </p>
      </Section>

      <Section id="general">
        <ul>
          <li>
            These terms, together with the Privacy Policy and Refund Policy, are the whole agreement between you and
            us about the Service.
          </li>
          <li>If any part of these terms is found unenforceable, the rest stays in effect.</li>
          <li>If we do not enforce a right straight away, we have not given it up.</li>
          <li>
            You may not transfer your rights under these terms. We may transfer ours, for example if Synapse is
            registered as a company or sold, and will tell you if that happens.
          </li>
          <li>
            We are not responsible for delays or failures caused by events outside our reasonable control, such as
            outages at our providers, power or network failures, or natural disasters.
          </li>
        </ul>
      </Section>

      <Section id="contact">
        <p>
          Questions about these terms? Email <Mail />.
        </p>
      </Section>
    </LegalPage>
  );
}
