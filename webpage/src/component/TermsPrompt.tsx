import { useEffect, useRef, useState } from 'react';
import { acceptCurrentTerms } from '../lib/auth';

/**
 * Asks a signed-in user to accept the current Terms of Service and Privacy
 * Policy. Shown by AppHeader while user.needs_terms_acceptance is true: for
 * accounts created before acceptance was recorded, and for everyone after
 * TERMS_VERSION is bumped on the backend.
 *
 * Modal on purpose: the record is only meaningful if the person actually saw
 * the documents. The only ways out are accepting or signing out.
 */
export default function TermsPrompt({
  hasAcceptedBefore,
  onSignOut,
}: {
  /** Changes the wording from "please accept" to "we've updated". */
  hasAcceptedBefore: boolean;
  onSignOut: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await acceptCurrentTerms();
      dialogRef.current?.close();
      setDone(true);
    } catch {
      setError('We could not save that. Please check your connection and try again.');
      setBusy(false);
    }
  }

  if (done) return null;

  return (
    <dialog
      ref={dialogRef}
      className="terms-dialog"
      aria-labelledby="terms-dialog-title"
      // Escape would close a native modal; this one needs an explicit answer.
      onCancel={(event) => event.preventDefault()}
    >
      <h2 id="terms-dialog-title">
        {hasAcceptedBefore ? 'We’ve updated our terms' : 'Please review our terms'}
      </h2>
      <p>
        {hasAcceptedBefore
          ? 'Our Terms of Service and Privacy Policy have changed. Please read them and accept to keep using Synapse.'
          : 'Before you continue, please read our Terms of Service and Privacy Policy and accept them to keep using Synapse.'}
      </p>
      <ul className="terms-dialog-links">
        <li>
          <a href="/terms" target="_blank" rel="noopener">Terms of Service</a>
        </li>
        <li>
          <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>
        </li>
        <li>
          <a href="/refunds" target="_blank" rel="noopener">Refund Policy</a>
        </li>
      </ul>

      <label className="auth-terms">
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(event) => setChecked(event.target.checked)}
        />
        <span>I agree to the Terms of Service and Privacy Policy.</span>
      </label>

      {error && (
        <p className="terms-dialog-error" role="alert">
          {error}
        </p>
      )}

      <div className="terms-dialog-actions">
        <button type="button" className="button button-secondary" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={accept}
          disabled={!checked || busy}
        >
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </dialog>
  );
}
