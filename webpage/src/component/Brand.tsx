import type { CSSProperties } from 'react';

/**
 * The Synapse lockup, used anywhere the wordmark used to be typeset in Source
 * Serif. Sourced from /synapse-lockup.png, a tight crop of the master
 * public/synapse-horizontal.png; the master keeps a lot of transparent padding,
 * so setting a height on it would render the logo roughly 40% too small.
 */

/** Intrinsic size of synapse-lockup.png, used to reserve space before it loads. */
const LOCKUP_RATIO = 560 / 126;

interface BrandLockupProps {
  href: string;
  /** Rendered height in px. Width follows the logo's own ratio. */
  height?: number;
  className?: string;
  label?: string;
}

export function BrandLockup({
  href,
  height = 30,
  className,
  label = 'Synapse home',
}: BrandLockupProps) {
  return (
    <a
      className={className ? `brand-lockup ${className}` : 'brand-lockup'}
      href={href}
      aria-label={label}
      style={{ '--brand-height': `${height}px` } as CSSProperties}
    >
      <img
        src="/synapse-lockup.png"
        alt="Synapse"
        width={Math.round(height * LOCKUP_RATIO)}
        height={height}
      />
    </a>
  );
}

/** Icon-only mark, for tight spots where the wordmark will not fit. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <img
      className="brand-mark"
      src="/icon-192.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
    />
  );
}
