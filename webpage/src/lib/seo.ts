/**
 * Per-route <head> metadata for the SPA.
 *
 * index.html carries the full, static landing-page set — that is what social
 * crawlers (Slack, X, LinkedIn, iMessage) read, since none of them run the
 * bundle. This module refines the tags once the bundle boots, which is what
 * search engines that do render JavaScript, browser tabs, and bookmarks see.
 *
 * Keeping crawlers out of the signed-in screens is *not* left to this module:
 * the X-Robots-Tag headers in vercel.json do that, because a crawler that never
 * executes the bundle would only ever see the static index.html tags.
 */

export const SITE_URL = 'https://usesynapse.cv';

export type RouteMeta = {
  title: string;
  description: string;
  /** Path to advertise as canonical. Defaults to the site root. */
  canonical?: string;
  /** Signed-in app screens: nothing worth indexing behind the login. */
  noindex?: boolean;
};

function upsertMeta(key: 'name' | 'property', value: string, content: string) {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${key}="${value}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(key, value);
    document.head.appendChild(tag);
  }
  tag.content = content;
}

export function applyRouteMeta(meta: RouteMeta) {
  const url = SITE_URL + (meta.canonical ?? '/');

  document.title = meta.title;
  upsertMeta('name', 'description', meta.description);
  upsertMeta(
    'name',
    'robots',
    meta.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large, max-snippet:-1',
  );

  upsertMeta('property', 'og:title', meta.title);
  upsertMeta('property', 'og:description', meta.description);
  upsertMeta('property', 'og:url', url);
  upsertMeta('name', 'twitter:title', meta.title);
  upsertMeta('name', 'twitter:description', meta.description);

  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = url;
}
