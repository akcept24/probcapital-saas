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

const server = http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/lead' && req.method === 'POST') return handleLead(req, res, ip);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/wizard' || p === '/demo') p = '/acme-prop-demo-wizard.html';
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
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
