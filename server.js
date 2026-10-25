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

// ---------- Live status monitoring ----------
// Real checks every 60s against the production services ProbCapital runs on.
// History persists in data/status.json; the /status page renders it honestly,
// including the day monitoring started.
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const SERVICES = [
  { id: 'platform', name: 'Trader platform', desc: 'app.probcapital.com — dashboard & trading terminal',
    url: 'https://app.probcapital.com/', test: s => s >= 200 && s < 400 },
  { id: 'quotes', name: 'Quote Hub', desc: 'quotes.probcapital.com — live price feed',
    url: 'https://quotes.probcapital.com/health', test: s => s === 200 },
  { id: 'saas', name: 'SaaS platform', desc: 'saas.probcapital.com — this site, demo & lead intake',
    url: null, test: null } // self-check: up if this process answers
];
let statusData = { since: null, checks: [] };
try {
  const saved = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  if (saved && Array.isArray(saved.checks)) statusData = saved;
} catch { /* first run */ }

async function probe(url, test) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    return test(r.status);
  } catch { return false; }
}

async function runChecks() {
  const rec = { t: new Date().toISOString(), saas: true };
  for (const svc of SERVICES) {
    if (svc.url) rec[svc.id] = await probe(svc.url, svc.test);
  }
  if (!statusData.since) statusData.since = rec.t;
  statusData.checks.push(rec);
  if (statusData.checks.length > 43200) statusData.checks = statusData.checks.slice(-43200); // ~30 days @60s
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(statusData));
  } catch (e) { console.error('status save failed:', e.message); }
}
setTimeout(runChecks, 3000);
setInterval(runChecks, 60000);

function statusSummary() {
  const total = statusData.checks.length;
  const last = statusData.checks[total - 1] || null;
  return SERVICES.map(svc => {
    const upCount = statusData.checks.reduce((n, c) => n + (c[svc.id] ? 1 : 0), 0);
    return {
      id: svc.id, name: svc.name, desc: svc.desc,
      up: last ? !!last[svc.id] : null,
      uptime: total ? (100 * upCount / total) : null
    };
  }).map(s => ({ ...s, since: statusData.since, checks: total,
                 lastCheck: last ? last.t : null }));
}

function statusPageHtml() {
  const rows = statusSummary();
  const allUp = rows.every(r => r.up);
  const anyKnown = rows.some(r => r.up !== null);
  const banner = !anyKnown ? 'Collecting data…' : allUp ? 'All systems operational' : 'Partial disruption — see below';
  const bannerColor = !anyKnown ? '#9AA3C0' : allUp ? '#4ADE80' : '#E8C05F';
  const sinceTxt = rows[0] && rows[0].since
    ? new Date(rows[0].since).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'today';
  const trs = rows.map(r => {
    const dot = r.up === null ? '#9AA3C0' : r.up ? '#4ADE80' : '#E05F5F';
    const label = r.up === null ? 'Checking…' : r.up ? 'Operational' : 'Down';
    const up = r.uptime === null ? '—' : r.uptime.toFixed(2) + '%';
    return '<tr><td><span class="dot" style="background:' + dot + '"></span><b>' + r.name + '</b><br><span class="mut">' + r.desc + '</span></td>' +
      '<td>' + label + '</td><td>' + up + '</td></tr>';
  }).join('');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta http-equiv="refresh" content="60">' +
    '<title>System status — ProbCapital</title>' +
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' +
    '<style>body{margin:0;background:#0A0E1A;color:#F2F4FA;font-family:system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif;padding:64px 24px}' +
    '.wrap{max-width:760px;margin:0 auto}h1{font-size:34px;margin:0 0 6px}.mut{color:#9AA3C0;font-size:14px}' +
    '.banner{margin:26px 0;padding:18px 22px;border:1px solid rgba(232,192,95,.35);border-radius:14px;background:#111832;font-weight:700;font-size:18px}' +
    'table{width:100%;border-collapse:collapse;background:#111832;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden}' +
    'td{padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top;font-size:15px}' +
    'tr:last-child td{border-bottom:0}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:9px}' +
    'a{color:#E8C05F}.foot{margin-top:26px;color:#9AA3C0;font-size:13.5px;line-height:1.6}</style></head><body><div class="wrap">' +
    '<p style="color:#E8C05F;letter-spacing:.2em;font-size:12px;font-weight:700;text-transform:uppercase">ProbCapital</p>' +
    '<h1>System status</h1><p class="mut">Live checks of the services the ProbCapital platform runs on — the same infrastructure our white-label clients get.</p>' +
    '<div class="banner" style="color:' + bannerColor + '">' + banner + '</div>' +
    '<table>' + trs + '</table>' +
    '<p class="foot">Checked every 60 seconds. Uptime is measured from real probes since ' + sinceTxt + ' — no cherry-picking, no rounding up to 100%. ' +
    'This is the stack our own firm trades on. <a href="/">← Back to the platform</a></p>' +
    '</div></body></html>';
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
  if (url.pathname === '/status.json') return sendJson(res, 200, { since: statusData.since, services: statusSummary() });
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(statusPageHtml());
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
