import type { ReactNode } from 'react';

/**
 * Shared building blocks for the app-shell pages (/subscription, /profile).
 * The palette is the dashboard's: page #fcf9f8, card #f6f3f2, inset #f0eded,
 * borders #3d3d38, hairlines #e4e2e1, primary #004635, secondary text #5e5f5b.
 */

export const CARD: React.CSSProperties = { backgroundColor: '#f6f3f2', border: '1px solid #3d3d38' };
export const INSET: React.CSSProperties = { backgroundColor: '#f0eded', border: '1px solid #3d3d38' };

/** Small uppercase label that sits above a value or heading. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="block text-xs font-semibold uppercase" style={{ color: '#5e5f5b', letterSpacing: '0.08em' }}>
      {children}
    </span>
  );
}

/** A titled region with the house hairline rule under the heading. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2
        className="font-serif font-semibold mb-4 pb-2 text-2xl"
        style={{ borderBottom: '1px solid #e4e2e1', color: '#1b1c1c' }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Inline feedback banner. Errors get role="alert", successes role="status". */
export function Notice({ kind, children }: { kind: 'error' | 'success'; children: ReactNode }) {
  const palette =
    kind === 'error'
      ? { backgroundColor: '#ffdad6', color: '#ba1a1a', icon: 'error' }
      : { backgroundColor: '#d7f2e5', color: '#004635', icon: 'check_circle' };
  return (
    <div
      className="rounded p-4 flex items-start gap-3 text-sm"
      style={{ backgroundColor: palette.backgroundColor, color: palette.color }}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <span className="material-symbols-outlined shrink-0" style={{ fontSize: 18 }}>
        {palette.icon}
      </span>
      <span>{children}</span>
    </div>
  );
}

/** Theme-matched placeholder used while account, billing, or profile data loads. */
export function Skeleton({
  className = '',
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <span className={`dash-skeleton ${className}`.trim()} aria-hidden="true" style={style} />;
}

/**
 * Prev / Next page control with a live-announced range.
 *
 * `total` and `pageCount` are optional on purpose: Stripe's invoice list is
 * cursor-paginated and reports no total, so that list renders "Page 2" with
 * Next disabled once the cursor runs out, while offset-backed lists get the
 * full "Page 2 of 5" and "Showing 6-10 of 23". One control, both shapes.
 */
export function Pager({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  hasMore,
  busy = false,
  onPrev,
  onNext,
  label,
}: {
  /** 1-based. */
  page: number;
  pageCount?: number | null;
  rangeStart: number;
  rangeEnd: number;
  total?: number | null;
  hasMore: boolean;
  busy?: boolean;
  onPrev: () => void;
  onNext: () => void;
  label: string;
}) {
  const atStart = page <= 1;
  return (
    <nav className="pager" aria-label={label}>
      {/* Paging silently swaps every row, so the range has to be announced. */}
      <p className="pager-range" aria-live="polite">
        {rangeEnd >= rangeStart ? (
          <>
            Showing {rangeStart}–{rangeEnd}
            {typeof total === 'number' ? ` of ${total}` : ''}
          </>
        ) : (
          'Nothing to show'
        )}
      </p>
      <div className="pager-controls">
        <button type="button" onClick={onPrev} disabled={atStart || busy}>
          <span className="material-symbols-outlined" aria-hidden="true">
            chevron_left
          </span>
          Prev
        </button>
        <span className="pager-count">
          Page {page}
          {typeof pageCount === 'number' && pageCount > 0 ? ` of ${pageCount}` : ''}
        </span>
        <button type="button" onClick={onNext} disabled={!hasMore || busy}>
          Next
          <span className="material-symbols-outlined" aria-hidden="true">
            chevron_right
          </span>
        </button>
      </div>
    </nav>
  );
}

/** Segmented pill group — the dashboard's "How are you reading today?" control. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
