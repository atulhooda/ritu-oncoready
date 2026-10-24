// ─────────────────────────────────────────────────────────────────────────────
// Per-clinic WhatsApp credentials (COEXISTENCE).
//
// When a clinic connects WhatsApp via the admin app's "Connect WhatsApp" flow,
// the admin app stores { phone_number_id } on the clinic row and the access token
// AES-256-GCM-encrypted in clinic_whatsapp_secrets. This loads + decrypts those so
// the voice server can send the confirmation from the CLINIC'S OWN number/token.
//
// Safety: returns null on ANY problem (table missing on the hospital DB, no row,
// not connected, decrypt failure, key unset) so the caller cleanly falls back to
// the env-configured number — a booking confirmation must never crash a call.
// The encryption format ("v1:iv:tag:ciphertext", hex) matches the admin app's
// lib/crypto.ts; WA_TOKEN_ENC_KEY must be the SAME value on both deployments.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const db = require('./db');

function decryptToken(blob) {
  const raw = process.env.WA_TOKEN_ENC_KEY;
  if (!raw) throw new Error('WA_TOKEN_ENC_KEY not set');
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('WA_TOKEN_ENC_KEY must be 32 bytes');
  const [v, ivH, tagH, ctH] = String(blob).split(':');
  if (v !== 'v1' || !ivH || !tagH || !ctH) throw new Error('bad secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivH, 'hex'));
  d.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([d.update(Buffer.from(ctH, 'hex')), d.final()]).toString('utf8');
}

// → { phoneNumberId, accessToken } for a connected clinic, or null (env fallback).
async function getClinicWhatsAppCreds(clinicId) {
  if (!clinicId || !process.env.WA_TOKEN_ENC_KEY) return null;
  try {
    const { rows } = await db.pool.query(
      `SELECT c.phone_number_id, s.access_token_enc
         FROM clinics c
         JOIN clinic_whatsapp_secrets s ON s.clinic_id = c.id
        WHERE c.id = $1 AND c.whatsapp_status = 'connected'`,
      [clinicId]
    );
    const r = rows[0];
    if (!r || !r.phone_number_id || !r.access_token_enc) return null;
    return { phoneNumberId: r.phone_number_id, accessToken: decryptToken(r.access_token_enc) };
  } catch (err) {
    // table absent (hospital) / decrypt failure → env fallback, never throw into a booking
    console.warn('[META-WA] per-clinic creds unavailable, using env fallback:', err.message);
    return null;
  }
}

module.exports = { getClinicWhatsAppCreds, decryptToken };
