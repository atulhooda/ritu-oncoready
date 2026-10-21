// ═══════════════════════════════════════════════════════════════════════════
// DEVANAGARI → LATIN ROMANIZATION, tuned for DRUG-NAME MATCHING.
//
// WHY THIS EXISTS (measured 2026-07-25, Eka clinical corpus n=30/320):
// findDrugMention only scans /[a-z]{3,}/ — Latin. So every drug the STT writes
// in Devanagari is invisible to it, INCLUDING drugs that are already in our
// generic list: पैरासिटामोल (Paracetamol) and मेटफॉर्मिन (Metformin) both MISS.
// That is a script gap sitting underneath the brand-vocabulary gap, and it
// costs us drugs we already know how to name.
//
// It also unblocks honest measurement: the Eka gold annotations are Devanagari
// while codemix output is Latin, so string-comparing them scores a script
// difference as a recognition failure. "टेल्मा फोर्टी" vs heard "Telma 40" is a
// PERFECT capture that naive scoring counts as a miss.
//
// NOT a scholarly transliterator. It is deliberately biased toward how Indian
// drug names are actually spelled in Latin — loanword orthography, not ISO
// 15919. The big one: ै romanizes to 'a', not 'ai', because पैरासिटामोल must
// land near "paracetamol" (it does: "parasitamol", 2 edits) rather than
// "pairasitamol" (5 edits, outside the matcher's 0.34 threshold). Downstream
// matching is fuzzy Levenshtein, so being phonetically close beats being
// orthographically correct.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// Consonants carry an inherent 'a' unless followed by a vowel sign or virama.
const CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'ळ': 'l',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  // nukta forms (common in loanwords: ज़िंक, फ़ोलिक)
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
};

// Vowel SIGNS (matras). ै→'a' and ौ→'o' are the loanword-tuned choices.
const MATRA = {
  'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u',
  'े': 'e', 'ै': 'a', 'ो': 'o', 'ौ': 'o',
  'ृ': 'ri', 'ॉ': 'o', 'ॅ': 'a', 'ॆ': 'e', 'ॊ': 'o',
};

// Independent vowels.
const VOWEL = {
  'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऋ': 'ri',
  'ऑ': 'o', 'ॲ': 'a', 'ऍ': 'e',
};

const VIRAMA = '्';
const NASALS = { 'ं': 'n', 'ँ': 'n', 'ः': 'h' }; // ं ँ ः
const DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };

// Sentinel for an INHERENT (unwritten) 'a'. Hindi deletes the word-final schwa
// — मेटफॉर्मिन is "metformin", not "metformina" — but a WRITTEN ा must survive
// (टेल्मा really is "telma"). Marking the two apart is the only way to drop one
// without eating the other; the sentinel becomes 'a' everywhere except at a
// word boundary. Measured: this alone took romanized drug names from 7/10 to
// 9/10 inside the matcher's 0.34 threshold.
const INHERENT = '';

// The NUKTA (U+093C) is a separate combining character: ज़ is usually stored as
// ज + ़, two codepoints. romanizeChar looks at ONE character at a time, so a
// two-codepoint sequence could never match the two-char CONS keys — and
// Unicode's precomposed nukta forms (U+0958–U+095F) are composition
// exclusions, so NFC does NOT merge them either. Result before this fix:
// ज़ीफि romanized to "j़iphi", diacritic passed through raw, and Zifi never
// resolved. Fold the pair explicitly.
const NUKTA = '़';
const NUKTA_PAIR = { 'क': 'क़', 'ख': 'ख़', 'ग': 'ग़', 'ज': 'ज़', 'ड': 'ड़', 'ढ': 'ढ़', 'फ': 'फ़', 'य': 'य़' };

function romanizeChar(chars, i, out) {
  const ch = chars[i];
  if (CONS[ch]) {
    out.push(CONS[ch]);
    const next = chars[i + 1];
    if (next === VIRAMA) return i + 2;            // conjunct → no inherent vowel
    if (next && MATRA[next]) { out.push(MATRA[next]); return i + 2; }
    out.push(INHERENT);                            // inherent vowel (may be deleted)
    return i + 1;
  }
  if (VOWEL[ch]) { out.push(VOWEL[ch]); return i + 1; }
  if (MATRA[ch]) { out.push(MATRA[ch]); return i + 1; }   // stray matra
  if (NASALS[ch]) { out.push(NASALS[ch]); return i + 1; }
  if (DIGITS[ch]) { out.push(DIGITS[ch]); return i + 1; }
  if (ch === VIRAMA) return i + 1;
  out.push(ch);                                    // pass through Latin/space/punct
  return i + 1;
}

// romanize('टेल्मा') → 'telma'
// ─── THE PRECOMPOSED NUKTA LETTERS ──────────────────────────────────────────
// Devanagari spells क़ ख़ ग़ ज़ ड़ ढ़ फ़ य़ two ways: base + combining nukta
// (U+093C), or a single precomposed codepoint (U+0958-095F). NUKTA_PAIR below
// handles the first — its values are the DECOMPOSED sequences, so that fold is
// a no-op and the following line strips the nukta, leaving a base consonant the
// table knows. The precomposed range appears in no table at all and fell
// straight through the romanizer as raw Devanagari.
//
// MEASURED on production, 2026-08-15, in the backfill that put readable names
// on the desk:
//     আমন নাম্বারিয়া  ->  "Aman Nambariय़a"
// Bengali য় is precomposed (U+09DF); the block shift lands it on U+095F and it
// came out the far end untouched, in the middle of a Latin name a receptionist
// was meant to read. Every Indic script has these, so the block shift makes
// this reachable from all nine rather than just Hindi.
//
// Mapped to the BASE consonant, which is what the decomposed path already
// produces after the nukta strip — क़ and क both give "k". Keeping the two
// paths identical matters more here than the phonetic nicety, because a name
// romanized one way on write and another on read stops matching itself.
const _PRECOMPOSED_NUKTA = {   // kept as the record of a wrong table (see romanize); not consulted
  '\u0958': 'क', '\u0959': 'ख', '\u095A': 'ग', '\u095B': 'ज',
  '\u095C': 'ड', '\u095D': 'ढ', '\u095E': 'फ', '\u095F': 'य',
};

function romanize(text) {
  // ─── UNICODE KNOWS THE NUKTA LETTERS; OUR HAND-LIST ONLY KNEW EIGHT ───────
  // PRECOMPOSED_NUKTA was written from the U+0958–095F range, which is the
  // range a person finds when they go looking. Devanagari has ELEVEN precomposed
  // nukta letters: U+0929 ऩ, U+0931 ऱ and U+0934 ऴ carry canonical
  // decompositions too and were in no table here, so they fell through
  // romanizeChar and were emitted as raw Devanagari inside Latin output — the
  // exact defect the production backfill caught as "Aman Nambariय़a", three more
  // times, still live.
  //
  // AND THEY ARE NOT OBSCURE. Those three slots are where Tamil ன ற ழ and
  // Malayalam റ ഴ land after the block shift. MEASURED before this change:
  //
  //     தமிழ்  ("Tamil")  ->  "tamiऴ"
  //     വഴി    ("way")    ->  "vऴi"
  //
  // ழ is the letter in the word Tamil; ன is one of the commonest Tamil
  // consonants. Part of what was recorded as "Tamil is weak because it has no
  // voiced/aspirated distinction" was in fact this — a missing table entry, not
  // a property of the language.
  //
  // NFD IS THE WHOLE LIST, MAINTAINED BY SOMEONE ELSE. Every one of these is a
  // canonical decomposition in UnicodeData.txt, so String.normalize('NFD')
  // yields base + U+093C for all eleven, and for the Bengali, Gurmukhi and Odia
  // precomposed forms as well. The old comment below was right that NFC will not
  // COMPOSE them (they are composition exclusions) and drew the wrong conclusion
  // from it: we never wanted them composed. We wanted them decomposed, which is
  // exactly what the standard already does.
  let s = String(text || '').normalize('NFD');
  for (const [base, joined] of Object.entries(NUKTA_PAIR)) {
    s = s.split(base + NUKTA).join(joined);
  }
  s = s.split(NUKTA).join('');   // any stray nukta left over
  const chars = [...s];
  const out = [];
  let i = 0;
  while (i < chars.length) i = romanizeChar(chars, i, out);
  // Schwa deletion: an inherent 'a' at the end of a word is not pronounced.
  // Everywhere else it is.
  return out.join('')
    .replace(new RegExp(INHERENT + '(?=$|[^A-Za-z0-9])', 'g'), '')
    .replace(new RegExp(INHERENT, 'g'), 'a');
}

// Ambiguous Devanagari→Latin correspondences that matter for Indian drug
// brands: ज is j or z (अजूलिक्स = Azulix), स is s or c (सिट्रिजिन =
// Cetirizine), क्स is ks or x, ऑ is o or au (ऑगमेंटिन = Augmentin). One
// romanization has to pick; the matcher can afford to try all of them, so
// romanizeVariants returns the small cross-product and callers keep the best
// match. Capped so a long string can't explode combinatorially.
// Indian BRAND orthography differs from scholarly transliteration in ways that
// decide whether a name matches at all — measured against the real brand index:
//   फ  is written f, not ph   (कॉम्बिफ्लेम = Combiflam, ज़ीफि = Zifi)
//   क  is often c             (क्रोसिन = Crocin)
//   ज  is often z             (अजूलिक्स = Azulix)
//   स  is often c             (सिट्रिजिन = Cetirizine)
//   क्स is x                   (…लिक्स = …lix)
//   ऑ  may be au              (ऑगमेंटिन = Augmentin)
const AMBIGUOUS = [
  [/ph/g, 'f'], [/j/g, 'z'], [/s/g, 'c'], [/ks/g, 'x'], [/^k/, 'c'], [/^o/, 'au'], [/v/g, 'w'],
];

// ─── SPECULATIVE TRANSLITERATION, AND WHY IT IS A SEPARATE TIER ─────────────
// MEASURED 2026-08-05, from asking what the drug-capture ceiling is actually
// made of. Of 814 gold spans, 278 name no molecule at all ("टैबलेट",
// "एंटीबायोटिक", "15 टैबलेट") and must never match. Against the 536 that do,
// the ceiling is 49.8%, not the 38.7% the row reported.
//
// And the misses are ordinary molecules ALREADY in the lexicon, failing purely
// on transliteration, in three repeating ways:
//     डाइक्लोफेनेक     → daiklofenek        vs diclofenac
//     ग्लाइकोमेट        → glaikomet          vs glycomet
//     मिथाइलकोबालामिन  → mithailakobalamin  vs methylcobalamin
// The k↔c rule above is ANCHORED (/^k/), so a medial k never converts.
//
// ADDING THESE TO `AMBIGUOUS` WAS TRIED AND BLOCKED THE SUITE:
//     recall            29.73 → 34.89   +5.16
//     false positives    0.90 →  2.93   +2.03   HARD FAIL, 3x the kill criterion
// and worse than the number — it produced a WRONG MOLECULE:
// एसिक्लोफेनेक (Aceclofenac) resolved to Diclofenac. A confidently wrong drug
// is the failure this whole plane exists to prevent, and it is worse than the
// miss it replaced.
//
// The mistake was treating a speculative transform as equal evidence. These
// rules are GUESSES about how a transliterator rendered a sound — three chained
// substitutions away from what was actually heard. So they earn a candidate,
// but that candidate must land far closer to be believed: SPECULATIVE_MAX_DIST
// in readback.js, not the ordinary romanized bar.
//
// daiklofenek → diclofenac lands EXACT under these rules, so the recall this
// was built for survives a tight bar. esiklofenek → diclofenac does not.
const SPECULATIVE = [
  [/k/g, 'c'],                    // medial k, which /^k/ above cannot reach
  [/ai/g, 'i'], [/ai/g, 'y'],     // the ai-diphthong: डाइ→di, ग्लाइ→gly
  [/ek$/, 'ac'],                  // the -fenac / -zolac family endings
];

/**
 * Variants reachable only through the speculative table. Returned SEPARATELY
 * from romanizeVariants so the caller can hold them to a different threshold —
 * merging the two lists is what produced the wrong molecule above.
 */
function speculativeVariants(text, max = 12) {
  const base = new Set(romanizeVariants(text, max));
  const out = new Set();
  for (const [re, alt] of SPECULATIVE) {
    for (const v of [...base, ...out]) {
      if (out.size >= max) break;
      const swapped = v.replace(re, alt);
      if (swapped !== v && !base.has(swapped)) out.add(swapped);
    }
  }
  return [...out];
}
// Apply the ambiguity table to an ALREADY-LATIN string. Split out of
// romanizeVariants so that readback.js can expand its stoplists through the
// SAME table that generates its candidates — a word listed under one spelling
// was otherwise still live under every other spelling this emits. See the
// "EXPAND EVERY STOPLIST" note in readback.js for the two live bugs that cost.
function spellingVariants(base, max = 12) {
  const seen = new Set([base]);
  for (const [re, alt] of AMBIGUOUS) {
    for (const v of [...seen]) {
      if (seen.size >= max) break;
      const swapped = v.replace(re, alt);
      if (swapped !== v) seen.add(swapped);
    }
  }
  return [...seen];
}

function romanizeVariants(text, max = 12) {
  return spellingVariants(romanize(text), max);
}

// True when the string contains any Devanagari — cheap guard so callers only
// pay for romanization when there is something to romanize.
function hasDevanagari(text) {
  return /[ऀ-ॿ]/.test(String(text || ''));
}

// ─── THE OTHER EIGHT SCRIPTS ────────────────────────────────────────────────
// This file romanizes DEVANAGARI, and readback.js gates on hasDevanagari — so a
// drug named in Kannada, Bengali, Tamil, Telugu, Punjabi, Gujarati, Malayalam
// or Odia was invisible to the matcher. MEASURED 2026-08-15:
//
//     dolo   -> Paracetamol      डोलो  -> Paracetamol
//     ಡೋಲೋ  -> (nothing)         ডোলো  -> (nothing)   … and six more
//
// A live Kannada call the same day: "ರಾತ್ರಿ ನಾನೊಂದು ಡೋಲೋ ತಗೊಂಡಿದ್ದೆ" — I took a
// Dolo last night. Transcribed perfectly. Recorded nowhere, because the matcher
// never saw a drug at all. Two of eleven languages had clinical capture; nine
// had none, and no read-back or prior could help since nothing was ever
// detected.
//
// THE FIX WAS ALREADY IN THE CODEBASE, TWICE. callHandler.js (~line 143) and
// emergencyDetectorV2.js:98 both carry this exact block-shift, with a comment
// explaining that the nine Brahmic Unicode blocks share one 128-codepoint
// layout so a per-block offset maps every Indic script onto Devanagari. It was
// written for emergency detection and the allergy regex. The drug matcher — the
// thing this whole product is measured on — never got it.
//
// Fifth time this month one rule has lived in more than one place: four
// sentinel lists, three patient resolvers, two phone normalisers, two name
// parsers, and now three transliterators. This is the copy that should survive;
// the other two should import it.
//
// LOSSY, AND THAT IS FINE. Tamil has no voiced/aspirated distinction, so
// டோலோ -> "tolo" rather than "dolo". Bengali ব -> 'b', so পৃথ্বী -> "prithbi".
// Downstream matching is fuzzy Levenshtein at 0.34, and "tolo"/"prithbi" sit
// well inside that. Phonetic closeness beats orthographic correctness here —
// the same trade this file's header already makes for ै -> 'a'.
const INDIC_BLOCKS = [0x0980, 0x0A00, 0x0A80, 0x0B00, 0x0B80, 0x0C00, 0x0C80, 0x0D00];

// ─── MALAYALAM CHILLU LETTERS HAVE NO SLOT TO SHIFT INTO ───────────────────
// A chillu is a consonant with no inherent vowel — the form Malayalam uses at
// the end of a word, and therefore the form almost every Malayalam name ends
// in. Unicode encoded them ATOMICALLY in 5.1 (U+0D7A–U+0D7F) with NO canonical
// decomposition, so NFD cannot reach them, and the block shift sends them to
// U+097A–097F, which are unrelated rare Devanagari letters rather than the
// consonants they represent.
//
// MEASURED: the Malayalam name കുഞ്ഞിരാമൻ romanized to "Kunniramॻ" — a raw
// Devanagari letter at the end of a name a receptionist reads off the desk.
// Same defect as "Aman Nambariय़a", by a route NFD does not cover.
//
// Mapped to base consonant + virama, which is what a chillu IS; the virama then
// block-shifts to U+094D like any other and the romanizer's schwa handling does
// the rest. This is the one place a hand-written table is unavoidable, because
// the standard deliberately does not decompose these.
const MALAYALAM_CHILLU = {
  'ൺ': 'ണ്',   // ൺ -> ണ്  NNA
  'ൻ': 'ന്',   // ൻ -> ന്  NA
  'ർ': 'ര്',   // ർ -> ര്  RA
  'ൽ': 'ല്',   // ൽ -> ല്  LA
  'ൾ': 'ള്',   // ൾ -> ള്  LLA
  'ൿ': 'ക്',   // ൿ -> ക്  KA
};

function toDevanagari(text) {
  let src = String(text || '');
  for (const [chillu, base] of Object.entries(MALAYALAM_CHILLU)) {
    if (src.includes(chillu)) src = src.split(chillu).join(base);
  }
  let out = '';
  for (const ch of src) {
    const c = ch.codePointAt(0);
    const block = INDIC_BLOCKS.find((b) => c >= b && c < b + 0x80);
    out += block ? String.fromCodePoint(0x0900 + (c - block)) : ch;
  }
  // Slot mismatches, identical to the two existing copies: Dravidian short e/o
  // vowel signs land on Devanagari's rare short forms, and the Gurmukhi tippi
  // lands on the abbreviation-sign slot.
  return out
    .replace(/ॆ/g, 'े').replace(/ॊ/g, 'ो')
    .replace(/ऎ/g, 'ए').replace(/ऒ/g, 'ओ')
    .replace(/॰/g, 'ं');
}

// Any Brahmic script, Devanagari included.
function hasIndic(text) {
  return /[ऀ-ॿ\u0980-\u0DFF]/.test(String(text || ''));
}

// ─── WHICH SCRIPT IS THIS, AND IS IT THE ONE WE ARE ABOUT TO SPEAK IN? ──────
// MEASURED on live call ed685d54, 2026-08-15. The first thing the caller heard:
//
//     ನಮಸ್ಕಾರ পৃথ্বী ಅವರೇ! ನಾನು ಋತು, स्माईल मल्टीस्पेशालिटी क्लिनिक ಇಂದ...
//
// Three scripts in one utterance sent as ONE Sarvam request with the Kannada
// speaker: a Kannada sentence frame, the patient's name in BENGALI (whatever
// script their row was written in), and the clinic's name in DEVANAGARI (the
// configured string). A TTS engine given a Bengali word in a Kannada request
// does not code-switch — it mispronounces or drops it, and this is the caller's
// own name in the first second of the call.
//
// LATIN IS THE ONE SCRIPT EVERY INDIC VOICE HANDLES, because loanwords and
// brand names arrive that way constantly. So an off-script token is romanized
// rather than left alone or dropped.
const LANG_BLOCK = {
  'hi-IN': 0x0900, 'mr-IN': 0x0900, 'sa-IN': 0x0900,
  'bn-IN': 0x0980, 'as-IN': 0x0980,
  'pa-IN': 0x0A00, 'gu-IN': 0x0A80,
  'od-IN': 0x0B00, 'or-IN': 0x0B00,   // the repo says od-IN; ISO says or-IN
  'ta-IN': 0x0B80, 'te-IN': 0x0C00, 'kn-IN': 0x0C80, 'ml-IN': 0x0D00,
};

// The Brahmic block a character belongs to, or null for anything else
// (Latin, digits, punctuation, emoji — none of which need transliterating).
function blockOfChar(cp) {
  if (cp >= 0x0900 && cp <= 0x097F) return 0x0900;
  for (const b of INDIC_BLOCKS) if (cp >= b && cp <= b + 0x7F) return b;
  return null;
}

// The dominant Brahmic block in `text`, or null when it contains no Indic
// letters at all. Dominant rather than first: a name is occasionally one stray
// codepoint from a neighbouring block and that should not decide the answer.
function scriptOf(text) {
  const counts = new Map();
  for (const ch of String(text || '')) {
    const b = blockOfChar(ch.codePointAt(0));
    if (b !== null) counts.set(b, (counts.get(b) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [b, c] of counts) if (c > n) { best = b; n = c; }
  return best;
}

/**
 * `text` rendered so a `langCode` voice can pronounce it.
 *
 * Unchanged when it is already in that language's script, or carries no Indic
 * letters at all (Latin passes straight through — that is the target). Only a
 * token in a DIFFERENT Brahmic script is romanized, because that is the case
 * the engine cannot handle.
 *
 * Returns the ORIGINAL, never an empty string, if romanization produces
 * nothing usable: a mispronounced name beats a missing one.
 */
function toSpeakableScript(text, langCode) {
  const s = String(text || '');
  if (!s || !hasIndic(s)) return s;
  const want = LANG_BLOCK[langCode];
  const got = scriptOf(s);
  if (want === undefined || got === null || got === want) return s;
  const out = romanize(toDevanagari(s)).trim();
  if (!out || !/[a-z]{2,}/i.test(out)) return s;
  return out.split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The same rule applied WORD BY WORD, for a sentence that is mostly in the
 * right script but carries interpolated foreign-script tokens.
 *
 * A greeting is exactly that shape: a Kannada frame with a Bengali name and a
 * Devanagari clinic name dropped into it. Whole-string `toSpeakableScript`
 * cannot help there — the dominant script IS the target, so it correctly
 * returns the sentence untouched while the two foreign words stay foreign.
 *
 * Deliberately NOT applied to Ritu's general replies. If the model answers a
 * Bengali call entirely in Devanagari, every token is off-script and this would
 * quietly romanize the whole reply — a much larger behaviour change than the
 * one being fixed, and one that deserves its own evidence.
 */
function toSpeakableScriptWords(text, langCode) {
  const s = String(text || '');
  if (!s || !hasIndic(s) || LANG_BLOCK[langCode] === undefined) return s;
  return s.split(/(\s+)/).map((tok) => (/\s/.test(tok) ? tok : toSpeakableScript(tok, langCode))).join('');
}

module.exports = {
  romanize, romanizeVariants, speculativeVariants, spellingVariants,
  hasDevanagari, toDevanagari, hasIndic,
  scriptOf, toSpeakableScript, toSpeakableScriptWords, LANG_BLOCK,
};
