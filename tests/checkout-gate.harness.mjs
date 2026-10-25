// Regression harness for the wizard checkout email gate
// (public/acme-prop-demo-wizard.html, #checkoutBtn click handler).
//
// It extracts the ACTUAL gate code from the wizard file — from
// `var bpName = ...` up to the line before the fetch setup — and runs it
// in a sandbox with stubbed document/state/showToast, so the check
// exercises the shipped logic, not a copy of it.
//
// Bug it guards against (2026-10-24): the gate's email regex was
// double-escaped (/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/), so `\\.` demanded a
// literal backslash before the TLD and NO real email could ever pass —
// checkout blocked every buyer with "An email is required for checkout".
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
const endMarker = "var btn = document.getElementById('checkoutBtn');";
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker);
if (start === -1 || end === -1 || end <= start) {
  console.error('FAIL: could not locate the checkout gate block in ' + file);
  process.exit(1);
}
const gate = html.slice(start, end);

function runGate({ bpName = '', bpContact = '', legalName = 'Acme Prop LLC', ownerEmail = '' }) {
  const toasts = [];
  const result = { contact: null, blocked: null };
  const values = {
    bpName: { value: bpName },
    bpContact: { value: bpContact },
    checkoutNote: { textContent: '' },
  };
  const documentStub = { getElementById: (id) => values[id] || { value: '', textContent: '' } };
  const state = { legalName, ownerEmail };
  const showToast = (msg) => toasts.push(msg);
  const fn = new Function(
    'document', 'state', 'showToast', '__result',
    gate + '\n__result.contact = (typeof contact !== "undefined") ? contact : null;'
  );
  fn(documentStub, state, showToast, result);
  result.blocked = toasts.includes('An email is required for checkout');
  return result;
}

const cases = [
  { name: 'email only in Step-2 company field', input: { ownerEmail: 'owner@acme.com' }, expectBlocked: false, expectContact: 'owner@acme.com' },
  { name: 'email only in final blueprint contact', input: { bpContact: 'boss@acme.com' }, expectBlocked: false, expectContact: 'boss@acme.com' },
  { name: 'no email anywhere', input: {}, expectBlocked: true },
  { name: 'plus-address in final contact', input: { bpContact: 'akcept24+conveyor@gmail.com' }, expectBlocked: false, expectContact: 'akcept24+conveyor@gmail.com' },
  { name: 'plus-address in BOTH fields (the live E2E case)', input: { bpContact: 'akcept24+conveyor@gmail.com', ownerEmail: 'akcept24+conveyor@gmail.com' }, expectBlocked: false, expectContact: 'akcept24+conveyor@gmail.com' },
  { name: 'plus-address in Step-2 only', input: { ownerEmail: 'akcept24+conveyor@gmail.com' }, expectBlocked: false, expectContact: 'akcept24+conveyor@gmail.com' },
  { name: 'telegram handle in contact + email in Step-2 (payload must carry the email)', input: { bpContact: '@acmeowner', ownerEmail: 'owner@acme.com' }, expectBlocked: false, expectContact: 'owner@acme.com' },
  { name: 'telegram handle only, no email', input: { bpContact: '@acmeowner' }, expectBlocked: true },
  { name: 'garbage in contact, no email', input: { bpContact: 'not-an-email' }, expectBlocked: true },
];

let failures = 0;
for (const c of cases) {
  const r = runGate(c.input);
  const blockedOk = r.blocked === c.expectBlocked;
  const contactOk = c.expectContact === undefined || r.contact === c.expectContact;
  const ok = blockedOk && contactOk;
  if (!ok) failures++;
  console.log(
    (ok ? 'PASS' : 'FAIL') + ' — ' + c.name +
    ' | blocked=' + r.blocked + ' (expected ' + c.expectBlocked + ')' +
    (c.expectContact !== undefined ? ' | contact=' + JSON.stringify(r.contact) + ' (expected ' + JSON.stringify(c.expectContact) + ')' : '')
  );
}

if (failures) {
  console.error('\n' + failures + ' case(s) failed — checkout gate regression.');
  process.exit(1);
}
console.log('\nAll ' + cases.length + ' checkout-gate cases pass.');
