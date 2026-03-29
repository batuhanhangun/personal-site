export const prerender = false;

import type { APIContext } from 'astro';

/* ── Types ────────────────────────────────────────────────────────────────── */
interface Env {
  CONTACT_KV:           KVNamespace;
  CONTACT_EMAIL_SENDER: SendEmail;
  TURNSTILE_SECRET:     string;
}

interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
}

/* ── Constants ────────────────────────────────────────────────────────────── */
const RATE_LIMIT          = 5;        // max successful submissions / IP / hour
const WINDOW_SECS         = 60 * 60;
const SUSPECT_THRESHOLD   = 3;        // failed Turnstile attempts before logging
const TO_ADDRESS          = 'batuhan@batuhanhangun.com';
const FROM_ADDRESS        = 'contact@batuhanhangun.com';
const TURNSTILE_URL       = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/* ── Helper: rate limiting ────────────────────────────────────────────────── */
async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key   = `rl:${ip}`;
  const raw   = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= RATE_LIMIT) return false;
  await kv.put(key, String(count + 1), { expirationTtl: WINDOW_SECS });
  return true;
}

/* ── Helper: suspicious-activity tracking ────────────────────────────────── */
async function recordSuspiciousAttempt(kv: KVNamespace, ip: string, reason: string): Promise<void> {
  const key = `suspect:${ip}`;
  const raw = await kv.get(key);
  const count = (raw ? parseInt(raw, 10) : 0) + 1;
  try {
    await kv.put(key, String(count), { expirationTtl: WINDOW_SECS });
  } catch { /* best-effort — don't let KV failure block the response */ }

  if (count >= SUSPECT_THRESHOLD) {
    // Logged to Cloudflare Workers Logs (visible in dashboard)
    console.warn(`[contact] Suspicious activity — ip=${ip} reason=${reason} attempts=${count}`);
  }
}

/* ── Helper: Turnstile verification ──────────────────────────────────────── */
async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token, remoteip: ip });
  const res  = await fetch(TURNSTILE_URL, { method: 'POST', body });
  const data = await res.json() as TurnstileResponse;
  return data.success === true;
}

/* ── Helper: input sanitisation ──────────────────────────────────────────── */
function sanitise(s: string, maxLen: number): string {
  return s.trim().slice(0, maxLen).replace(/[<>]/g, '');
}

/* ── Main handler ─────────────────────────────────────────────────────────── */
export async function POST({ request, locals }: APIContext) {
  const env = (locals as { runtime?: { env?: Env } }).runtime?.env;

  if (!env?.CONTACT_KV || !env?.CONTACT_EMAIL_SENDER) {
    return json503();
  }

  /* Parse body */
  let body: Record<string, string>;
  try {
    body = await request.json() as Record<string, string>;
  } catch {
    return json400('Invalid request');
  }

  const clientIp = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';

  /* Honeypot — bots fill hidden fields; silently succeed to avoid fingerprinting */
  if (body.website?.trim()) {
    await recordSuspiciousAttempt(env.CONTACT_KV, clientIp, 'honeypot');
    return json200();
  }

  /* Validate required fields */
  const name    = sanitise(body.name    ?? '', 120);
  const email   = sanitise(body.email   ?? '', 254);
  const message = sanitise(body.message ?? '', 4000);

  if (!name || !email || !message) {
    return json400('All fields are required');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json400('Invalid email address');
  }

  /* Turnstile verification — must pass before consuming a rate-limit slot */
  const token = String(body['cf-turnstile-response'] ?? '');
  if (!token) {
    await recordSuspiciousAttempt(env.CONTACT_KV, clientIp, 'missing-captcha');
    return json400('Please complete the security check');
  }

  const turnstileOk = await verifyTurnstile(token, env.TURNSTILE_SECRET ?? '', clientIp);
  if (!turnstileOk) {
    await recordSuspiciousAttempt(env.CONTACT_KV, clientIp, 'captcha-failed');
    return json400('Security check failed. Please try again');
  }

  /* Rate limiting */
  const allowed = await checkRateLimit(env.CONTACT_KV, clientIp);
  if (!allowed) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Too many requests. Please try again later.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  }

  /* Send email via Cloudflare Email Workers */
  try {
    const emailBody = [
      `Name:    ${name}`,
      `Email:   ${email}`,
      `IP:      ${clientIp}`,
      `Time:    ${new Date().toISOString()}`,
      ``,
      `Message:`,
      message,
    ].join('\n');

    const { EmailMessage } = await import('cloudflare:email');
    const msg = new EmailMessage(FROM_ADDRESS, TO_ADDRESS, buildMimeEmail({
      from:    FROM_ADDRESS,
      to:      TO_ADDRESS,
      replyTo: email,
      subject: `[batuhanhangun.com] Message from ${name}`,
      text:    emailBody,
    }));

    await env.CONTACT_EMAIL_SENDER.send(msg);
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: 'Unable to send your message. Please try again.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return json200();
}

/* ── MIME builder ─────────────────────────────────────────────────────────── */
function buildMimeEmail(opts: {
  from: string; to: string; replyTo: string;
  subject: string; text: string;
}): string {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Reply-To: ${opts.replyTo}`,
    `Subject: ${opts.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    opts.text,
  ].join('\r\n');
}

/* ── Response helpers ─────────────────────────────────────────────────────── */
function json200() {
  return new Response(JSON.stringify({ ok: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function json400(error: string) {
  return new Response(JSON.stringify({ ok: false, error }),
    { status: 400, headers: { 'Content-Type': 'application/json' } });
}
function json503() {
  return new Response(JSON.stringify({ ok: false, error: 'Service unavailable' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } });
}
