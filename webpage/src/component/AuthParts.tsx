import { Check, Eye, EyeOff } from 'lucide-react';
import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { BrandLockup } from './Brand';

/**
 * Building blocks for /auth. Every screen there is a short form, so the field,
 * button and error pieces live here and the page itself only describes flows.
 */

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

interface FieldProps extends InputProps {
  label: string;
  hint?: ReactNode;
  /** Sits on the label row, right-aligned — e.g. the "Forgot?" link. */
  action?: ReactNode;
}

export function Field({ label, hint, action, ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="auth-field">
      <div className="auth-label-row">
        <label htmlFor={id}>{label}</label>
        {action}
      </div>
      <input className="auth-input" id={id} aria-describedby={hintId} {...input} />
      {hint && (
        <p className="auth-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function PasswordField({ label, hint, action, ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className="auth-field">
      <div className="auth-label-row">
        <label htmlFor={id}>{label}</label>
        {action}
      </div>
      <div className="auth-input-wrap">
        <input
          className="auth-input"
          id={id}
          aria-describedby={hintId}
          {...input}
          type={visible ? 'text' : 'password'}
        />
        <button
          className="auth-reveal"
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          <Icon className="app-icon" aria-hidden="true" />
        </button>
      </div>
      {hint && (
        <p className="auth-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Inline form error. Announced as it appears, and kept next to the button that caused it. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div className="auth-error" role="alert">
      {children}
    </div>
  );
}

export function SubmitButton({
  busy,
  busyLabel,
  disabled = false,
  children,
}: {
  busy: boolean;
  busyLabel: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button className="button button-primary auth-submit" type="submit" disabled={busy || disabled} aria-busy={busy}>
      {busy ? busyLabel : children}
    </button>
  );
}

/** Spinner row for screens that are waiting on the server rather than on the user. */
export function Busy({ children }: { children: ReactNode }) {
  return (
    <p className="auth-busy" role="status">
      {children}
    </p>
  );
}

export function OrDivider() {
  return (
    <div className="auth-divider" aria-hidden="true">
      <span />
      <b>or</b>
      <span />
    </div>
  );
}

export function GoogleButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button className="auth-google" type="button" onClick={onClick} disabled={disabled}>
      <svg className="app-icon" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
      {children}
    </button>
  );
}

const PROMISES = ['On-device profile', 'Adaptive layouts', 'No data sold'];

/**
 * The left half of the split layout. Pure context — the only thing in it you
 * can focus is the logo, so keyboard users go straight to the form.
 */
export function BrandPanel() {
  return (
    <aside className="auth-aside">
      <BrandLockup href="/" height={36} variant="light" className="auth-aside-brand" label="Back to Synapse home" />

      <div className="auth-aside-body">
        {/* A styled paragraph, not a heading: it precedes the page's h1 in
            the DOM and would otherwise break the outline for screen readers. */}
        <p className="auth-aside-title">
          The internet wasn't built for your brain. <em>Synapse is.</em>
        </p>
        <p>One reading profile that learns how you process information and reshapes every page to fit.</p>

        <ul className="auth-promises">
          {PROMISES.map((item) => (
            <li key={item}>
              <Check className="app-icon" aria-hidden="true" strokeWidth={2.2} />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="auth-visual" aria-hidden="true">
        <div className="auth-visual-dense">
          {Array.from({ length: 7 }).map((_, i) => (
            <i key={i} />
          ))}
        </div>
        <span className="auth-visual-arrow" />
        <div className="auth-visual-clear">
          <b />
          <div>
            <i />
            <i />
          </div>
          <div>
            <i />
            <i />
          </div>
        </div>
      </div>
    </aside>
  );
}
