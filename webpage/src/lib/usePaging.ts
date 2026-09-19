import { useCallback, useEffect, useRef, useState } from 'react';
import type { Paged } from './api';

/**
 * Offset-paged list state for the endpoints that can count their rows
 * (/profile/history, /dashboard/sessions, /support/tickets).
 *
 * The invoice list is deliberately not served by this hook: Stripe pages by
 * cursor and reports no total, so it keeps its own small cursor stack in
 * Subscription.tsx rather than bending this one out of shape.
 */
export function useOffsetPage<T>(
  fetcher: (params: { limit: number; offset: number }) => Promise<Paged<T>>,
  pageSize: number,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled !== false;

  const [page, setPage] = useState(1);
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // First load shows the panel's own skeleton; later pages show `busy` so the
  // current rows stay on screen instead of the list blanking mid-navigation.
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keeps a slow page-1 response from overwriting a page-2 one the user has
  // already asked for.
  const requestRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(
    async (target: number) => {
      if (!enabled) return;
      const token = ++requestRef.current;
      if (target === 1 && requestRef.current === 1) setLoading(true);
      setBusy(true);
      setError(null);
      try {
        const result = await fetcherRef.current({
          limit: pageSize,
          offset: (target - 1) * pageSize,
        });
        if (token !== requestRef.current) return;
        setItems(result.data || []);
        setTotal(typeof result.total === 'number' ? result.total : null);
        setHasMore(Boolean(result.has_more));
        setPage(target);
      } catch (err: any) {
        if (token !== requestRef.current) return;
        // The rows already on screen are left alone: a failed page change
        // should not empty the list the user was reading.
        setError(err?.message || 'Could not load this page.');
      } finally {
        if (token === requestRef.current) {
          setBusy(false);
          setLoading(false);
        }
      }
    },
    [enabled, pageSize],
  );

  useEffect(() => {
    if (enabled) load(1);
    else setLoading(false);
  }, [enabled, load]);

  const pageCount = typeof total === 'number' ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const rangeStart = items.length ? (page - 1) * pageSize + 1 : 0;

  return {
    page,
    items,
    total,
    pageCount,
    hasMore,
    loading,
    busy,
    error,
    rangeStart,
    rangeEnd: rangeStart ? rangeStart + items.length - 1 : 0,
    /** True once there is more than one page — the pager stays hidden below that. */
    showPager: page > 1 || hasMore,
    next: () => hasMore && !busy && load(page + 1),
    prev: () => page > 1 && !busy && load(page - 1),
    reload: () => load(page),
    /** After creating a row: go back to the newest page and refetch. */
    reset: () => load(1),
  };
}
