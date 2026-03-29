/**
 * postbuild-csp.mjs
 *
 * Runs automatically after `astro build` (npm `postbuild` hook).
 *
 * Finds every inline <script> in dist/client/index.html, computes its
 * SHA-256 hash, then replaces the __SCRIPT_HASHES__ placeholder in
 * dist/client/_headers with the real hash list.
 *
 * This lets us use a strict CSP with no 'unsafe-inline' while still
 * supporting Astro's bundled-inline script output.
 */

import { createHash }                    from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HTML_PATH    = 'dist/client/index.html';
const HEADERS_PATH = 'dist/client/_headers';
const PLACEHOLDER  = '__SCRIPT_HASHES__';

/* ── Bail gracefully when files don't exist (e.g. CI dry-run) ─────────────── */
for (const p of [HTML_PATH, HEADERS_PATH]) {
  if (!existsSync(p)) {
    console.warn(`[postbuild-csp] ${p} not found — skipping CSP hash injection`);
    process.exit(0);
  }
}

/* ── Read the built HTML ───────────────────────────────────────────────────── */
const html = readFileSync(HTML_PATH, 'utf8');

/**
 * Match all inline script tags — those WITHOUT a `src` attribute.
 * The regex is safe here because the HTML is Astro/Vite-generated (trusted,
 * well-formed), not user-controlled.
 *
 * Capture group 1 = the raw script content (before HTML-entity decoding).
 */
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

const hashes = [];
let match;

while ((match = INLINE_SCRIPT_RE.exec(html)) !== null) {
  const content = match[1];
  if (!content.trim()) continue;               // skip empty <script></script>

  const hash = createHash('sha256').update(content, 'utf8').digest('base64');
  hashes.push(`'sha256-${hash}'`);
}

console.log(`[postbuild-csp] Found ${hashes.length} inline script(s)`);

/* ── Patch _headers ────────────────────────────────────────────────────────── */
const headers = readFileSync(HEADERS_PATH, 'utf8');

if (!headers.includes(PLACEHOLDER)) {
  console.warn(`[postbuild-csp] Placeholder "${PLACEHOLDER}" not found in ${HEADERS_PATH} — skipping`);
  process.exit(0);
}

const hashList = hashes.length > 0 ? hashes.join(' ') : "'none'";
// replaceAll so both the comment annotation and the actual CSP header line are updated
const patched  = headers.replaceAll(PLACEHOLDER, hashList);

writeFileSync(HEADERS_PATH, patched);
console.log(`[postbuild-csp] Injected ${hashes.length} hash(es) into ${HEADERS_PATH}`);
