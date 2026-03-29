/**
 * Contact Form Worker
 *
 * Accepts POST /api/contact, verifies Turnstile, rate-limits by IP,
 * validates inputs, then sends email via MailChannels.
 */

export interface Env {
  CONTACT_RL: KVNamespace;
  TURNSTILE_SECRET_KEY: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS  = new Set(['https://batuhanhangun.com', 'https://www.batuhanhangun.com']);
const TO_ADDRESS       = 'batuhan@batuhanhangun.com';
const FROM_ADDRESS     = 'noreply@batuhanhangun.com';
const FROM_NAME        = 'Contact Form';
const RATE_LIMIT_MAX   = 5;   // submissions per window
const RATE_LIMIT_TTL   = 3600; // seconds (1 hour)

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

/** Remove any HTML tags from a string. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

// ── Turnstile verification ────────────────────────────────────────────────────

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  const body = new URLSearchParams({
    secret,
    response:   token,
    remoteip:   ip,
  });
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json() as { success: boolean };
  return data.success === true;
}

// ── Rate limiting (KV-backed sliding counter) ─────────────────────────────────

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key      = `rl:${ip}`;
  const raw      = await kv.get(key);
  const count    = raw ? parseInt(raw, 10) : 0;

  if (count >= RATE_LIMIT_MAX) return false;

  // Increment; set TTL only on the first hit so the window resets naturally
  await kv.put(key, String(count + 1), {
    expirationTtl: count === 0 ? RATE_LIMIT_TTL : undefined,
  });
  return true;
}

// ── MailChannels send ─────────────────────────────────────────────────────────

async function sendEmail(name: string, email: string, message: string): Promise<void> {
  const subject  = `[batuhanhangun.com] New message from ${name}`;
  const textBody =
    `Name:    ${name}\n` +
    `Email:   ${email}\n` +
    `\n` +
    `${message}\n`;

  const payload = {
    personalizations: [{ to: [{ email: TO_ADDRESS }] }],
    from:             { email: FROM_ADDRESS, name: FROM_NAME },
    reply_to:         { email, name },
    subject,
    content: [{ type: 'text/plain', value: textBody }],
  };

  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (res.status !== 202) {
    const detail = await res.text();
    throw new Error(`MailChannels error ${res.status}: ${detail}`);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin  = request.headers.get('Origin') ?? '';
    const allowed = ALLOWED_ORIGINS.has(origin);
    const cors    = corsHeaders(allowed ? origin : '');

    // Preflight
    if (request.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    // Only accept POST from an allowed origin
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

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!name || !email || !message || !token) {
      return json({ success: false, message: 'Invalid input' }, 400, cors);
    }
    if (!emailRe.test(email)) {
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

    // ── Send email ───────────────────────────────────────────────────────────
    try {
      await sendEmail(name, email, message);
    } catch (err) {
      console.error('sendEmail failed:', err);
      return json({ success: false, message: 'Failed to send message' }, 500, cors);
    }

    return json({ success: true, message: 'Message sent' }, 200, cors);
  },
} satisfies ExportedHandler<Env>;
