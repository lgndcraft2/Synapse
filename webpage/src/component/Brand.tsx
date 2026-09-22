import type { CSSProperties } from 'react';

/**
 * The Synapse lockup, used anywhere the wordmark used to be typeset in Source
 * Serif. Sourced from /synapse-lockup.png, a tight crop of the master
 * public/synapse-horizontal.png; the master keeps a lot of transparent padding,
 * so setting a height on it would render the logo roughly 40% too small.
 */

/**
 * Each variant with its intrinsic ratio, used to reserve space before it loads.
 * `light` (white wordmark, for dark backgrounds) is a tight crop of the master
 * public/synapse-light-full.png, for the same padding reason as above.
 */
const LOCKUPS = {
  dark: { src: '/synapse-lockup.png', ratio: 560 / 126 },
  light: { src: '/synapse-lockup-light.png', ratio: 1120 / 285 },
};

interface BrandLockupProps {
  href: string;
  /** Rendered height in px. Width follows the logo's own ratio. */
  height?: number;
  className?: string;
  label?: string;
  /** `light` for dark surfaces. Defaults to the dark-green wordmark. */
  variant?: keyof typeof LOCKUPS;
}

export function BrandLockup({
  href,
  height = 30,
  className,
  label = 'Synapse home',
  variant = 'dark',
}: BrandLockupProps) {
  const lockup = LOCKUPS[variant];
  return (
    <a
      className={className ? `brand-lockup ${className}` : 'brand-lockup'}
      href={href}
      aria-label={label}
      style={{ '--brand-height': `${height}px` } as CSSProperties}
    >
      <img
        src={lockup.src}
        alt="Synapse"
        width={Math.round(height * lockup.ratio)}
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
