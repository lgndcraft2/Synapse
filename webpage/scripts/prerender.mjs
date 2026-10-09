/**
 * Post-build step: bakes crawlable HTML into dist/ (see src/entry-server.tsx
 * for why).
 *
 *   dist/index.html          landing page, rendered for real and hydrated
 *   dist/support/index.html  static copy of the help content, own <head>
 *   dist/{privacy,terms,refunds}/index.html  legal pages, rendered and hydrated
 *   dist/app.html            the untouched SPA shell; vercel.json and the
 *                            FastAPI fallback serve it for every other route
 *                            so signed-in screens don't flash the landing page
 *
 * It also fills the JSON-LD from the same data the page renders (FAQ answers
 * from lib/faq.ts, offers from lib/plans.ts) so structured data can't drift
 * from what's on screen, and stamps <lastmod> into the sitemap.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ssrDir = join(root, 'dist-ssr');
const SITE_URL = 'https://usesynapse.cv';

const { renderLanding, renderSupport, renderLegal, FAQS, LEGAL_META, PLANS } = await import(
  pathToFileURL(join(ssrDir, 'entry-server.mjs')).href
);

const shell = readFileSync(join(dist, 'index.html'), 'utf8');
// Vite hoists the module script into <head>, so #root is the last thing in <body>.
const ROOT_RE = /<div id="root">[\s\S]*?<\/div>\s*(?=<\/body>)/;
const LD_RE = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/;
if (!ROOT_RE.test(shell) || !LD_RE.test(shell)) {
  throw new Error('prerender: #root or the JSON-LD block is missing from dist/index.html');
}

const escapeAttr = (s) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function withStructuredData(html) {
  return html.replace(LD_RE, (_, open, json, close) => {
    const data = JSON.parse(json);
    for (const node of data['@graph']) {
      if (node['@type'] === 'FAQPage') {
        node.mainEntity = FAQS.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        }));
      }
      if (node['@type'] === 'SoftwareApplication') {
        node.offers = PLANS.map((p) => ({
          '@type': 'Offer',
          name: p.name,
          price: ((p.monthly?.amount ?? 0) / 100).toFixed(2),
          priceCurrency: 'USD',
          description: p.tagline,
          url: `${SITE_URL}/#pricing`,
        }));
      }
    }
    // "<" escaped so answer text can never close the script tag early.
    return open + JSON.stringify(data).replace(/</g, '\\u003c') + close;
  });
}

function withHead(html, { title, description, path }) {
  const url = SITE_URL + path;
  const set = (re, value) => {
    if (!re.test(html)) throw new Error(`prerender: no match for ${re}`);
    html = html.replace(re, `$1${escapeAttr(value)}$2`);
  };
  set(/(<title>)[^<]*(<\/title>)/, title);
  set(/(<meta\s+name="description"\s+content=")[^"]*(")/, description);
  set(/(<meta property="og:title" content=")[^"]*(")/, title);
  set(/(<meta\s+property="og:description"\s+content=")[^"]*(")/, description);
  set(/(<meta name="twitter:title" content=")[^"]*(")/, title);
  set(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, description);
  set(/(<meta property="og:url" content=")[^"]*(")/, url);
  set(/(<link rel="canonical" href=")[^"]*(")/, url);
  return html;
}

const withRoot = (html, markup, marker) =>
  html.replace(ROOT_RE, `<div id="root"${marker ? ` data-prerendered="${marker}"` : ''}>${markup}</div>\n  `);

// The SPA shell first, before index.html is overwritten.
writeFileSync(join(dist, 'app.html'), shell);

writeFileSync(
  join(dist, 'index.html'),
  withRoot(withStructuredData(shell), renderLanding(), 'landing'),
);

// Secondary pages keep the static JSON-LD minus the FAQPage (that belongs to
// the landing page, where the FAQ is the page's own content).
function writePage(path, head, markup, marker) {
  let html = shell.replace(LD_RE, (_, open, json, close) => {
    const data = JSON.parse(json);
    data['@graph'] = data['@graph'].filter((n) => n['@type'] !== 'FAQPage');
    return open + JSON.stringify(data) + close;
  });
  html = withRoot(withHead(html, { ...head, path }), markup, marker);
  mkdirSync(join(dist, path), { recursive: true });
  writeFileSync(join(dist, path, 'index.html'), html);
}

writePage(
  '/support',
  {
    title: 'Support and FAQ - Synapse',
    description:
      'Answers on privacy, browser support, billing, and how the Synapse reading profile works - plus how to reach a human.',
  },
  renderSupport(),
);

for (const [path, head] of Object.entries(LEGAL_META)) {
  writePage(path, head, renderLegal(path), path.slice(1));
}

// Last commit touching the site, falling back to the build date where there
// is no git history (the Docker build context excludes .git).
let lastmod;
try {
  lastmod = execSync('git log -1 --format=%cs -- .', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {}
lastmod ||= new Date().toISOString().slice(0, 10);
const sitemapPath = join(dist, 'sitemap.xml');
writeFileSync(
  sitemapPath,
  readFileSync(sitemapPath, 'utf8').replace(
    /(<loc>[^<]*<\/loc>)(?!\s*<lastmod>)/g,
    `$1\n    <lastmod>${lastmod}</lastmod>`,
  ),
);

rmSync(ssrDir, { recursive: true, force: true });
console.log(`prerender: wrote index.html, support/, ${Object.keys(LEGAL_META).join(', ')}, app.html (lastmod ${lastmod})`);
