// ProbCapital SaaS landing — zero-dependency static server + lead intake.
// Leads are appended to data/leads.jsonl (durable record) and forwarded to
// Telegram when TELEGRAM_BOT_TOKEN + LEADS_CHAT_ID are configured.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.jsonl');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.LEADS_CHAT_ID || '';
// Lead auto-reply email via Resend (https://resend.com). Optional: when
// RESEND_API_KEY is not set the auto-reply is a logged no-op and lead intake
// works exactly as before. probcapital.com is already a verified sending
// domain in the Resend account the main ProbCapital app sends from.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const AUTOREPLY_FROM = process.env.LEAD_AUTOREPLY_FROM || 'ProbCapital <noreply@probcapital.com>';
const AUTOREPLY_REPLY_TO = process.env.LEAD_AUTOREPLY_REPLY_TO || '';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8'
};

// Simple in-memory rate limit: max 10 submissions per IP per hour.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}

// Global circuit breaker: per-IP keying alone is defeated by senders
// behind rotating egress IPs (each request arrives under a fresh last
// XFF hop), and the in-memory map resets on every deploy. A B2B landing
// never receives 60 genuine leads in an hour, so a global cap costs
// nothing and bounds Telegram/CRM spam floods (and, once RESEND_API_KEY
// is set, auto-reply relay abuse) no matter how the sender rotates IPs.
const GLOBAL_LEAD_CAP_PER_HOUR = 60;
let globalHits = [];
function globalRateLimited() {
  const now = Date.now();
  globalHits = globalHits.filter(t => now - t < 3600e3);
  globalHits.push(now);
  return globalHits.length > GLOBAL_LEAD_CAP_PER_HOUR;
}

// Security headers applied to every response (set centrally in the request
// handler below via res.setHeader, so static files, API JSON, /status and
// error pages all carry them). CSP notes: every page ships exactly one
// inline <script> and inline <style> blocks and loads Google Fonts
// (stylesheet from fonts.googleapis.com, files from fonts.gstatic.com);
// images are local, JS fetches are same-origin ('/api/lead', '/status.json')
// plus exactly one cross-origin call: the wizard's checkout posts its
// configuration to the platform intake at app.probcapital.com
// ('/api/saas/requests'), which connect-src names explicitly.
// 'unsafe-inline' in script-src/style-src is therefore required for the
// wizard, calculator and lead form to keep working — a nonce-based CSP
// would need a markup rewrite.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://app.probcapital.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ')
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function esc(s) {
  return String(s == null ? '' : s).slice(0, 2000)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyTelegram(lead) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  // INVARIANT: every lead field rendered here was already esc()'d once at
  // intake in handleLead. Do NOT esc() again — Telegram decodes entities
  // exactly once, so a second escape makes the ops chat show literal
  // '&lt;'/'&amp;' text (and can push an entity-dense message past
  // Telegram's 4,096-char message limit, silently dropping the lead).
  let text;
  if (lead.type === 'blueprint') {
    text = '🧩 <b>ProbCapital SaaS — blueprint request</b>\n' +
      'Name: ' + lead.name + '\nContact: ' + lead.contact + '\n\n' +
      (lead.brief || '(no brief)');
  } else {
    text = '🚀 <b>ProbCapital SaaS — new lead</b>\n' +
      'Name: ' + lead.name + '\nEmail: ' + lead.email +
      '\nCompany: ' + lead.company +
      '\nInterest: ' + (lead.interest || '—') +
      '\nTraders/mo: ' + (lead.traders || '—') +
      (lead.message ? '\nMessage: ' + lead.message : '');
  }
  // Telegram rejects messages over 4,096 chars. Entity-dense free text
  // (message/brief) expands up to 5x under esc(); hard-cap the composed
  // text so the notification is shortened, never silently dropped. Raw
  // '<' can never appear (intake esc), so a cut entity stays inert text.
  if (text.length > 4000) text = text.slice(0, 4000) + '…';
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
    });
    if (!r.ok) console.error('telegram notify rejected:', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.error('telegram notify failed:', e.message);
    return false;
  }
}

// ---------- Lead auto-reply email ----------
// Sent after a lead is stored and the ops chat is notified. Fire-and-forget:
// a mail failure must never fail or delay the lead submission itself.

function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function interestNextStep(interest) {
  // lead.interest is stored HTML-escaped (esc() at intake), so it arrives
  // here as e.g. 'Pricing &amp; plans' — unescape before matching, or the
  // 'Pricing & plans' case can never fire and pricing leads silently get
  // the generic line.
  switch (unesc(interest)) {
    case 'Platform walkthrough':
      return 'You asked for a platform walkthrough: we will come back with a few time slots for a live session covering the trader terminal, the admin dashboard and the trader onboarding flow.';
    case 'Free brand preview (48 hours)':
      return 'You asked for the free brand preview: it is in the queue and, as promised on the site, it will be ready within 48 hours — we will send it to this email address.';
    case 'Pricing & plans':
      return 'You asked about pricing and plans: we will reply with the plan that fits your volumes and the full all-in cost — flat monthly pricing, no revenue share and no per-trader fees.';
    case 'Migration from my current provider':
      return 'You asked about migrating from your current provider: we will reply with how the migration works, what we need from your side, and a realistic timeline for your setup.';
    default:
      return 'We have noted your request and will come back with the details relevant to your situation.';
  }
}

function buildAutoreply(lead) {
  const name = unesc(lead.name).trim();
  const first = name.split(/\s+/)[0] || 'there';
  const replyLine = AUTOREPLY_REPLY_TO
    ? 'If you would like to add anything in the meantime, just reply to this email — it reaches our team directly.'
    : 'If you would like to add anything in the meantime, you can reach us through the contact form at https://saas.probcapital.com — mention your name so we can match it to this request.';
  let subject, intro, nextStep;
  if (lead.type === 'blueprint') {
    subject = 'Your ProbCapital blueprint — request received';
    intro = 'this is a quick confirmation that we have received your platform blueprint request.';
    nextStep = 'Our team will send the full configuration plus a tailored launch estimate based on the setup you built in the demo wizard. No spam — one message, as promised.';
  } else {
    subject = 'We received your request — ProbCapital';
    intro = 'this is a quick confirmation that we have received your request.';
    nextStep = interestNextStep(lead.interest);
  }
  const text =
    'Hi ' + first + ',\n\n' +
    'Thanks for reaching out — ' + intro + '\n\n' +
    nextStep + '\n\n' +
    'A member of our team will also reply personally — on our site we promise a reply within one business day, and we hold ourselves to that.\n\n' +
    replyLine + '\n\n' +
    '— The ProbCapital team\nhttps://saas.probcapital.com\n';
  const html =
    '<!DOCTYPE html><html><body style="margin:0;background:#F6F7FB;padding:32px 16px;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif;color:#141A2E">' +
    '<div style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #E4E7F2;border-radius:14px;overflow:hidden">' +
    '<div style="background:#0A0E1A;padding:22px 30px"><span style="color:#E8C05F;letter-spacing:.18em;font-size:12px;font-weight:700">PROBCAPITAL</span></div>' +
    '<div style="padding:28px 30px;font-size:15px;line-height:1.65">' +
    '<p style="margin:0 0 14px">Hi ' + esc(first) + ',</p>' +
    '<p style="margin:0 0 14px">Thanks for reaching out — ' + esc(intro) + '</p>' +
    '<p style="margin:0 0 14px">' + esc(nextStep) + '</p>' +
    '<p style="margin:0 0 14px">A member of our team will also reply personally — on our site we promise a reply within one business day, and we hold ourselves to that.</p>' +
    '<p style="margin:0">' + esc(replyLine) + '</p>' +
    '</div>' +
    '<div style="padding:18px 30px;border-top:1px solid #E4E7F2;color:#7A8199;font-size:13px">— The ProbCapital team · <a href="https://saas.probcapital.com" style="color:#B08A2E">saas.probcapital.com</a></div>' +
    '</div></body></html>';
  return { subject, text, html };
}

// Where can this lead actually be emailed? The main form always carries a
// validated email. The wizard blueprint accepts a Telegram handle OR an
// email as contact; the wizard's optional owner contact (config.ownerEmail)
// is the fallback. A Telegram-only lead simply gets no email.
function autoreplyRecipient(lead) {
  if (lead.type === 'blueprint') {
    if (EMAIL_RE.test(lead.contact || '')) return lead.contact;
    const owner = lead.config && lead.config.ownerEmail;
    if (owner && EMAIL_RE.test(String(owner))) return String(owner);
    return null;
  }
  return EMAIL_RE.test(lead.email || '') ? lead.email : null;
}

async function sendAutoreply(lead) {
  const to = autoreplyRecipient(lead);
  if (!to) {
    console.log('autoreply skipped (no email address):', lead.type, lead.email || lead.contact || '—');
    return false;
  }
  if (!RESEND_API_KEY) {
    console.log('autoreply skipped (RESEND_API_KEY not configured) for:', to);
    return false;
  }
  const { subject, text, html } = buildAutoreply(lead);
  const payload = { from: AUTOREPLY_FROM, to: [to], subject, text, html };
  if (AUTOREPLY_REPLY_TO) payload.reply_to = AUTOREPLY_REPLY_TO;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'ProbCapital-SaaS/1.0 (+https://saas.probcapital.com)' },
      body: JSON.stringify(payload)
    });
    clearTimeout(t);
    if (!r.ok) {
      console.error('autoreply rejected:', r.status, (await r.text()).slice(0, 200), 'to:', to);
      return false;
    }
    const data = await r.json().catch(() => ({}));
    console.log('autoreply sent to:', to, 'id:', data.id || '—');
    return true;
  } catch (e) {
    console.error('autoreply failed:', e.message, 'to:', to);
    return false;
  }
}

function handleLead(req, res, ip) {
  let raw = '';
  let tooBig = false;
  req.on('data', c => {
    if (tooBig) return;
    raw += c;
    if (raw.length > 65536) {
      // Clean 413 instead of a bare socket destroy (which surfaces as a
      // confusing 502 through the proxy).
      tooBig = true;
      sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (tooBig) return;
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
    // Honeypot: bots fill the hidden "website" field. Pretend success.
    if (body.website) return sendJson(res, 200, { ok: true });
    if (rateLimited(ip) || globalRateLimited()) return sendJson(res, 429, { ok: false, error: 'rate_limited' });

    const type = body.type === 'blueprint' ? 'blueprint' : 'lead';
    const lead = { type, ts: new Date().toISOString(), ip };
    if (type === 'blueprint') {
      lead.name = esc(body.name); lead.contact = esc(body.contact);
      lead.brief = esc(body.brief); lead.config = body.config || null;
      if (!lead.name || !lead.contact) return sendJson(res, 422, { ok: false, error: 'missing_fields' });
    } else {
      lead.name = esc(body.name); lead.email = esc(body.email);
      lead.company = esc(body.company); lead.traders = esc(body.traders);
      lead.interest = esc(body.interest);
      // Optional free-text from the form: hard-capped at 1000 chars before
      // escaping (esc() also neutralises HTML for the Telegram HTML parse
      // mode and the stored record), same posture as every other field.
      lead.message = esc(String(body.message == null ? '' : body.message).slice(0, 1000));
      if (!lead.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email || '')) {
        return sendJson(res, 422, { ok: false, error: 'missing_fields' });
      }
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + '\n');
    } catch (e) {
      console.error('lead store failed:', e.message);
      return sendJson(res, 500, { ok: false, error: 'store_failed' });
    }
    lead.telegram = await notifyTelegram(lead);
    console.log('lead stored:', type, lead.email || lead.contact, 'tg:', lead.telegram);
    // Auto-reply to the lead: fire-and-forget, never blocks or fails intake.
    sendAutoreply(lead).catch(e => console.error('autoreply crashed:', e.message));
    return sendJson(res, 200, { ok: true });
  });
}

// ---------- Live status (request-time checks) ----------
// The /status page checks each public service at the moment the page is
// requested and reports what the check actually found — up, degraded
// (answering, but slowly) or down — together with the time of the check.
// A round of probes is cached for 30 seconds so a burst of page views
// shares one set of checks instead of hammering the services.
//
// There is deliberately no uptime percentage and no incident history on
// the page: public status reporting starts with this page, and a
// percentage printed before a measured history exists behind it would be
// an invented number. The previous background prober (60s interval,
// history in data/status.json, rendered %) is replaced by this
// request-time model; its old data file is simply no longer written.
const STATUS_COMPONENTS = [
  { id: 'saas', name: 'SaaS site & demo', detail: 'saas.probcapital.com — this site, the public demo and lead intake',
    url: null, ok: null }, // self-check: this process answering is the check
  { id: 'platform', name: 'Trader platform', detail: 'app.probcapital.com — trader dashboard & ProbTrader terminal',
    url: 'https://app.probcapital.com/', ok: s => s >= 200 && s < 400 },
  { id: 'site', name: 'Public site', detail: 'probcapital.com — the firm\u2019s public website',
    url: 'https://probcapital.com/', ok: s => s >= 200 && s < 400 },
  { id: 'quotes', name: 'Quote feed', detail: 'quotes.probcapital.com — live prices for the terminal',
    url: 'https://quotes.probcapital.com/health', ok: s => s === 200 }
];
const STATUS_TIMEOUT_MS = 5000; // no answer within 5s counts as down
const STATUS_SLOW_MS = 2000;    // an answer slower than 2s counts as degraded
const STATUS_CACHE_MS = 30000;
let statusCache = null;    // { checkedAt, components: [...] }
let statusInflight = null; // shared promise while a probe round is running

async function probeComponent(c) {
  const base = { id: c.id, name: c.name, detail: c.detail };
  if (!c.url) {
    // Self-check, reported as what it is: this page is served by the SaaS
    // site itself, so the fact that the answer rendered is the result.
    // Not dressed up as an external probe, and no fake latency is shown.
    return { ...base, state: 'up', httpStatus: null, latencyMs: null, note: 'This server answered your request' };
  }
  const started = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);
    const r = await fetch(c.url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'ProbCapital-Status/1.0 (+https://saas.probcapital.com/status)' }
    });
    clearTimeout(t);
    if (r.body) r.body.cancel().catch(() => {});
    const latencyMs = Date.now() - started;
    if (!c.ok(r.status)) {
      return { ...base, state: 'down', httpStatus: r.status, latencyMs, note: 'Answered HTTP ' + r.status };
    }
    return { ...base, state: latencyMs > STATUS_SLOW_MS ? 'degraded' : 'up', httpStatus: r.status, latencyMs, note: null };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const why = e && e.name === 'AbortError'
      ? 'No answer within ' + (STATUS_TIMEOUT_MS / 1000) + ' seconds'
      : 'Could not be reached';
    return { ...base, state: 'down', httpStatus: null, latencyMs, note: why };
  }
}

async function getStatus() {
  if (statusCache && Date.now() - Date.parse(statusCache.checkedAt) < STATUS_CACHE_MS) return statusCache;
  if (statusInflight) return statusInflight;
  statusInflight = (async () => {
    try {
      const components = await Promise.all(STATUS_COMPONENTS.map(probeComponent));
      statusCache = { checkedAt: new Date().toISOString(), components };
      return statusCache;
    } finally {
      statusInflight = null;
    }
  })();
  return statusInflight;
}

function overallState(components) {
  if (components.some(c => c.state === 'down')) return 'down';
  if (components.some(c => c.state === 'degraded')) return 'degraded';
  return 'up';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function fmtUtc(iso) {
  const d = new Date(iso);
  const p2 = n => String(n).padStart(2, '0');
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() +
    ', ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + ' UTC';
}

// The page is rendered in the landing's editorial paper system (cream
// paper, Fraunces / Manrope / IBM Plex Mono, hairline rules, squared
// shapes) — the same tokens and header/footer markup as public/index.html.
function statusPageHtml(status) {
  const overall = overallState(status.components);
  const overallWord = overall === 'up' ? 'All services are up'
    : overall === 'degraded' ? 'Services are answering, but one is slow'
    : 'A service is down';
  const checkedTxt = fmtUtc(status.checkedAt);
  const launchTxt = MONTHS[new Date(status.checkedAt).getUTCMonth()] + ' ' + new Date(status.checkedAt).getUTCFullYear();
  const stateWord = { up: 'Up', degraded: 'Degraded', down: 'Down' };
  const stateNote = c => c.state === 'degraded' ? 'Answering, but slower than ' + (STATUS_SLOW_MS / 1000) + ' seconds'
    : c.state === 'down' ? (c.note || 'Not answering') : (c.note || '');
  const rows = status.components.map(c => {
    const resp = c.latencyMs === null ? '—' : c.latencyMs.toLocaleString('en-US') + ' ms';
    const http = c.httpStatus === null ? '—' : String(c.httpStatus);
    const note = stateNote(c);
    return '<tr>' +
      '<td><b>' + esc(c.name) + '</b><br><span class="mut">' + esc(c.detail) + '</span></td>' +
      '<td><span class="st st-' + c.state + '"><span class="sq"></span>' + stateWord[c.state] + '</span>' +
      (note ? '<br><span class="mut">' + esc(note) + '</span>' : '') + '</td>' +
      '<td class="mono">' + resp + '</td><td class="mono">' + http + '</td></tr>';
  }).join('');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta http-equiv="refresh" content="60">' +
    '<title>System status — ProbCapital</title>' +
    '<meta name="description" content="Live status of the services the ProbCapital platform runs on — checked when this page is opened, reported as found.">' +
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500;1,9..144,600&family=IBM+Plex+Mono:wght@400;500;600&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
    '<style>' +
    ':root{--paper:#EFF1EC;--surface:#F8F9F5;--ink:#142019;--ink-soft:#2A362E;--muted:#55635A;' +
    '--line:#D3DAD2;--line-strong:#B9C4B8;--accent:#0B8F61;--accent-deep:#076143;--accent-soft:#D8F2E7;' +
    '--dark:#0C130F;--dark-line:#26332B;--dark-muted:#9DB1A4;--warn:#9A6B14;--bad:#B03B2E;' +
    '--serif:"Fraunces",Georgia,"Times New Roman",serif;--sans:"Manrope",-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;' +
    '--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '*{margin:0;padding:0;box-sizing:border-box}' +
    'body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:16.5px;line-height:1.65;-webkit-font-smoothing:antialiased}' +
    '::selection{background:var(--accent-soft)}a{color:var(--accent-deep)}' +
    ':focus-visible{outline:2px solid var(--accent-deep);outline-offset:2px}' +
    '.wrap{max-width:1240px;margin:0 auto;padding:0 32px}' +
    'header{position:sticky;top:0;z-index:50;background:var(--paper);border-bottom:1px solid var(--line-strong)}' +
    '.nav{display:flex;align-items:center;justify-content:space-between;height:72px}' +
    '.wordmark{font-family:var(--serif);font-size:25px;font-weight:600;letter-spacing:-.01em;color:var(--ink);text-decoration:none}' +
    '.wordmark span{color:var(--accent-deep);font-style:italic}' +
    '.nav-links{display:flex;align-items:center;gap:36px}' +
    '.nav-links a{color:var(--ink-soft);text-decoration:none;font-size:15px;font-weight:600;padding:12px 0}' +
    '.nav-links a:hover{color:var(--accent-deep)}' +
    '.nav-links a.btn-nav{background:var(--ink);color:var(--paper);padding:13px 24px;font-size:14.5px;border-radius:3px;border:1px solid var(--ink)}' +
    '.nav-links a.btn-nav:hover{background:var(--accent-deep);border-color:var(--accent-deep);color:#fff}' +
    '.burger{display:none;background:none;border:0;cursor:pointer;padding:12px}' +
    '.burger span{display:block;width:24px;height:2px;background:var(--ink);margin:5px 0}' +
    'main{padding:88px 0 104px}' +
    '.kicker{display:flex;align-items:center;gap:14px;font-family:var(--mono);font-size:12px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--accent-deep);margin-bottom:26px}' +
    '.kicker::after{content:"";height:1px;width:56px;background:var(--accent)}' +
    'h1{font-family:var(--serif);font-weight:560;font-size:clamp(40px,5vw,64px);line-height:1.04;letter-spacing:-.015em;margin-bottom:22px}' +
    'h1 em{font-style:italic;font-weight:500;color:var(--accent-deep)}' +
    '.lead{color:var(--muted);font-size:18.5px;line-height:1.6;max-width:600px}' +
    '.overall{margin:52px 0 0;background:var(--surface);border:1px solid var(--line-strong);border-radius:4px;padding:34px 40px;max-width:880px}' +
    '.overall .o-label{font-family:var(--mono);color:var(--accent-deep);font-size:12px;letter-spacing:.16em;text-transform:uppercase;margin-bottom:12px}' +
    '.overall .o-word{font-family:var(--serif);font-size:30px;font-weight:560;line-height:1.2}' +
    '.overall .o-when{font-family:var(--mono);font-size:13px;letter-spacing:.04em;color:var(--muted);margin-top:14px}' +
    '.table-scroll{overflow-x:auto;margin-top:56px;border-top:2px solid var(--ink);max-width:1000px}' +
    'table{width:100%;border-collapse:collapse;min-width:760px;font-size:15px}' +
    'th,td{padding:16px 18px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}' +
    'thead th{font-family:var(--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:500}' +
    'td b{font-weight:800;letter-spacing:-.01em}' +
    '.mut{color:var(--muted);font-size:13.5px}' +
    '.mono{font-family:var(--mono);font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap}' +
    '.st{font-weight:700;white-space:nowrap}.st .sq{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:10px}' +
    '.st-up{color:var(--accent-deep)}.st-up .sq{background:var(--accent)}' +
    '.st-degraded{color:var(--warn)}.st-degraded .sq{background:var(--warn)}' +
    '.st-down{color:var(--bad)}.st-down .sq{background:var(--bad)}' +
    '.notes{max-width:760px;margin-top:64px;border-top:1px solid var(--line)}' +
    '.notes h2{font-family:var(--serif);font-size:24px;font-weight:600;margin:34px 0 14px}' +
    '.notes p{color:var(--muted);font-size:15.5px;margin-bottom:14px;max-width:700px}' +
    '.notes p b{color:var(--ink)}' +
    'footer{border-top:1px solid var(--dark-line);padding:64px 0 40px;background:var(--dark);color:#EDF2EC}' +
    'footer .wordmark{color:#F2F5F0}' +
    '.foot{display:flex;justify-content:space-between;align-items:flex-start;gap:32px;flex-wrap:wrap}' +
    '.foot p{color:var(--dark-muted);font-size:14px;margin-top:12px;max-width:340px}' +
    '.foot .foot-meta{font-family:var(--mono);font-size:12.5px;letter-spacing:.05em;line-height:1.9;margin-top:18px}' +
    '.foot-links{display:flex;gap:28px;flex-wrap:wrap}' +
    '.foot-links a{color:#C9D4C9;text-decoration:none;font-size:14.5px;font-weight:600}' +
    '.foot-links a:hover{color:#7BDDB4}' +
    '.copy{margin-top:44px;padding-top:24px;border-top:1px solid var(--dark-line);color:var(--dark-muted);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}' +
    '@media(max-width:960px){.wrap{padding:0 22px}main{padding:64px 0 76px}' +
    '.nav-links{display:none;position:absolute;top:72px;left:0;right:0;background:var(--paper);border-bottom:1px solid var(--line-strong);padding:14px 22px 24px;flex-direction:column;align-items:stretch;gap:2px}' +
    '.nav-links.open{display:flex}.nav-links a{padding:12px 0;font-size:16px;min-height:44px;display:flex;align-items:center}' +
    '.nav-links a.btn-nav{margin-top:10px;justify-content:center}.burger{display:block}' +
    '.overall{padding:28px 24px}}' +
    '@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.001s !important;transition-duration:.001s !important}}' +
    '</style></head><body>' +
    '<header><div class="wrap nav">' +
    '<a href="/" class="wordmark">Prob<span>Capital</span></a>' +
    '<nav class="nav-links" id="navLinks">' +
    '<a href="/#product">Product</a><a href="/#pricing">Pricing</a><a href="/#compare">Compare</a><a href="/#faq">FAQ</a>' +
    '<a href="/acme-prop-demo-wizard.html" class="btn-nav">Live demo</a></nav>' +
    '<button class="burger" id="burger" aria-label="Menu"><span></span><span></span><span></span></button>' +
    '</div></header>' +
    '<main><div class="wrap">' +
    '<p class="kicker">System status</p>' +
    '<h1>What the platform is doing, <em>checked just now.</em></h1>' +
    '<p class="lead">These are the services the ProbCapital platform runs on — the same infrastructure a white-label firm gets. This page does not copy a report: it checks each service when you open it and prints what it finds.</p>' +
    '<div class="overall"><p class="o-label">Current state</p>' +
    '<p class="o-word">' + overallWord + '</p>' +
    '<p class="o-when">Last checked ' + checkedTxt + ' · the page refreshes itself every 60 seconds</p></div>' +
    '<div class="table-scroll"><table><thead><tr><th>Component</th><th>Status</th><th>Response</th><th>HTTP</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>' +
    '<div class="notes"><h2>How to read this page</h2>' +
    '<p><b>Checked on request.</b> Opening this page asks each service for an answer from this server. A service counts as <b>down</b> if it answers with an error or does not answer within ' + (STATUS_TIMEOUT_MS / 1000) + ' seconds, and as <b>degraded</b> if it answers correctly but takes longer than ' + (STATUS_SLOW_MS / 1000) + ' seconds. Results are cached for ' + (STATUS_CACHE_MS / 1000) + ' seconds, so the timestamp above is never older than that.</p>' +
    '<p><b>No uptime percentage — yet.</b> Public status reporting starts with this page, in ' + launchTxt + '. There is no measured history behind a percentage today, so we do not print one: an uptime figure will appear here only once it is counted from real checks, not before.</p>' +
    '<p><b>If something here is down, it is down for us too.</b> Our own firm trades on this stack. If a component shows down and it is affecting your firm, write to support@probcapital.com — a person answers, and this page is the first place a recovery shows.</p>' +
    '</div>' +
    '</div></main>' +
    '<footer><div class="wrap"><div class="foot"><div>' +
    '<a href="/" class="wordmark">Prob<span>Capital</span></a>' +
    '<p>White-label prop firm platform: terminal, risk engine and trader tools under your brand.</p>' +
    '<p class="foot-meta">ProbCapital LLC · Delaware, USA<br>Support: support@probcapital.com · Telegram: @probcapital_support</p></div>' +
    '<div class="foot-links"><a href="/#product">Product</a><a href="/#pricing">Pricing</a><a href="/#compare">Compare</a><a href="/#faq">FAQ</a>' +
    '<a href="/acme-prop-demo-wizard.html">Live demo</a><a href="/learn/">Learn</a><a href="/status">System status</a></div></div>' +
    '<div class="copy"><span>© 2026 ProbCapital LLC. All rights reserved.</span>' +
    '<span>ProbCapital LLC is a software provider, not a broker-dealer. It does not hold client funds.</span></div>' +
    '</div></footer>' +
    '<script>document.getElementById("burger").addEventListener("click",function(){document.getElementById("navLinks").classList.toggle("open")});</script>' +
    '</body></html>';
}


const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  // Rate-limit key: the LAST x-forwarded-for entry — behind Traefik each
  // proxy appends, so the last entry is the closest trusted hop's view of
  // the client; the FIRST entry is fully client-controlled and keying on
  // it let a sender rotate fake IPs to bypass the lead limit entirely.
  // Falls back to the socket address when no XFF is present.
  const xffEntries = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  const ip = xffEntries.length > 0 ? xffEntries[xffEntries.length - 1] : (req.socket.remoteAddress || '');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/status.json') {
    // Same request-time checks as the page, in machine-readable form.
    getStatus().then(st => sendJson(res, 200, {
      checkedAt: st.checkedAt, overall: overallState(st.components), services: st.components
    })).catch(() => sendJson(res, 500, { ok: false, error: 'status_unavailable' }));
    return;
  }
  if (url.pathname === '/status') {
    getStatus().then(st => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(statusPageHtml(st));
    }).catch(() => {
      // The probes themselves catch per-service failures, so reaching
      // here means the checker broke — say so instead of guessing a state.
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Status check unavailable — please try again in a moment.');
    });
    return;
  }
  if (url.pathname === '/api/lead' && req.method === 'POST') return handleLead(req, res, ip);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  // Malformed percent-encoding must never throw inside the handler —
  // fall through to the 404 page instead.
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { p = '/__malformed__'; }
  if (p === '/') p = '/index.html';
  if (p === '/wizard' || p === '/demo') p = '/acme-prop-demo-wizard.html';
  if (p === '/integrations') p = '/integrations.html';
  if (p === '/learn' || p === '/learn/') p = '/learn/index.html';
  const file = path.join(PUBLIC_DIR, p);
  const exists = file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile();
  if (exists && req.method === 'GET' && path.extname(file).toLowerCase() === '.html') {
    // Lightweight page-view log (no cookies, no fingerprinting): day counts per page.
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFile(path.join(DATA_DIR, 'views.jsonl'), JSON.stringify({
        ts: new Date().toISOString(), path: url.pathname,
        ref: (req.headers.referer || '').slice(0, 200) || null,
        ua: (req.headers['user-agent'] || '').slice(0, 120)
      }) + '\n', () => {});
    } catch { /* never block the page on logging */ }
  }
  if (!exists) {
    const nf = path.join(PUBLIC_DIR, '404.html');
    if (fs.existsSync(nf)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(nf).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => console.log('probcapital-saas listening on :' + PORT));
