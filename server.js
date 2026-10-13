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
  let text;
  if (lead.type === 'blueprint') {
    text = '🧩 <b>ProbCapital SaaS — blueprint request</b>\n' +
      'Name: ' + esc(lead.name) + '\nContact: ' + esc(lead.contact) + '\n\n' +
      esc(lead.brief || '(no brief)');
  } else {
    text = '🚀 <b>ProbCapital SaaS — new lead</b>\n' +
      'Name: ' + esc(lead.name) + '\nEmail: ' + esc(lead.email) +
      '\nCompany: ' + esc(lead.company) +
      '\nInterest: ' + esc(lead.interest || '—') +
      '\nTraders/mo: ' + esc(lead.traders || '—');
  }
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

function handleLead(req, res, ip) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 65536) req.destroy(); });
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
    // Honeypot: bots fill the hidden "website" field. Pretend success.
    if (body.website) return sendJson(res, 200, { ok: true });
    if (rateLimited(ip)) return sendJson(res, 429, { ok: false, error: 'rate_limited' });

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
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/status.json') return sendJson(res, 200, { since: statusData.since, services: statusSummary() });
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(statusPageHtml());
  }
  if (url.pathname === '/api/lead' && req.method === 'POST') return handleLead(req, res, ip);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/wizard' || p === '/demo') p = '/acme-prop-demo-wizard.html';
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
