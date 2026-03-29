/**
 * Citation Metrics Worker
 *
 * Scheduled (daily): fetches Google Scholar via SerpAPI + Scopus via Elsevier API,
 * stores results in KV.
 *
 * HTTP (GET /api/metrics): serves cached JSON with CORS, rate-limiting, cache headers.
 */

/* ── Types ─────────────────────────────────────────────────────────────────── */

export interface Env {
  /** KV namespace for storing metrics + rate-limit counters */
  CITATION_METRICS: KVNamespace;
  /** SerpAPI key — set via: wrangler secret put SERPAPI_KEY */
  SERPAPI_KEY: string;
  /** Elsevier API key — set via: wrangler secret put SCOPUS_API_KEY */
  SCOPUS_API_KEY: string;
  /** Scopus numeric author ID — set via: wrangler secret put SCOPUS_AUTHOR_ID */
  SCOPUS_AUTHOR_ID: string;
}

interface ScholarMetrics {
  citations: number | null;
  h_index:   number | null;
  i10_index: number | null;
}

interface ScopusMetrics {
  citations: number | null;
  h_index:   number | null;
}

export interface MetricsPayload {
  scholar:    ScholarMetrics;
  scopus:     ScopusMetrics;
  updated_at: string;
}

/* Hardcoded fallback — used when KV is empty and APIs are unreachable */
const STATIC_FALLBACK: MetricsPayload = {
  scholar:    { citations: 197, h_index: 8, i10_index: 7 },
  scopus:     { citations: null, h_index: null },
  updated_at: new Date(0).toISOString(), // epoch signals "no live data"
};

const KV_METRICS_KEY = 'metrics:v1';

/* ── CORS ──────────────────────────────────────────────────────────────────── */

const ALLOWED_ORIGINS = new Set([
  'https://batuhanhangun.com',
  'https://www.batuhanhangun.com',
  // Allow localhost for local development (wrangler dev)
  'http://localhost:4321',
  'http://localhost:3000',
  'http://localhost:8788',
]);

function corsHeaders(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://batuhanhangun.com';
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

/* ── Rate limiting (60 req / IP / minute) via KV ──────────────────────────── */

const HTTP_RATE_LIMIT = 60;
const HTTP_WINDOW_TTL = 60; // seconds

async function checkHttpRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key   = `rl:http:${ip}`;
  const raw   = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= HTTP_RATE_LIMIT) return false;

  // Best-effort increment — don't let a KV write failure block the request
  try {
    await kv.put(key, String(count + 1), { expirationTtl: HTTP_WINDOW_TTL });
  } catch { /* ignore */ }
  return true;
}

/* ── SerpAPI — Google Scholar ──────────────────────────────────────────────── */

interface SerpScholarTable {
  citations?:  { all?: number };
  h_index?:    { all?: number };
  i10_index?:  { all?: number };
}

interface SerpAuthorResponse {
  cited_by?: {
    table?: SerpScholarTable[];
  };
  error?: string;
}

async function fetchScholarMetrics(apiKey: string): Promise<ScholarMetrics> {
  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('engine',    'google_scholar_author');
  url.searchParams.set('author_id', 'kW1pVNEAAAAJ');
  url.searchParams.set('api_key',   apiKey);

  const res  = await fetch(url.toString(), { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);

  const data = await res.json() as SerpAuthorResponse;
  if (data.error) throw new Error(`SerpAPI error: ${data.error}`);

  const table = data.cited_by?.table ?? [];

  // table[0] = citations, table[1] = h_index, table[2] = i10_index
  const get = (idx: number, key: keyof SerpScholarTable): number | null => {
    const entry = table[idx] as Record<string, { all?: number }> | undefined;
    return entry?.[key]?.all ?? null;
  };

  return {
    citations: get(0, 'citations'),
    h_index:   get(1, 'h_index'),
    i10_index: get(2, 'i10_index'),
  };
}

/* ── Elsevier / Scopus ──────────────────────────────────────────────────────── */

interface ScopusAuthorResponse {
  'author-retrieval-response'?: Array<{
    coredata?: {
      'citation-count'?: string | number;
      'citedby-count'?:  string | number;
    };
    'h-index'?: string | number;
  }>;
}

async function fetchScopusMetrics(apiKey: string, authorId: string): Promise<ScopusMetrics> {
  const url = `https://api.elsevier.com/content/author/author_id/${encodeURIComponent(authorId)}`;

  const res = await fetch(url, {
    headers: {
      'X-ELS-APIKey': apiKey,
      'Accept':       'application/json',
    },
    cf: { cacheTtl: 0 },
  });

  if (!res.ok) throw new Error(`Scopus HTTP ${res.status}`);

  const data = await res.json() as ScopusAuthorResponse;
  const entry = data['author-retrieval-response']?.[0];
  if (!entry) throw new Error('Scopus: empty author-retrieval-response');

  const parseNum = (v: string | number | undefined): number | null => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    return isNaN(n) ? null : n;
  };

  // Scopus uses 'citation-count' or 'citedby-count' depending on API version
  const citations =
    parseNum(entry.coredata?.['citation-count']) ??
    parseNum(entry.coredata?.['citedby-count']);

  return {
    citations,
    h_index: parseNum(entry['h-index']),
  };
}

/* ── Scheduled handler ─────────────────────────────────────────────────────── */

async function refreshMetrics(env: Env): Promise<void> {
  // Load last-known values as baseline for partial-failure fallback
  const existingRaw = await env.CITATION_METRICS.get(KV_METRICS_KEY);
  const existing: MetricsPayload = existingRaw
    ? (JSON.parse(existingRaw) as MetricsPayload)
    : STATIC_FALLBACK;

  let scholar = existing.scholar;
  let scopus  = existing.scopus;

  // Fetch Scholar (required — always run)
  if (env.SERPAPI_KEY) {
    try {
      scholar = await fetchScholarMetrics(env.SERPAPI_KEY);
      console.log('Scholar metrics refreshed:', scholar);
    } catch (err) {
      console.error('Scholar fetch failed, keeping last values:', err);
    }
  } else {
    console.warn('SERPAPI_KEY not set — skipping Scholar refresh');
  }

  // Fetch Scopus (optional — skip if credentials not yet configured)
  if (env.SCOPUS_API_KEY && env.SCOPUS_AUTHOR_ID) {
    try {
      scopus = await fetchScopusMetrics(env.SCOPUS_API_KEY, env.SCOPUS_AUTHOR_ID);
      console.log('Scopus metrics refreshed:', scopus);
    } catch (err) {
      console.error('Scopus fetch failed, keeping last values:', err);
    }
  } else {
    console.warn('SCOPUS_API_KEY / SCOPUS_AUTHOR_ID not set — skipping Scopus refresh');
  }

  const payload: MetricsPayload = {
    scholar,
    scopus,
    updated_at: new Date().toISOString(),
  };

  // Store with 7-day TTL — a safety net so stale data eventually expires
  await env.CITATION_METRICS.put(KV_METRICS_KEY, JSON.stringify(payload), {
    expirationTtl: 7 * 24 * 60 * 60,
  });

  console.log('Metrics stored in KV:', payload);
}

/* ── HTTP fetch handler ────────────────────────────────────────────────────── */

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url    = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors   = corsHeaders(origin);

  // OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Only GET /api/metrics
  if (request.method !== 'GET' || url.pathname !== '/api/metrics') {
    return new Response('Not Found', { status: 404, headers: cors });
  }

  // Rate limiting
  const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const allowed = await checkHttpRateLimit(env.CITATION_METRICS, ip);
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: {
        ...cors,
        'Content-Type':  'application/json',
        'Retry-After':   '60',
      },
    });
  }

  // Load metrics from KV — fall back to static defaults if empty
  const raw = await env.CITATION_METRICS.get(KV_METRICS_KEY);
  const metrics: MetricsPayload = raw
    ? (JSON.parse(raw) as MetricsPayload)
    : STATIC_FALLBACK;

  // Sanitise: only expose public citation counts — no internal keys
  const safe = {
    scholar: {
      citations: metrics.scholar.citations,
      h_index:   metrics.scholar.h_index,
      i10_index: metrics.scholar.i10_index,
    },
    scopus: {
      citations: metrics.scopus.citations,
      h_index:   metrics.scopus.h_index,
    },
    updated_at: metrics.updated_at,
  };

  return new Response(JSON.stringify(safe), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type':  'application/json',
      // Clients may cache for 1 hour; Cloudflare edge may cache for 30 min
      'Cache-Control': 'public, max-age=3600, s-maxage=1800',
    },
  });
}

/* ── Worker export ─────────────────────────────────────────────────────────── */

export default {
  fetch: handleFetch,

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await refreshMetrics(env);
  },
} satisfies ExportedHandler<Env>;
