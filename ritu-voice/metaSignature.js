// ═══════════════════════════════════════════════════════════════════════════
// META WEBHOOK SIGNATURE — proving an inbound WhatsApp message came from Meta.
//
// FOUND BY AUDIT 2026-08-07. The webhook accepted ANY POST. The whole check was
// `body.object !== 'whatsapp_business_account'`, which is a field the sender
// chooses. Anyone who learned the Railway URL could:
//   · create patient rows       (whatsapp.js — patient upsert on first message)
//   · inject conversation history under a real patient's phone number
//   · trigger the emergency alert to a number of their choosing
//   · run the brain, and so spend the LLM budget
// Meta signs every delivery with X-Hub-Signature-256; nothing read it.
//
// TWO THINGS MAKE THIS SUBTLER THAN IT LOOKS.
//
// 1. THE RAW BYTES ARE GONE BY THE TIME THE HANDLER RUNS. express.json() parses
//    and discards the body, and the signature is over the exact bytes Meta sent
//    — re-serialising req.body will not reproduce them (key order, unicode
//    escaping, whitespace). index.js therefore captures the buffer in the
//    parser's `verify` hook, which is the only place it still exists.
//
// 2. COMPARISON MUST BE TIMING-SAFE. A byte-by-byte === leaks how much of the
//    digest was correct, which is enough to forge one given enough attempts
//    against an endpoint that will happily accept retries.
//
// FAIL-OPEN WHEN UNCONFIGURED, AND LOUD ABOUT IT. If META_APP_SECRET is unset
// this returns 'unconfigured' rather than rejecting, because shipping a change
// that silently drops every real patient message is a worse outage than the
// exposure it closes. The boot log and the per-call runtime config both report
// the state, so "we are enforcing" is a fact that can be checked rather than
// assumed — the same lesson three investigations landed on this week.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');

/**
 * @returns {'valid'|'invalid'|'missing'|'unconfigured'|'no-body'}
 *   valid        signature present and correct
 *   invalid      signature present and WRONG — reject, and it is worth alerting on
 *   missing      no signature header at all — reject when configured
 *   unconfigured no META_APP_SECRET — cannot verify, caller decides (we allow + warn)
 *   no-body      raw bytes were not captured — a wiring bug, never the sender's fault
 */
function verifyMetaSignature(rawBody, headerValue, appSecret) {
  if (!appSecret) return 'unconfigured';
  if (!rawBody || !rawBody.length) return 'no-body';

  const header = String(headerValue || '');
  if (!header.startsWith('sha256=')) return 'missing';

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice('sha256='.length);

  // timingSafeEqual THROWS on a length mismatch, which would itself be a
  // side channel and a crash. Compare lengths first, then bytes.
  if (got.length !== expected.length) return 'invalid';
  try {
    return crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'))
      ? 'valid'
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Should this request be processed? Kept separate from the verdict so the
 * policy — what we do when unconfigured — is one obvious line rather than
 * spread through the handler.
 */
function shouldAccept(verdict) {
  return verdict === 'valid' || verdict === 'unconfigured';
}

module.exports = { verifyMetaSignature, shouldAccept };
