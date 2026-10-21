// ═══════════════════════════════════════════════════════════════════════════
// INDIC SCRIPT -> DEVANAGARI, for detectors that are written in Devanagari.
//
// Extracted from callHandler.js so the WhatsApp path can normalise typed text
// before running the emergency / medical-advice / sensitive-data detectors,
// WITHOUT importing callHandler (see safetyText.js for why that would break the
// voice path).
//
// The Indic blocks are code-point aligned, so a fixed offset converts most
// letters. The replace() tail fixes the slots that alignment cannot.
// ═══════════════════════════════════════════════════════════════════════════
"use strict";

const INDIC_BLOCKS = [0x0980, 0x0A00, 0x0A80, 0x0B00, 0x0B80, 0x0C00, 0x0C80, 0x0D00];
function toDevanagari(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    const block = INDIC_BLOCKS.find(b => c >= b && c < b + 0x80);
    out += block ? String.fromCodePoint(0x0900 + (c - block)) : ch;
  }
  // Normalize slot mismatches the offset shift can't fix: Dravidian short e/o
  // vowel signs land on Devanagari's rare short forms (ॆ ॊ ऎ ऒ → े ो ए ओ),
  // and Gurmukhi's tippi nasal lands on the abbreviation-sign slot (॰ → ं).
  return out.replace(/ॆ/g, 'े').replace(/ॊ/g, 'ो').replace(/ऎ/g, 'ए').replace(/ऒ/g, 'ओ').replace(/॰/g, 'ं');
}

module.exports = { toDevanagari, INDIC_BLOCKS };
