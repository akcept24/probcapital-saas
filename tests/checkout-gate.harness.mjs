// Regression harness for the wizard checkout email gate + payload contract
// (public/acme-prop-demo-wizard.html, #checkoutBtn click handler).
//
// It extracts the ACTUAL handler code from the wizard file — from
// `var bpName = ...` through the fetch() call's body line — and runs it
// in a sandbox with stubbed document/state/showToast/fetch, so the check
// exercises the shipped logic, not a copy of it.
//
// Bugs it guards against:
// 1. (2026-10-24) The gate's email regex was double-escaped
//    (/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/), so `\\.` demanded a literal
//    backslash before the TLD and NO real email could ever pass —
//    checkout blocked every buyer with "An email is required for checkout".
// 2. (Codex H1/M1) The payload's config was a verbatim copy of state, so
//    a Telegram handle in the Step-2 owner-contact field (which the form
//    explicitly invites) landed in config.ownerEmail, which the platform
//    intake rejects (422) — and with two different emails, the intake's
//    config-first derivation sent the invoice to the Step-2 address
//    while the page copy promises the blueprint contact. The handler must
//    send config.ownerEmail = the gate-approved email (contact).
//
// Usage: node tests/checkout-gate.harness.mjs [path-to-wizard.html]
// Exit code 0 = all cases behave as expected, 1 = regression.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || join(here, '..', 'public', 'acme-prop-demo-wizard.html');
const html = readFileSync(file, 'utf8');

const startMarker = "var bpName = document.getElementById('bpName')";
const endMarker = '}).then(function(r){';
const start = html.indexOf(startMarker);
// Anchor the end search after the start: the blueprint form's fetch chain
// uses the same `}).then(function(r){` line earlier in the file.
const end = start === -1 ? -1 : html.indexOf(endMarker, start);
if (start === -1 || end === -1 || end <= start) {
  console.error('FAIL: could not locate the checkout handler block in ' + file);
  process.exit(1);
}
// Close the fetch(url, { ... }) call that the slice leaves open; the
// stubbed fetch never resolves, so the .then chains (not extracted)
// never run.
const handler = html.slice(start, end) + '});';

function runGate({ bpName = '', bpContact = '', legalName = 'Acme Prop LLC', ownerEmail = '' }) {
  const toasts = [];
  const calls = [];
  const values = {
    bpName: { value: bpName },
    bpContact: { value: bpContact },
    checkoutNote: { textContent: '' },
    checkoutBtn: {},
  };
  const documentStub = { getElementById: (id) => values[id] || { value: '', textContent: '' } };
  const state = { legalName, ownerEmail };
  const showToast = (msg) => toasts.push(msg);
  const fetchStub = (url, opts) => {
    calls.push({ url, opts });
    return { then: () => ({ then: () => ({ catch: () => {} }) }) };
  };
  new Function('document', 'state', 'showToast', 'fetch', handler)(
    documentStub, state, showToast, fetchStub
  );
  const blocked = toasts.includes('An email is required for checkout');
  let body = null;
  if (calls.length) {
    try { body = JSON.parse(calls[0].opts.body); } catch (e) { body = null; }
  }
  return { blocked, calls, body };
}

// For pass cases, expectContact is the email BOTH the top-level contact
// and config.ownerEmail must carry (the payload contract, bug #2).
const cases = [
  { name: 'email only in Step-2 company field', input: { ownerEmail: 'owner@acme.com' }, expectBlocked: false, expectContact: 'owner@acme.com' },
  { name: 'email only in final blueprint contact', input: { bpContact: 'boss@acme.com' }, expectBlocked: false, expectContact: 'boss@acme.com' },
  { name: 'no email anywhere', input: {}, expectBlocked: true },
  { name: 'plus-address in final contact', input: { bpContact: 'akcept24+conveyor@gmail.com' }, expectBlocked: false, expectContact: 'akcept24+conveyor@gmail.com' },
  { name: 'plus-address in BOTH fields (the live E2E case)', input: { bpContact: 'akcept24+conveyor@gmail.com', ownerEmail: 'akcept24+conveyor@gmail.com' }, expectBlocked: false, expectContact: 'akcept24+conveyor@gmail.com' },
  { name: 'plus-address in Step-2 only', input: { ownerEmail: 'akcept24+conveyor@gmail.com' }, expectBlocked: false, expectContact: 'akcept24+conveyor@gmail.com' },
  { name: 'telegram handle in contact + email in Step-2', input: { bpContact: '@acmeowner', ownerEmail: 'owner@acme.com' }, expectBlocked: false, expectContact: 'owner@acme.com' },
  { name: 'telegram handle only, no email', input: { bpContact: '@acmeowner' }, expectBlocked: true },
  { name: 'garbage in contact, no email', input: { bpContact: 'not-an-email' }, expectBlocked: true },
  { name: 'H1: blueprint email + Telegram handle in Step-2 (config must not carry the handle)', input: { bpContact: 'boss@acme.com', ownerEmail: '@acmeowner' }, expectBlocked: false, expectContact: 'boss@acme.com' },
  { name: 'H1b: blueprint email + t.me link in Step-2', input: { bpContact: 'boss@acme.com', ownerEmail: 'https://t.me/acmeowner' }, expectBlocked: false, expectContact: 'boss@acme.com' },
  { name: 'M1: two different emails — payload carries the blueprint one in both slots', input: { bpContact: 'alice@a.com', ownerEmail: 'bob@b.com' }, expectBlocked: false, expectContact: 'alice@a.com' },
];

let failures = 0;
for (const c of cases) {
  const r = runGate(c.input);
  const problems = [];
  if (r.blocked !== c.expectBlocked) problems.push('blocked=' + r.blocked + ' (expected ' + c.expectBlocked + ')');
  if (c.expectBlocked) {
    if (r.calls.length !== 0) problems.push('fetch fired ' + r.calls.length + ' time(s) despite the block');
  } else {
    if (r.calls.length !== 1) problems.push('fetch fired ' + r.calls.length + ' time(s) (expected 1)');
    if (!r.body) problems.push('request body did not parse');
    else {
      if (r.body.contact !== c.expectContact) problems.push('body.contact=' + JSON.stringify(r.body.contact) + ' (expected ' + JSON.stringify(c.expectContact) + ')');
      if (!r.body.config || r.body.config.ownerEmail !== c.expectContact) problems.push('config.ownerEmail=' + JSON.stringify(r.body.config && r.body.config.ownerEmail) + ' (expected ' + JSON.stringify(c.expectContact) + ')');
    }
  }
  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + c.name + (ok ? '' : ' | ' + problems.join('; ')));
}

if (failures) {
  console.error('\n' + failures + ' case(s) failed — checkout gate/payload regression.');
  process.exit(1);
}
console.log('\nAll ' + cases.length + ' checkout gate/payload cases pass.');
