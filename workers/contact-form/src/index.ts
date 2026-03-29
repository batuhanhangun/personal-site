/**
 * Contact Form Worker
 *
 * POST /api/contact  — verify Turnstile, rate-limit, save to KV, notify via Resend
 * GET  /api/messages — admin endpoint; returns all stored messages (bearer token required)
 */

export interface Env {
  CONTACT_RL:          KVNamespace;
  TURNSTILE_SECRET_KEY: string;
  RESEND_API_KEY:      string;
  ADMIN_TOKEN:         string;
}

interface StoredMessage {
  name:         string;
  email:        string;
  message:      string;
  submitted_at: string;
  ip:           string;
}

// ── Config ────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set(['https://batuhanhangun.com', 'https://www.batuhanhangun.com']);
const TO_ADDRESS      = 'batuhan@batuhanhangun.com';
const RATE_LIMIT_MAX  = 5;    // submissions per window
const RATE_LIMIT_TTL  = 3600; // seconds (1 hour)

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(body: object, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

// ── Turnstile verification ────────────────────────────────────────────────────

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token, remoteip: ip });
  const res  = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json() as { success: boolean };
  return data.success === true;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key   = `rl:${ip}`;
  const raw   = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= RATE_LIMIT_MAX) return false;

  await kv.put(key, String(count + 1), {
    expirationTtl: count === 0 ? RATE_LIMIT_TTL : undefined,
  });
  return true;
}

// ── KV storage ────────────────────────────────────────────────────────────────

async function storeMessage(kv: KVNamespace, msg: StoredMessage): Promise<void> {
  const key = `msg:${Date.now()}`;
  await kv.put(key, JSON.stringify(msg));
}

// ── Resend notification ───────────────────────────────────────────────────────

async function sendResendNotification(
  apiKey: string,
  msg: StoredMessage,
): Promise<void> {
  const text =
    `Name:    ${msg.name}\n` +
    `Email:   ${msg.email}\n` +
    `\n` +
    `${msg.message}\n`;

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from:    'Contact Form <contact@batuhanhangun.com>',
      to:      [TO_ADDRESS],
      reply_to: msg.email,
      subject: `[batuhanhangun.com] Message from ${msg.name}`,
      text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend error ${res.status}: ${detail}`);
  }
}

// ── Admin: list messages ──────────────────────────────────────────────────────

async function handleGetMessages(request: Request, env: Env): Promise<Response> {
  const auth  = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), {
      status:  401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const list = await env.CONTACT_RL.list({ prefix: 'msg:' });
  const messages = await Promise.all(
    list.keys.map(async ({ name }) => {
      const raw = await env.CONTACT_RL.get(name);
      return { key: name, ...(raw ? JSON.parse(raw) as StoredMessage : {}) };
    }),
  );

  // newest first
  messages.sort((a, b) => b.key.localeCompare(a.key));

  return new Response(JSON.stringify({ success: true, messages }), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Admin endpoint — no CORS, bearer-token only
    if (pathname === '/api/messages' && request.method === 'GET') {
      return handleGetMessages(request, env);
    }

    const origin  = request.headers.get('Origin') ?? '';
    const allowed = ALLOWED_ORIGINS.has(origin);
    const cors    = corsHeaders(allowed ? origin : '');

    // Preflight
    if (request.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (pathname !== '/api/contact') {
      return json({ success: false, message: 'Not found' }, 404, cors);
    }

    if (request.method !== 'POST') {
      return json({ success: false, message: 'Method not allowed' }, 405, cors);
    }
    if (!allowed) {
      return json({ success: false, message: 'Forbidden' }, 403);
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return json({ success: false, message: 'Invalid JSON' }, 400, cors);
    }

    const rawName    = typeof body.name    === 'string' ? body.name    : '';
    const rawEmail   = typeof body.email   === 'string' ? body.email   : '';
    const rawMessage = typeof body.message === 'string' ? body.message : '';
    const token      = typeof body['cf-turnstile-response'] === 'string'
                         ? body['cf-turnstile-response'] : '';

    // ── Validate & sanitize ──────────────────────────────────────────────────
    const name    = stripHtml(rawName.trim()).slice(0, 100);
    const email   = rawEmail.trim().slice(0, 200);
    const message = stripHtml(rawMessage.trim()).slice(0, 5000);

    if (!name || !email || !message || !token) {
      return json({ success: false, message: 'Invalid input' }, 400, cors);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, message: 'Invalid input' }, 400, cors);
    }

    // ── Turnstile ────────────────────────────────────────────────────────────
    const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
    const turnstileOk = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, ip);
    if (!turnstileOk) {
      return json({ success: false, message: 'CAPTCHA verification failed' }, 403, cors);
    }

    // ── Rate limit ───────────────────────────────────────────────────────────
    const withinLimit = await checkRateLimit(env.CONTACT_RL, ip);
    if (!withinLimit) {
      return json({ success: false, message: 'Too many requests' }, 429, cors);
    }

    // ── Store in KV (primary — must not fail) ─────────────────────────────────
    const stored: StoredMessage = {
      name, email, message,
      submitted_at: new Date().toISOString(),
      ip,
    };
    await storeMessage(env.CONTACT_RL, stored);

    // ── Notify via Resend (best-effort — message already saved) ──────────────
    if (env.RESEND_API_KEY) {
      try {
        await sendResendNotification(env.RESEND_API_KEY, stored);
      } catch (err) {
        console.error('Resend notification failed (message saved to KV):', err);
      }
    }

    return json({ success: true, message: 'Message sent' }, 200, cors);
  },
} satisfies ExportedHandler<Env>;
