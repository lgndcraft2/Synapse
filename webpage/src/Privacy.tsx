import type { ReactNode } from 'react';
import LegalPage, { LegalSection, Mail, OperatorAddress } from './component/LegalPage';
import { OPERATOR } from './lib/legal';

/**
 * The privacy policy. Static on purpose: it renders at build time
 * (scripts/prerender.mjs) and hydrates, so it must not read window, storage
 * or the session during render.
 *
 * Every claim here is checked against the code. When the backend starts
 * collecting something new, or a retention window changes, update this page
 * and EFFECTIVE_DATE in the same change. Keep backend internals out of it.
 */

export const EFFECTIVE_DATE = '9 October 2026';

const SECTIONS: { id: string; title: string }[] = [
  { id: 'summary', title: 'The short version' },
  { id: 'who-we-are', title: 'Who we are' },
  { id: 'what-we-collect', title: 'What we collect' },
  { id: 'how-we-use', title: 'How we use it' },
  { id: 'legal-bases', title: 'Legal bases' },
  { id: 'ai', title: 'AI processing' },
  { id: 'sharing', title: 'Who we share it with' },
  { id: 'sensitive', title: 'Information about how you think' },
  { id: 'storage', title: 'Cookies and local storage' },
  { id: 'retention', title: 'How long we keep it' },
  { id: 'rights', title: 'Your rights and choices' },
  { id: 'security', title: 'Security' },
  { id: 'transfers', title: 'International transfers' },
  { id: 'children', title: 'Children' },
  { id: 'extension', title: 'The Chrome extension' },
  { id: 'google', title: 'Signing in with Google' },
  { id: 'us-states', title: 'Notice for US residents' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'Contact and complaints' },
];

function Section({ id, children }: { id: string; children: ReactNode }) {
  const title = SECTIONS.find((s) => s.id === id)?.title ?? id;
  return (
    <LegalSection id={id} title={title}>
      {children}
    </LegalSection>
  );
}

const RETENTION: [string, string][] = [
  ['Account, reading profile, and profile change history', 'Until you delete your account.'],
  ['Reading sessions and feedback', 'Until you delete your account.'],
  ['Saved explanation history (paid plans)', 'Until you delete the entry, clear your history, or delete your account. Thumbnails are deleted automatically after 30 days.'],
  ['Page or document context used for an explanation', 'Held in a temporary cache for up to 1 hour, then discarded.'],
  ['Text and images sent to an AI provider', 'Not stored by us after the response is returned, except as saved history on paid plans. The provider’s own retention terms apply (see AI processing).'],
  ['Sign-in sessions and email links', 'Expire automatically after a limited period.'],
  ['Usage counters', 'Reset at the end of each limit period. Records used to prevent abuse may be kept after account deletion, but are no longer linked to you.'],
  ['Technical records of AI requests', 'Kept for cost and reliability reporting. They contain no page content and are unlinked from you when you delete your account.'],
  ['Support tickets', 'Kept so we can refer back to past conversations. Unlinked from your account when you delete it; ask us and we will delete them.'],
  ['Billing records', 'Kept by Stripe and by us for as long as tax and accounting law requires.'],
];

export default function Privacy() {
  const mail = <Mail />;

  return (
    <LegalPage
      title="Privacy Policy"
      effectiveDate={EFFECTIVE_DATE}
      sections={SECTIONS}
      lede="Synapse helps you read and understand the web. To do that it has to see the parts of a page you ask it about. This policy explains exactly what we collect, why, who else handles it, and how to get it deleted."
    >
        <Section id="summary">
          <ul>
            <li>
              Synapse only sends page content to us when you ask it to: when you highlight, circle, or reformat
              something. It does not track the sites you visit in the background.
            </li>
            <li>
              That content is processed by an AI model from Google (Gemini) or Anthropic (Claude) to produce your
              result.
            </li>
            <li>We do not sell your personal information, show ads, or share your data for advertising.</li>
            <li>We do not train our own AI models on what you read.</li>
            <li>
              Your reading profile describes how you prefer information to be presented. We never ask for a
              diagnosis.
            </li>
            <li>You can export your profile and delete your account, and everything linked to it, at any time.</li>
          </ul>
        </Section>

        <Section id="who-we-are">
          <p>
            Synapse is operated by {OPERATOR.name} (“Synapse”, “we”, “us”), who runs the website at usesynapse.cv,
            the Synapse dashboard, and the Synapse browser extension (together, the “Service”). We are the data
            controller for the personal information described in this policy.
          </p>
          <OperatorAddress />
          <p>For anything privacy-related, including requests to exercise your rights, email us at the address above.</p>
        </Section>

        <Section id="what-we-collect">
          <h3>Account information</h3>
          <p>
            When you create an account we collect your email address and, optionally, your name and a choice of
            preset avatar. If you sign up with a password, we never store the password itself, only a securely
            encrypted form of it. If you sign in with Google we receive your Google account identifier, email address,
            name, and profile picture from Google. We also record when you verified your email address, when you
            last signed in, and when you accepted our Terms of Service and Privacy Policy, and which version.
          </p>

          <h3>Your reading profile</h3>
          <p>
            During onboarding you answer a few questions about how you process information. From your answers we
            set a reading profile (Load Reducer, Comprehension Gap, or Hyperfocus Reader) and your preferences for
            how information is presented to you. You can add free-text
            notes. Synapse adjusts these settings over time based on your feedback and keeps a log of each change,
            which you can see on your profile page.
          </p>

          <h3>Content you ask us to explain or reformat</h3>
          <p>When you use Synapse on a page or document, the extension sends us:</p>
          <ul>
            <li>the text you highlighted, or an image of the area you circled, which you confirm before it is sent;</li>
            <li>the surrounding paragraph, so the explanation makes sense in place;</li>
            <li>
              more of the page or document as context, if page context is switched on. On email, messaging, and
              banking sites this is off unless you turn it on for that site;
            </li>
            <li>for reformatting, the text of the section or page you asked to reformat;</li>
            <li>the address (URL) and title of the page;</li>
            <li>your reading profile settings, so the result suits you.</li>
          </ul>
          <p>
            We use this content to produce your result. Apart from saved history on paid plans (below), we do not
            keep the text or images after the response has been returned.
          </p>

          <h3>Explanation history</h3>
          <p>
            On paid plans, Synapse saves your explanations so you can find them again on each site. A saved entry holds
            the site and page address, the page title, an excerpt of the explained text, the explanation
            and any re-explained versions, its position on the page, and, for circled areas, a small thumbnail image.
            The full-size image sent to the AI model is never stored. On the free plan, explanations are not saved on
            our servers.
          </p>

          <h3>Usage and feedback</h3>
          <p>
            We record reading sessions (page address and title, and how you used Synapse on the page) and the
            feedback you give on results, such as your rating, any note you write, time spent, and how far you read.
            This powers your dashboard statistics and is how your profile adapts. We count how much you use the
            Service to apply plan limits.
          </p>
          <p>
            We also keep technical records of AI requests that contain no page content, which we use to monitor cost
            and reliability.
          </p>

          <h3>Payment information</h3>
          <p>
            Payments are handled by Stripe. We never receive or store your full card number. We keep your Stripe
            customer and subscription identifiers, your plan, billing period, subscription status, and trial, renewal,
            and cancellation dates.
          </p>

          <h3>Support requests</h3>
          <p>
            When you contact support we keep your email address, the topic, subject, message, and our reply. You can
            choose to attach diagnostics: your plan, reading profile type, extension version, and browser details. You
            can untick this before sending.
          </p>

          <h3>Security and technical data</h3>
          <p>
            For each signed-in session we store the IP address and browser details it started from, to protect your
            account. We use IP addresses to prevent abuse and to apply usage limits. Our servers keep short-lived
            operational logs to keep the Service running.
          </p>

          <h3>Using Synapse without an account</h3>
          <p>
            You can try the extension without signing in. To apply free-tier limits, the extension creates a random
            identifier for your installation. We use it, together with your IP address, in a form that does not
            identify you directly.
          </p>

          <h3>What we do not collect</h3>
          <p>
            The extension does not record your browsing history, read pages you have not asked it about, or send
            anything in the background as you browse. We do not use advertising or analytics trackers on our website.
          </p>
        </Section>

        <Section id="how-we-use">
          <p>We use personal information to:</p>
          <ul>
            <li>provide the Service: produce explanations and reformatted pages, and keep your history and profile;</li>
            <li>personalise results to your reading profile and adapt that profile from your feedback;</li>
            <li>create and secure your account, keep you signed in, and send verification and password-reset emails;</li>
            <li>process payments, manage subscriptions, and apply plan limits;</li>
            <li>answer support requests;</li>
            <li>prevent abuse, fraud, and attacks, and keep the Service reliable;</li>
            <li>understand aggregate usage and cost so we can improve the Service;</li>
            <li>meet legal obligations, such as tax and accounting rules.</li>
          </ul>
          <p>We do not make decisions about you that have legal or similarly significant effects by automated means.</p>
        </Section>

        <Section id="legal-bases">
          <p>
            Where data-protection laws such as the Nigeria Data Protection Act 2023, the EU or UK General Data
            Protection Regulation require a legal basis, we rely on:
          </p>
          <ul>
            <li>
              <strong>Contract:</strong> to provide the Service you signed up for, including processing the content you
              send us, your account, profile, and billing.
            </li>
            <li>
              <strong>Consent:</strong> for information you choose to give us about how you think or any condition you
              mention, for using page context on sensitive sites, and for attaching diagnostics to support tickets. You
              can withdraw consent at any time.
            </li>
            <li>
              <strong>Legitimate interests:</strong> to secure the Service, prevent abuse, and understand aggregate
              usage, where those interests are not overridden by your rights.
            </li>
            <li>
              <strong>Legal obligation:</strong> to keep financial records and respond to lawful requests.
            </li>
          </ul>
        </Section>

        <Section id="ai">
          <p>
            Explanations and reformatting are produced by third-party AI models from Google (Gemini) and Anthropic
            (Claude). The content described above is sent to the provider for each request, and the provider returns the
            result to us.
          </p>
          <p>
            These providers process the content under their own terms and privacy policies, which govern how long they
            keep it and whether they may use it to improve their services:{' '}
            <a href="https://policies.google.com/privacy" rel="noopener noreferrer">Google Privacy Policy</a>,{' '}
            <a href="https://ai.google.dev/gemini-api/terms" rel="noopener noreferrer">Gemini API Terms</a>, and{' '}
            <a href="https://www.anthropic.com/legal/privacy" rel="noopener noreferrer">Anthropic Privacy Policy</a>.
            AI output can be wrong. Do not rely on an explanation for medical, legal, or financial decisions.
          </p>
          <p>
            Please do not explain passwords, card numbers, or other information you would not want an AI provider to
            process. Circled areas are shown to you before they are sent, so you can check nothing private is inside.
          </p>
        </Section>

        <Section id="sharing">
          <p>We share personal information only with service providers who help us run the Service:</p>
          <ul>
            <li><strong>Google (Gemini API)</strong> and <strong>Anthropic (Claude API)</strong>: AI processing.</li>
            <li><strong>Google</strong>: sign in with Google, if you choose it.</li>
            <li><strong>Stripe</strong>: payments and subscriptions.</li>
            <li><strong>Resend</strong>: sending account and support emails.</li>
            <li><strong>Upstash</strong>: temporary caching and rate-limit counters.</li>
            <li>
              <strong>Cloud hosting, database, and storage providers</strong>: running our servers, storing our
              database, and holding history thumbnails.
            </li>
            <li><strong>Google Fonts</strong>: our website loads fonts from Google, which receives your IP address.</li>
          </ul>
          <p>We may also disclose information:</p>
          <ul>
            <li>if required by law, or to respond to a valid legal request;</li>
            <li>to protect the rights, safety, or property of our users, the public, or Synapse;</li>
            <li>
              as part of a merger, acquisition, or sale of assets, in which case this policy will continue to apply to
              your information, or you will be told before a different policy applies.
            </li>
          </ul>
          <p>We do not sell personal information and do not share it for targeted advertising.</p>
        </Section>

        <Section id="sensitive">
          <p>
            Synapse is built for people with ADHD, dyslexia, autism, and others who find dense pages tiring, but it
            never asks for a diagnosis. Your reading profile describes presentation preferences, not a condition.
            Even so, we recognise that a profile, or anything you write in your notes or feedback, could suggest
            something about your health. We treat all profile data as sensitive. We use it only to personalise your
            results, never share it for any other purpose, and delete it when you delete your account. If you choose to
            mention a diagnosis anywhere in the Service, you consent to us processing it for that purpose only.
          </p>
        </Section>

        <Section id="storage">
          <p>
            Our website does not use advertising or analytics cookies. When you sign in, your session is stored in
            your browser’s local storage so you stay signed in. Clearing your site data signs you out. The extension
            uses the browser’s extension storage to keep your session, your settings (such as page context on or off),
            your reading profile, and which results you have rated. Circled areas waiting for confirmation, and the
            last few circled areas (kept for up to an hour so a re-explain can look again), are held in the browser’s
            memory only and are cleared when the browser closes.
          </p>
        </Section>

        <Section id="retention">
          <p>We keep personal information only as long as we need it:</p>
          <div className="legal-table-wrap">
            <table className="legal-table">
              <thead>
                <tr>
                  <th scope="col">Information</th>
                  <th scope="col">How long</th>
                </tr>
              </thead>
              <tbody>
                {RETENTION.map(([what, howLong]) => (
                  <tr key={what}>
                    <td>{what}</td>
                    <td>{howLong}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Deleting your account cancels any subscription and permanently deletes your account, profile, profile
            history, reading sessions, feedback, saved explanations, and thumbnails. Records we keep afterwards, as
            listed above, are no longer linked to you.
          </p>
        </Section>

        <Section id="rights">
          <p>Depending on where you live, you may have the right to:</p>
          <ul>
            <li>access the personal information we hold about you and get a copy;</li>
            <li>correct information that is wrong;</li>
            <li>delete your information;</li>
            <li>receive your information in a portable format;</li>
            <li>object to, or ask us to restrict, certain processing;</li>
            <li>withdraw consent where we rely on it;</li>
            <li>complain to a data-protection authority.</li>
          </ul>
          <p>Several of these you can do yourself, straight away:</p>
          <ul>
            <li>
              <strong>Edit or export your profile:</strong> on your <a href="/profile">profile page</a>, including a
              JSON export of your profile and recent history.
            </li>
            <li>
              <strong>Delete saved explanations:</strong> one at a time or a whole site from the history panel in the
              extension, or everything at once from your profile page.
            </li>
            <li>
              <strong>Turn off page context:</strong> from the panel in the extension.
            </li>
            <li>
              <strong>Delete your account:</strong> from your profile page.
            </li>
          </ul>
          <p>
            For anything else, email {mail}. We will respond within 30 days, and may need to confirm your identity
            first. We will not treat you differently for exercising your rights.
          </p>
        </Section>

        <Section id="security">
          <p>
            We use industry-standard measures to protect your information, including encryption in transit (HTTPS),
            secure storage of passwords and sign-in credentials, abuse protection, and access controls that limit
            internal access to what is needed to run the Service. No system is completely secure.
            If we learn of a breach that affects your personal information, we will notify you and the relevant
            authorities as the law requires.
          </p>
        </Section>

        <Section id="transfers">
          <p>
            Our service providers operate in several countries, including the United States, so your information may
            be processed outside the country where you live. Where the law requires it, we rely on appropriate
            safeguards for these transfers, such as standard contractual clauses or the provider’s own transfer
            mechanisms.
          </p>
        </Section>

        <Section id="children">
          <p>
            The Service is not for children under 13, and we do not knowingly collect their information. If you are
            under 18, or under the age of digital consent where you live, you may use Synapse only with the permission
            of a parent or guardian. If you believe a child has given us personal information without that permission,
            email {mail} and we will delete it.
          </p>
        </Section>

        <Section id="extension">
          <p>The Synapse extension asks Chrome for these permissions:</p>
          <ul>
            <li>
              <strong>Access to the sites you visit:</strong> so you can highlight, circle, and reformat on any page.
              The extension reads a page only when you use it there.
            </li>
            <li>
              <strong>Active tab and screen capture:</strong> to capture the area you circle, after you confirm it.
            </li>
            <li><strong>Scripting:</strong> to show the Synapse panel and reading tools on the page.</li>
            <li><strong>Tabs:</strong> to open the Synapse PDF viewer and link the extension to your account.</li>
            <li><strong>Storage:</strong> to keep your session and settings in your browser.</li>
          </ul>
          <p>
            The use of information received from Chrome APIs adheres to the{' '}
            <a href="https://developer.chrome.com/docs/webstore/program-policies/" rel="noopener noreferrer">
              Chrome Web Store User Data Policy
            </a>
            , including the Limited Use requirements. We use this information only to provide and improve the
            Service’s single purpose of helping you read and understand content. We do not sell it, use it for
            advertising, or let humans read it, except with your permission, for security, or where the law requires.
          </p>
        </Section>

        <Section id="google">
          <p>
            If you sign in with Google, we receive only your basic profile (Google account identifier, name, email
            address, and profile picture) and use it only to create and sign in to your Synapse account. Synapse’s use
            and transfer of information received from Google APIs adheres to the{' '}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener noreferrer">
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
        </Section>

        <Section id="us-states">
          <p>
            If you live in California or another US state with a consumer privacy law: in the last 12 months we have
            collected identifiers (such as email address and IP address), commercial information (plan and
            subscription), internet activity related to your use of the Service (page addresses and content you asked
            us about), and inferences about your reading preferences, from you and your use of the Service, for the
            purposes described above. We have not sold or shared personal information for cross-context behavioural
            advertising, and we do not use sensitive personal information to infer characteristics about you beyond
            what is needed to provide the Service. You have the right to know, correct, and delete your information,
            and to appoint an authorised agent to make a request for you.
          </p>
        </Section>

        <Section id="changes">
          <p>
            We will update this policy as Synapse changes. The effective date at the top shows when it last changed.
            If a change materially affects how we use your information, we will tell you by email or in the Service
            before it takes effect.
          </p>
        </Section>

        <Section id="contact">
          <p>Questions, requests, or complaints: email {mail}.</p>
          <p>
            If you are not satisfied with our response, you can complain to your local data-protection authority. In
            Nigeria this is the{' '}
            <a href="https://ndpc.gov.ng" rel="noopener noreferrer">Nigeria Data Protection Commission</a>. In the EU,
            it is the supervisory authority in your country, and in the UK the Information Commissioner’s Office.
          </p>
        </Section>

    </LegalPage>
  );
}
