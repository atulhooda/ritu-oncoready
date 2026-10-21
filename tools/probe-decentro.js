#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// WHICH DECENTRO CREDENTIAL PAIR IS THE PAYMENTS ONE?
//
// The account has two issued pairs — (Decentro_Client_ID_1, Decentro_Client_Secret)
// and (Decentro_Client_ID_2, Decentro_Client_Secret_2). Decentro issues
// credentials per module, and WHICH pair carries the payments module is not
// documented anywhere and cannot be inferred from the names.
//
// Guessing is exactly the failure mode this project keeps paying for: a wrong
// guess here does not throw loudly, it returns an auth error that reads like a
// dozen other problems, and someone spends a day on the wrong hypothesis.
//
// So: try both, against STAGING, with a real request, and report which one the
// server accepts. Then set DECENTRO_PAIR in .env and never think about it again.
//
// SAFETY
//   · Never prints a secret. Only the pair number and Decentro's own response.
//   · STAGING ONLY — refuses to run against production. A probe that creates
//     real payment links on a live account is not a probe.
//   · Uses ₹5, Decentro's documented minimum. (The payments plan says "₹1 test
//     payment" — that is NOT possible on this rail. Every such gate means ₹5.)
//   · Creates a payment link, which is inert until someone pays it. Nothing is
//     charged by running this.
//
//   node tools/probe-decentro.js
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();

const decentro = require('../decentro');

const mask = (s) => {
  const v = String(s || '');
  if (v.length <= 6) return '*'.repeat(v.length);
  return `${v.slice(0, 3)}…${v.slice(-2)} (${v.length} chars)`;
};

(async () => {
  // Hard stop: this must never touch production.
  const envMode = (process.env.DECENTRO_ENV || 'staging').toLowerCase();
  if (envMode !== 'staging') {
    console.error(`\n  REFUSING: DECENTRO_ENV=${envMode}. This probe is staging-only.`);
    console.error('  Set DECENTRO_ENV=staging in .env and re-run.\n');
    process.exit(2);
  }

  console.log('\n  Decentro credential probe — STAGING, ₹5 payment link (inert until paid)\n');

  // Show what is present WITHOUT revealing it, so a missing/truncated paste is
  // visible immediately rather than as a confusing auth failure.
  for (const pair of ['1', '2']) {
    try {
      const c = decentro._creds(pair);
      console.log(`  pair ${pair}: client_id ${mask(c.client_id)}  secret ${mask(c.client_secret)}`);
    } catch (e) {
      console.log(`  pair ${pair}: ${e.message}`);
    }
  }
  try {
    const c = decentro._creds('1');
    console.log(`  consumer_urn ${mask(c.consumer_urn)}\n`);
  } catch (_) { console.log(''); }

  const results = [];
  for (const pair of ['1', '2']) {
    process.stdout.write(`  trying pair ${pair} … `);
    try {
      const r = await decentro.createPaymentLink({
        amount: 5,
        purpose: 'Engageo credential probe',
        expiryMinutes: 10,
        psp: true,
        pair,
      });
      console.log('ACCEPTED');
      console.log(`     decentro_txn_id : ${r.txnId}`);
      console.log(`     reference_id    : ${r.referenceId}`);
      console.log(`     status          : ${r.status}`);
      const uris = r.uris || {};
      for (const [k, v] of Object.entries(uris)) {
        console.log(`     ${k.padEnd(15)} : ${String(v).slice(0, 96)}`);
      }
      results.push({ pair, ok: true, txnId: r.txnId, uriCount: Object.keys(uris).length });
    } catch (e) {
      console.log('rejected');
      console.log(`     ${e.message}`);
      results.push({ pair, ok: false, why: e.message });
    }
  }

  console.log('\n  ── verdict ──');
  const winners = results.filter((r) => r.ok);
  if (winners.length === 1) {
    console.log(`  Pair ${winners[0].pair} is the payments credential.`);
    console.log(`  Add to .env:   DECENTRO_PAIR=${winners[0].pair}`);
    console.log(`  It returned ${winners[0].uriCount} UPI URI(s) — tap-to-pay deep links are live.`);
  } else if (winners.length === 2) {
    console.log('  BOTH pairs authenticated. Either works for payments; using pair 1 is fine.');
    console.log('  Add to .env:   DECENTRO_PAIR=1');
  } else {
    console.log('  NEITHER pair authenticated. Do not guess from here — the likely causes are:');
    console.log('   · the account has not finished KYC / the payments module is not enabled yet');
    console.log('   · these are production credentials and there is a separate staging set');
    console.log('   · consumer_urn belongs to a different module than the client_id/secret');
    console.log('  Decentro\'s own error text is printed above — that is the thing to act on.');
  }
  console.log('');
  process.exit(winners.length ? 0 : 1);
})();
