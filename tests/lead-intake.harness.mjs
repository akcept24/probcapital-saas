// ProbCapital SaaS — lead intake harness (scenario family F: F-01..F-08).
//
// Boots the REAL server.js on a scratch port with a scratch DATA_DIR
// and no Telegram/Resend credentials, then drives POST /api/lead over
// HTTP. Asserts: validation branches, the 1000-char message cap,
// stored-record shape and HTML-escaping, honeypot sink, bad-JSON 400,
// oversize 413, per-IP rate cap (10/hr → 429), and the autoreply
// RECIPIENT resolution (observable via the server's own skip logs —
// delivery itself needs Resend and stays a code-read + live fact).
//
// Zero dependencies: node tests/lead-intake.harness.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const PORT = 18741;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-leads-'));

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  PASS', name);
  } else {
    failed++;
    console.log('  FAIL', name, extra);
  }
}

const env = { ...process.env, PORT: String(PORT), DATA_DIR };
delete env.TELEGRAM_BOT_TOKEN;
delete env.LEADS_CHAT_ID;
delete env.RESEND_API_KEY;

const server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

function postLead(body, xff) {
  return new Promise((resolve) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      `${BASE}/api/lead`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(xff ? { 'x-forwarded-for': xff } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* not json */ }
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, json: null, error: String(e) }));
    req.end(payload);
  });
}

function leadRecords() {
  const file = path.join(DATA_DIR, 'leads.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const IP_A = '203.0.113.7';
const IP_B = '203.0.113.8';

try {
  check('server boots and /health answers', await waitUp());

  const health = await fetch(`${BASE}/health`);
  check('F-13: security headers ride API responses (HSTS + CSP + nosniff)',
    (health.headers.get('strict-transport-security') || '').includes('max-age=63072000') &&
      (health.headers.get('content-security-policy') || '').includes("default-src 'self'") &&
      health.headers.get('x-content-type-options') === 'nosniff');

  // F-01/F-03: happy lead + message hard cap at 1000 chars (pre-escape).
  const happy = await postLead(
    { name: 'Ann <b>Owner</b>', email: 'ann@example.com', company: 'Acme', interest: 'Pricing & plans', traders: '120', message: 'a'.repeat(1500) },
    IP_A,
  );
  check('F-01: valid lead → 200 {ok:true}', happy.status === 200 && happy.json?.ok === true, JSON.stringify(happy));
  await sleep(200);
  let recs = leadRecords();
  check('F-01: exactly one record stored', recs.length === 1, `got ${recs.length}`);
  const rec = recs[0] || {};
  check('F-03: message hard-capped at 1000 chars before escaping', (rec.message || '').length === 1000, `len=${(rec.message || '').length}`);
  check('F-08: stored name is HTML-escaped, never raw markup', rec.name === 'Ann &lt;b&gt;Owner&lt;/b&gt;', rec.name);
  check('F-01: intake ip recorded from the LAST x-forwarded-for hop', rec.ip === IP_A, rec.ip);
  check('F-01: autoreply recipient resolved to the lead email (Resend unset → logged skip)',
    serverLog.includes('autoreply skipped (RESEND_API_KEY not configured) for: ann@example.com'));

  // F-04: validation branches.
  const badEmail = await postLead({ name: 'Bob', email: 'not-an-email' }, IP_A);
  check('F-04: invalid email → 422 missing_fields', badEmail.status === 422 && badEmail.json?.error === 'missing_fields');
  const noName = await postLead({ email: 'bob@example.com' }, IP_A);
  check('F-04: missing name → 422 missing_fields', noName.status === 422 && noName.json?.error === 'missing_fields');
  check('F-04: rejected leads are NOT stored', leadRecords().length === 1);

  // F-05/F-06: blueprint recipient logic.
  const bpTg = await postLead({ type: 'blueprint', name: 'Tg User', contact: '@tghandle', brief: 'brief' }, IP_A);
  check('F-05: blueprint with Telegram-only contact → 200', bpTg.status === 200 && bpTg.json?.ok === true);
  await sleep(200);
  check('F-06: Telegram-only blueprint gets NO autoreply (no email address log)',
    serverLog.includes('autoreply skipped (no email address): blueprint'));
  const bpMail = await postLead({ type: 'blueprint', name: 'Mail User', contact: 'mail@example.com', brief: 'b' }, IP_A);
  check('F-05: blueprint with email contact → 200', bpMail.status === 200);
  await sleep(200);
  check('F-06: blueprint autoreply goes to the contact email',
    serverLog.includes('autoreply skipped (RESEND_API_KEY not configured) for: mail@example.com'));
  const bpOwner = await postLead(
    { type: 'blueprint', name: 'Owner Fallback', contact: '@tg2', brief: 'b', config: { ownerEmail: 'owner@example.com' } },
    IP_A,
  );
  check('F-05: blueprint with TG contact + config.ownerEmail → 200', bpOwner.status === 200);
  await sleep(200);
  check('F-06: fallback recipient is config.ownerEmail',
    serverLog.includes('autoreply skipped (RESEND_API_KEY not configured) for: owner@example.com'));
  const bpNoName = await postLead({ type: 'blueprint', contact: 'x@example.com' }, IP_A);
  check('F-05: blueprint without name → 422 missing_fields', bpNoName.status === 422 && bpNoName.json?.error === 'missing_fields');

  // F-07: honeypot sink.
  const before = leadRecords().length;
  const hp = await postLead({ name: 'Bot', email: 'bot@spam.co', website: 'http://spam' }, IP_A);
  check('F-07: honeypot → fake 200 {ok:true}', hp.status === 200 && hp.json?.ok === true);
  check('F-07: honeypot stores NOTHING', leadRecords().length === before);

  // F-08: malformed JSON → 400.
  const badJson = await postLead('{nope', IP_A);
  check('F-08: malformed JSON → 400 bad_json', badJson.status === 400 && badJson.json?.error === 'bad_json');

  // F-08: oversize payload → clean 413.
  const big = await postLead({ name: 'Big', email: 'big@example.com', message: 'x'.repeat(70000) }, IP_A);
  check('F-08: payload over 64KB → 413 payload_too_large', big.status === 413 && big.json?.error === 'payload_too_large', JSON.stringify(big));

  // F-02: per-IP rate cap — 10/hour pass, the 11th is 429. Fresh IP so
  // earlier posts in this run don't pollute the count.
  let statuses = [];
  for (let i = 0; i < 11; i++) {
    const r = await postLead({ name: `R${i}`, email: `r${i}@example.com` }, IP_B);
    statuses.push(r.status);
  }
  check('F-02: first 10 leads from one IP pass', statuses.slice(0, 10).every((s) => s === 200), statuses.join(','));
  check('F-02: 11th lead from the same IP → 429 rate_limited', statuses[10] === 429, statuses.join(','));

  // Static + status surfaces.
  const home = await fetch(`${BASE}/`);
  check('GET / serves the landing', home.status === 200 && (await home.text()).includes('ProbCapital'));
  const statusJson = await fetch(`${BASE}/status.json`);
  const sj = await statusJson.json();
  check('F-12: /status.json answers with a services array', statusJson.status === 200 && Array.isArray(sj.services));
  const nf = await fetch(`${BASE}/definitely-not-a-page`);
  check('unknown path → 404', nf.status === 404);
} finally {
  server.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\nlead-intake harness: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
