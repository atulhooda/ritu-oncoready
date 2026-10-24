// ═══════════════════════════════════════════════════════════════════════════
// DECENTRO UPI COLLECTIONS v3 — the money REQUEST path.
//
// WHAT THIS IS FOR. Engageo takes no commission. Patients paying a clinic go
// patient → clinic's own VPA directly, because a flat per-transaction fee on a
// ₹700 consult at ~900 payments/clinic/month is roughly a third of the
// subscription revenue that clinic pays us. Decentro earns its fee on the OTHER
// flow — SaaS subscriptions, one payment per clinic per month — where ~₹3 buys
// a real server-side webhook and deletes an entire reconciliation workstream.
//
// SPEC, verified against the docs 2026-08-01:
//   DOC: POST {base}/v3/payments/upi/link
//        https://docs.decentro.tech/reference/payments_api-collectionsv3-paymentlink
//   DOC: staging  https://staging.api.decentro.tech
//        production https://api.decentro.tech
//   DOC: required headers are ONLY client_id + client_secret. v3 does NOT take a
//        module_secret (v2 did) — so Payments_Module_Secret / Ybl_Provider_Secret
//        are not used here. They are kept in .env for the core-banking APIs.
//   DOC: amount range is 5.00 – 100,000.00 INR. THE MINIMUM IS ₹5, NOT ₹1 —
//        the payments plan's "₹1 verification payment" is not possible on this
//        rail and every gate that referenced it means ₹5.
//   DOC: reference_id 5-50 chars and must be unique per request.
//   DOC: expiry_time is in MINUTES, max 1440.
//
// WHICH CREDENTIALS. Decentro issues per-module credential pairs, and this
// account has two (Decentro_Client_ID_1/Decentro_Client_Secret and
// Decentro_Client_ID_2/Decentro_Client_Secret_2). Which pair belongs to the
// payments module is NOT documented and NOT guessable — tools/probe-decentro.js
// determines it empirically and prints the answer. Set DECENTRO_PAIR=1|2 once
// it is known; until then this defaults to 1 and fails loudly rather than
// silently using the wrong one.
//
// NOTHING IN THIS FILE PRINTS A SECRET. Errors report the response body from
// Decentro, never the headers we sent.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const BASES = {
  staging: 'https://staging.api.decentro.tech',
  production: 'https://api.decentro.tech',
};

function env(name) {
  const v = process.env[name];
  return (v === undefined || v === null) ? '' : String(v).trim().replace(/^["']|["']$/g, '');
}

/**
 * Resolve credentials. `pair` selects which of the two issued pairs to use.
 * Throws with a NAMED missing variable — never a value.
 */
function creds(pair) {
  const p = String(pair || env('DECENTRO_PAIR') || '1');
  const idKey = p === '2' ? 'Decentro_Client_ID_2' : 'Decentro_Client_ID_1';
  const secKey = p === '2' ? 'Decentro_Client_Secret_2' : 'Decentro_Client_Secret';
  const client_id = env(idKey);
  const client_secret = env(secKey);
  const consumer_urn = env('Master_Consumer_URN');
  const missing = [];
  if (!client_id) missing.push(idKey);
  if (!client_secret) missing.push(secKey);
  if (!consumer_urn) missing.push('Master_Consumer_URN');
  if (missing.length) throw new Error(`Decentro credentials missing from env: ${missing.join(', ')}`);
  return { client_id, client_secret, consumer_urn, pair: p };
}

function baseUrl() {
  const mode = (env('DECENTRO_ENV') || 'staging').toLowerCase();
  const b = BASES[mode];
  // Refuse to guess. A typo'd DECENTRO_ENV silently pointing at production is
  // exactly the failure this project keeps paying for elsewhere.
  if (!b) throw new Error(`DECENTRO_ENV must be "staging" or "production", got "${mode}"`);
  return { base: b, mode };
}

// reference_id must be unique per request and 5-50 chars. It is also the ONLY
// thing tying Decentro's callback back to our invoice, so it is generated here
// rather than by a caller who might reuse one.
function makeReferenceId(prefix = 'ENG') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const ref = `${prefix}-${stamp}-${rand}`;
  return ref.slice(0, 50);
}

/**
 * Generate a UPI payment link.
 *
 * @param {object} a
 * @param {number} a.amount          INR. Must be >= 5 (Decentro's floor).
 * @param {string} a.purpose         5-50 chars, shown to the payer.
 * @param {string} [a.referenceId]   ours; generated if absent.
 * @param {number} [a.expiryMinutes] default 60, max 1440.
 * @param {boolean} [a.psp]          also return per-app deep links (GPay/PhonePe/Paytm/CRED).
 * @param {string} [a.pair]          credential pair override.
 * @returns {Promise<{ok:boolean, referenceId:string, txnId:?string, uris:object, status:?string, raw:object, httpStatus:number}>}
 */
async function createPaymentLink({ amount, purpose, referenceId, expiryMinutes = 60, psp = true, pair } = {}) {
  const c = creds(pair);
  const { base, mode } = baseUrl();

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 5) {
    // Caught here rather than at Decentro so the error names the real rule.
    throw new Error(`amount must be at least ₹5 (Decentro's documented floor), got ${amount}`);
  }
  const msg = String(purpose || '').trim();
  if (msg.length < 5 || msg.length > 50) {
    throw new Error(`purpose_message must be 5-50 chars, got ${msg.length}`);
  }
  const ref = referenceId || makeReferenceId();

  const body = {
    reference_id: ref,
    consumer_urn: c.consumer_urn,
    amount: amt,
    purpose_message: msg,
    expiry_time: Math.min(Math.max(1, Math.round(expiryMinutes)), 1440),
    generate_psp_uri: !!psp,
  };

  const res = await fetch(`${base}/v3/payments/upi/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      client_id: c.client_id,
      client_secret: c.client_secret,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON error page */ }

  if (!res.ok || !json || json.api_status !== 'SUCCESS') {
    const detail = json ? (json.message || json.response_key) : text.slice(0, 300);
    const err = new Error(`Decentro payment link failed (${res.status}, ${mode}, pair=${c.pair}): ${detail}`);
    err.httpStatus = res.status;
    err.raw = json || text;
    err.referenceId = ref;
    throw err;
  }

  const data = json.data || {};
  return {
    ok: true,
    referenceId: ref,                     // OUR key — what the callback must match
    txnId: json.decentro_txn_id || null,  // Decentro's key
    uris: data.upi_uris || {},
    status: (data.transaction_status || null),
    raw: json,
    httpStatus: res.status,
    mode,
  };
}

/**
 * Read a transaction's current state. Used to RECONCILE — never to decide that
 * money arrived on the strength of our own record. Decentro is the authority on
 * whether it was paid; our invoices table only reflects what it says.
 */
async function getTransactionStatus({ referenceId, pair } = {}) {
  const c = creds(pair);
  const { base, mode } = baseUrl();
  if (!referenceId) throw new Error('referenceId is required');

  const url = `${base}/v3/payments/transaction/status?reference_id=${encodeURIComponent(referenceId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { client_id: c.client_id, client_secret: c.client_secret },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { ok: res.ok, httpStatus: res.status, mode, raw: json || text };
}

module.exports = {
  createPaymentLink,
  getTransactionStatus,
  makeReferenceId,
  _creds: creds,      // for the probe only — returns secrets, never log the result
  _baseUrl: baseUrl,
  BASES,
};
