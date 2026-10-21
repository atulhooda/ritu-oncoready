// ═══════════════════════════════════════════════════════════════════════════
// EMERGENCY DETECTOR V2 — proximity-windowed token matcher (S4 spec §2)
//
// PURE MODULE: zero requires (Node builtins only, and none are needed). Same
// purity discipline as garbleGuard so the eval suite can replay it forever.
//
// Relationship to v1 (emergencyDetector.js):
//   - v1 is UNTOUCHED and stays authoritative. callHandler runs v1 first;
//     v2 runs ONLY when v1 did not fire. v2 can therefore only ADD coverage,
//     never suppress an escalation (inverted-shadow rule for fail-open guards).
//   - Shadow by default: EMERGENCY_V2 env unset/off → callHandler logs
//     '[EMERGENCY-V2-SHADOW] ...' and changes nothing else.
//
// Design (S4-safety-plane-spec.md §2, criterion sources in each rule):
//   IITT-A/P/R = WHO/ICRC/MSF Interagency Integrated Triage Tool
//                (adult / pediatric / reference card)
//   ATP        = AIIMS Triage Protocol RED (validated on 13,754 ED patients)
//   GoI-B7     = MoHFW ANC-SAB Guidelines Box 7 (obstetric danger signs)
//
// Matching architecture (CDC/NSSP ESSENCE-style, spec §2.2), FIX ROUND 2026-07:
//   normalize → transliterate-to-Devanagari canonical → tokenize → rule fires
//   on (standalone phrase present WITHIN A PROXIMITY WINDOW) OR (site term and
//   symptom term within PAIR_WINDOW tokens of each other). The 2026-07-21 FP
//   hunt proved whole-utterance bag-of-words unsafe ("दिल से धन्यवाद … पैर का
//   दर्द" fired cardiac): every multi-term pattern now carries a token-span
//   budget. Defaults: phrase span ≤ (terms-1)*3; site↔symptom |i-j| ≤ 4
//   (rule-overridable). Word-order stays free inside the window ("chest pain"
//   == "pain in the chest"), but cross-clause accidental co-occurrence no
//   longer fires.
//
// Word-boundary safety: matching is per-TOKEN, exact by default. Prefix
//   (stem) matching is opt-in per entry ('*' suffix); stems are build-time
//   asserted ≥3 canonical chars. 'त1|त2' is alternation (explicit inflection
//   lists — e.g. पड़|पड़ा|पड़े so that पड़ोस can never satisfy दौरा-पड़*).
//
// Per-entry guards added in the fix round (each cites the FP it kills):
//   w:N        — phrase span override (['दिल','दौरा'] w:2 kills "दिल के
//                डॉक्टर का दौरा" span 4, keeps "दिल का दौरा" span 2)
//   ordered    — terms must appear in written order ("current laga" ✓,
//                "mujhe laga current nahi" ✗)
//   not:[…]    — idiom/context exclusion tokens: any present → entry skipped
//                (कर्ज/सूरज + डूब; emails + not-responding; बिल + बिजली)
//   needNeg    — bleeding stop-verbs (बंद/रुक*/stop/ఆగడం…) only count WITH a
//                negation token: "खून बंद नहीं हो रहा" = RED, "khoon band ho
//                gaya" (bleeding HAS stopped) = no fire
//   needCo:[…] — weak symptom needs a co-token: obstetric दर्द needs
//                severity/abdomen (kills "प्रेग्नेंट हूँ, पीठ में हल्का दर्द"
//                routine ANC; keeps GoI-B7 "severe abdominal pain")
//   notWith:[…]— symptom×site pair veto: दुख-forms never pair with दिल
//                ("दिल में दुख" = grief idiom, "छाती दुख रही" = symptom)
//   bookingDowngrade at entry level — साँस-फूल* (exertional, subacute per ATP
//                <12h criterion) demotes on checkup/test words without
//                demoting acute "saans nahi aa rahi" phrases
//
// Two tiers:
//   RED   = immediate-escalation criteria (IITT/ATP RED). In enforce mode
//           these route through the SAME handleEmergency path as v1.
//   AMBER = concerning-but-ambiguous (downgrade marker present, elicited
//           echo without affirmation, or an inherently-AMBER criterion).
//           AMBER always logs only — it NEVER escalates and it NEVER
//           suppresses (a hit is never silently dropped below AMBER).
//   Condition-name-only traffic (मिर्गी refill, शुगर कम/डाउन requests,
//   दवा+सूजन questions) is inherently-AMBER by design (FP-hunt families
//   C/E): naming a disease to a receptionist is admin traffic, not an event.
//   Third-person reports ("पापा बेहोश हो गए") are NEVER downgraded — there
//   is deliberately no third-person logic anywhere in this file. Proxy
//   calling is the dominant Indian mode for the worst emergencies; the
//   unconscious patient definitionally cannot dial (spec §2.6).
//
// Elicited-negative echo subtraction (spec §2.4, deterministic, no NLP):
//   If ctx.lastRituText is provided and EVERY token that triggered the match
//   also appears in Ritu's own last utterance, require an affirmation token
//   in the caller's reply to keep RED, else drop to AMBER (never null).
//   Fix round: (1) AFFIRM no longer contains the copulas hai/ho/ha/है-forms —
//   they made every romanized reply "affirm" (e06: "nahi nahi, saans aa rahi
//   hai" stayed RED). Cost: a bare Marathi "हो"-only confirm now demotes to
//   AMBER (logged, never lost) — the copula collision was ending real calls.
//   (2) The comparison now also runs in a script-agnostic FOLD space
//   (deterministic Devanagari→Latin skeleton, vowels dropped, repeats
//   collapsed) so a Devanagari question vs romanized reply (e12) no longer
//   silently disables the gate.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ─── 1. Canonicalization pipeline ────────────────────────────────────────────
// Reimplemented INSIDE v2 for purity (no require on callHandler).
// Provenance: identical mapping to callHandler.js toDevanagari() (line ~143,
// audit fix 2026-07-09): the nine Brahmic Unicode blocks share one
// 128-codepoint layout, so a per-block offset shift maps every Indic script
// onto Devanagari (क at +0x15 in every block). Lossy at script-specific
// letters — which is fine, because the LEXICON below is mined in each
// language's NATIVE script and pushed through this same pipeline at build
// time, so live-transcript output and entry output are always round-trip
// consistent (spec §2.3: "round-trip consistency, not phonetic identity").
const INDIC_BLOCKS = [0x0980, 0x0A00, 0x0A80, 0x0B00, 0x0B80, 0x0C00, 0x0C80, 0x0D00];

function toDevanagari(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    const block = INDIC_BLOCKS.find(b => c >= b && c < b + 0x80);
    out += block ? String.fromCodePoint(0x0900 + (c - block)) : ch;
  }
  // Same slot-mismatch folds as callHandler.toDevanagari: Dravidian short
  // e/o vowel signs land on Devanagari's rare short forms; Gurmukhi tippi
  // lands on the abbreviation-sign slot.
  return out
    .replace(/ॆ/g, 'े').replace(/ॊ/g, 'ो')
    .replace(/ऎ/g, 'ए').replace(/ऒ/g, 'ओ')
    .replace(/॰/g, 'ं');
}

// Normalize → canonical token string:
//  NFC, drop apostrophes (can't → cant), zero-width chars, transliterate,
//  strip everything that is not letter/mark/digit to spaces, lowercase Latin.
function canonicalize(text) {
  const nfc = String(text || '').normalize('NFC')
    .replace(/[''’ʼ]/g, '')
    .replace(/[​-‍﻿]/g, '');
  return toDevanagari(nfc)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim();
}

function tokenize(text) {
  const canon = canonicalize(text);
  return canon ? canon.split(/\s+/) : [];
}

const VIRAMA = /्/g;

// ─── 1b. Echo-fold: script-agnostic comparison space for the echo gate ──────
// Deterministic Devanagari→Latin skeleton used ONLY to decide the echo
// DEMOTION (RED→AMBER on a probable echo of Ritu's own words). Over-matching
// here can only demote to AMBER — never suppress, never escalate — so a lossy
// fold is safe by construction. सांस → "sns" == "saans"; दर्द → "drd" ==
// "dard"; नहीं → "nh" == "nahi"/"nahin".
const DEV2LAT = {};
(function buildDev2Lat() {
  const pairs = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
    'च': 'ch', 'छ': 'ch', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 's', 'ष': 's', 'स': 's',
    'ह': 'h', 'ळ': 'l', 'ऱ': 'r', 'ऴ': 'l',
    'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'r',
    'ए': 'e', 'ऐ': 'e', 'ओ': 'o', 'औ': 'o', 'ऍ': 'e', 'ऑ': 'o',
    'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'r',
    'े': 'e', 'ै': 'e', 'ो': 'o', 'ौ': 'o', 'ॅ': 'e', 'ॉ': 'o',
    'ं': 'n', 'ँ': 'n', 'ः': '', '्': '', '़': '', 'ऽ': ''
  };
  for (const [k, v] of Object.entries(pairs)) DEV2LAT[k] = v;
})();

function foldEcho(tok) {
  let s = '';
  for (const ch of String(tok)) s += (DEV2LAT[ch] !== undefined) ? DEV2LAT[ch] : ch;
  s = s.toLowerCase()
    .replace(/w/g, 'v').replace(/z/g, 'j').replace(/ph/g, 'f').replace(/q/g, 'k');
  const collapsed = s.replace(/(.)\1+/g, '$1');
  let sk = collapsed.replace(/[aeiou]/g, '');
  if (!sk) sk = collapsed;                       // vowel-only tokens: आ == aa
  if (sk.length >= 3 && sk.endsWith('n')) sk = sk.slice(0, -1); // nahin==nahi
  return sk || String(tok);
}

// ─── 2. Small closed token sets (canonical forms) ───────────────────────────

// Negation tokens — used by rules flagged negationDowngrade (RED→AMBER on a
// caller denial), by needNeg symptom entries (stop-verbs only count when
// negated), and by the booking-marker adjacency discount. A negation token
// NEVER suppresses. Rules whose phrasing is constitutively negative
// (breathing "saans NAHI aa rahi", stroke "kaam NAHI kar raha") must NOT set
// negationDowngrade — there the negation IS the emergency.
const NEGATION = new Set([
  'नहीं', 'नही', 'नथी',           // hi / gu નથી
  'नाही', 'नाहीये',               // mr
  'ना',                            // hi/bn না → ना (only dangerous alone; fine here)
  'इल्लै', 'लेदु', 'इल्ल',        // ta இல்லை / te లేదు / kn ಇಲ್ಲ, ml ഇല്ല
  'नेइ', 'नाहिँ',                 // bn নেই / od ନାହିଁ
  'nahi', 'nahin', 'nai', 'no', 'not'
].map(canonicalize));

// Affirmation tokens for the echo gate (spec §2.6 answer-parse sets).
// FIX (FP-hunt e06): the Hinglish/Hindi copulas hai/ho/ha and Devanagari
// हो/हा are REMOVED — "nahi nahi, saans aa rahi hai" is a denial, but 'hai'
// made it "affirm" and kept the RED. Only unambiguous yes-words remain.
// Cost (accepted, fail-open direction): a confirm carried ONLY by a copula
// now demotes to AMBER instead of staying RED — logged, never dropped.
const AFFIRM = new Set([
  'हाँ', 'हां', 'जी', 'होय', 'हांजी', 'हाँजी', 'बिल्कुल', 'बिलकुल',
  'ஆமாம்', 'ஆமா', 'అవును', 'ಹೌದು', 'അതെ',      // ta / te / kn / ml
  'হ্যাঁ', 'হাঁ', 'હા', 'ਹਾਂ', 'ହଁ', 'ହଁା',       // bn / gu / pa / od
  'yes', 'yeah', 'haan', 'han', 'ji', 'bilkul', 'zaroor'
].map(canonicalize));

// Past-tense downgrade markers (spec §2.2 example set) — applied only by
// rules flagged pastDowngrade (pain-report rules where "दर्द हुआ था" is
// history). NOT applied to trauma/poisoning/etc where past morphology is the
// normal way to report a just-happened event ("accident ho gaya").
const PAST_MARKERS = new Set([
  'था', 'थी', 'थे', 'कल', 'पहले', 'परसों', 'झाला', 'होता',
  'yesterday', 'ago', 'earlier', 'kal', 'pehle', 'tha', 'thi'
].map(canonicalize));

// Chronic / recurring / multi-day duration markers (FP-hunt round-3 family F6).
// Applied ONLY by rules flagged chronicDowngrade (currently anaphylaxis): a
// throat swelling "दो दिन से" or an allergy "कभी कभी हो जाता है" is
// sub-acute traffic, not an anaphylaxis EVENT (which is minutes, sudden).
// Demote-only (RED→AMBER), never suppress. Deliberately NOT on breathing/
// bleeding — a multi-day breathlessness can still be an emergency.
const CHRONIC_MARKERS = new Set([
  'दिन', 'दिनों', 'हफ्ते', 'हफ़्ते', 'हफ्ता', 'महीने', 'महीना', 'साल',
  'कभी', 'अक्सर', 'अकसर', 'रहता', 'रहती', 'रहते', 'हमेशा', 'रोज', 'रोज़',
  'days', 'week', 'weeks', 'month', 'months', 'always', 'usually',
  'sometimes', 'often', 'kabhi', 'aksar', 'hamesha', 'roz'
].map(canonicalize));

// Booking-context downgrade markers (benign lookalikes: "seene ka X-ray
// karana hai") — demote one tier, never suppress (ESSENCE-style exclusions).
// FIX (FP-hunt family B/C): Devanagari/Dravidian test vocab + blood-draw
// causatives added — the frozen benign set's "खून की जांच", "blood test book
// karna hai", "रक्त तपासणी", "రక్త పరీక్ష" all carry these markers.
const BOOKING_MARKERS = new Set([
  'एक्सरे', 'एक्स', 'रिपोर्ट', 'अपॉइंटमेंट', 'चेकअप', 'जांच', 'जाँच',
  'टेस्ट', 'रूटीन', 'तपासणी', 'चाचणी',                       // hi / mr
  'निकलवाना', 'निकलवानी', 'निकलवाने',                        // blood-draw causatives
  'ਟੈਸਟ', 'ટેસ્ટ', 'পরীক্ষা', 'ପରୀକ୍ଷା',                    // pa / gu / bn / od
  'పరీక్ష', 'ಪರೀಕ್ಷೆ', 'பரிசோதனை', 'ടെസ്റ്റ്',                // te / kn / ta / ml
  'xray', 'ecg', 'scan', 'report', 'appointment', 'checkup', 'test',
  'book', 'booking', 'routine', 'nikalwana', 'nikalwani'
].map(canonicalize));

// ─── 3. The criterion lexicon ───────────────────────────────────────────────
// Term syntax: a phrase is an array of terms; ALL terms must be present
// within the phrase's token-span window (see §4 defaults). '*' = prefix stem
// (≥3 canonical chars, asserted at build). '|' = alternation (explicit
// inflection list). Entries are written in each language's NATIVE script and
// canonicalized at build time through the SAME pipeline as live transcripts.
//
// Rule flags:  negationDowngrade / pastDowngrade / bookingDowngrade — marker
// downgrades (demote RED→AMBER, never suppress);  pairWindow — site↔symptom
// max token distance (default 4).
// Entry flags: w / ordered / not / needNeg / needCo / notWith /
// bookingDowngrade — documented in the header.
const RULES = [
  {
    category: 'cardiac', tier: 'RED',
    source: 'IITT-A "acute chest pain"; ATP "acute chest pain <24h" (S4 §1 row 13)',
    negationDowngrade: true, pastDowngrade: true, bookingDowngrade: true,
    pairWindow: 4,
    standalone: [
      { lang: 'hi', p: ['हार्ट', 'अटैक'] },
      // w:2 — "दिल का दौरा" (span 2) fires; "दिल के डॉक्टर का दौरा" (a
      // cardiologist's village VISIT, span 4) does not (FP-hunt A).
      { lang: 'hi', p: ['दिल', 'दौरा'], w: 2 },
      { lang: 'en', p: ['heart', 'attack'] }, { lang: 'en', p: ['cardiac', 'arrest'] },
      { lang: 'hing', p: ['dil', 'daura'], w: 2 },
      { lang: 'ta', p: ['மாரடைப்பு*'] }, { lang: 'te', p: ['గుండెపోటు*'] },
      { lang: 'kn', p: ['ಹೃದಯಾಘಾತ*'] }, { lang: 'ml', p: ['ഹൃദയാഘാതം'] },
      { lang: 'bn', p: ['হার্ট', 'অ্যাটাক'] }, { lang: 'gu', p: ['હાર્ટ', 'એટેક'] },
      { lang: 'pa', p: ['ਹਾਰਟ', 'ਅਟੈਕ'] }, { lang: 'pa', p: ['ਦਿਲ', 'ਦੌਰਾ'], w: 2 },
      { lang: 'od', p: ['ହାର୍ଟ', 'ଆଟାକ'] }, { lang: 'od', p: ['ହୃଦଘାତ*'] }
    ],
    sites: [
      { lang: 'hi', t: 'छाती*' }, { lang: 'hi', t: 'सीने' }, { lang: 'hi', t: 'सीना' },
      // दिल carries idiom vetoes (FP-hunt F8): "दिल घबरा रहा है" (anxiety),
      // "दिल टूट गया" (heartbreak), "दिल बैठ गया" (dread) are not chest pain —
      // there the दर्द belongs to another body part (पेट). सीने/छाती are unambiguous.
      { lang: 'hi', t: 'दिल', not: ['घबरा', 'घबराहट', 'घबराती', 'घबराया', 'टूट', 'टूटा', 'टूटी', 'बैठ', 'बैठा', 'बैठी'] },
      { lang: 'hi', t: 'हृदय*' },
      { lang: 'en', t: 'chest' }, { lang: 'hing', t: 'seene' }, { lang: 'hing', t: 'seena' },
      // ಎದೆ/గుండె veto the "is-NOT" copula (FP-hunt F8): "గుండె డాక్టర్ కాదు /
      // ಎದೆ ಡಾಕ್ಟರ್ ಅಲ್ಲ" = "not the HEART doctor" (a specialty mention) — the
      // pain is in the leg. A real "గుండె నొప్పి, డాక్టర్ కావాలి" has no కాదు.
      { lang: 'kn', t: 'ಎದೆ*', not: ['ಅಲ್ಲ'] }, { lang: 'ta', t: 'மார்ப*' },
      { lang: 'te', t: 'ఛాతీ*' }, { lang: 'te', t: 'గుండె*', not: ['కాదు'] },
      { lang: 'bn', t: 'বুকে' }, { lang: 'bn', t: 'বুকের' },
      { lang: 'gu', t: 'છાતી*' }, { lang: 'pa', t: 'ਛਾਤੀ*' },
      { lang: 'ml', t: 'നെഞ്ച*' }, { lang: 'od', t: 'ଛାତି*' }
    ],
    symptoms: [
      { lang: 'hi', t: 'दर्द' },
      // दुख: explicit present-tense forms only, and NEVER paired with दिल —
      // "आपने मेरा दिल दुखा दिया" is hurt FEELINGS (FP-hunt A). "छाती दुख
      // रही है" (physical) keeps firing.
      { lang: 'hi', t: 'दुख|दुखता|दुखती|दुखते', notWith: ['दिल'] },
      { lang: 'hi', t: 'जकड़न' },
      { lang: 'hi', t: 'भारीपन' }, { lang: 'hi', t: 'दबाव' },
      { lang: 'en', t: 'pain' }, { lang: 'en', t: 'hurts' }, { lang: 'en', t: 'hurting' },
      { lang: 'en', t: 'tightness' }, { lang: 'en', t: 'pressure' }, { lang: 'en', t: 'heaviness' },
      { lang: 'en', t: 'crushing' }, { lang: 'en', t: 'squeezing' },
      { lang: 'hing', t: 'dard' }, { lang: 'hing', t: 'jakdan' },
      { lang: 'kn', t: 'ನೋವ*' }, { lang: 'ta', t: 'வலி*' }, { lang: 'te', t: 'నొప్పి*' },
      { lang: 'bn', t: 'ব্যথা*' }, { lang: 'gu', t: 'દુખાવ*' }, { lang: 'pa', t: 'ਦਰਦ' },
      { lang: 'ml', t: 'വേദന*' }, { lang: 'od', t: 'ଯନ୍ତ୍ରଣ*' },
      { lang: 'mr', t: 'दुखत*', notWith: ['दिल'] }
    ]
  },
  {
    category: 'breathing', tier: 'RED',
    source: 'IITT-R "inability to talk unaided"; ATP acute SOB <12h (S4 §1 row 2)',
    standalone: [
      // adj:[[1,2]] — नहीं must be adjacent to आ/ले (it negates the breath).
      // "साँस नहीं आ रही" fires; "नहीं नहीं, साँस आ रही है" (a denial with नहीं
      // far from आ) does not (FP-hunt F1 — also fixes the echo holes e4/e5/e7).
      // w:2 (all three tokens within a 2-span) + adj[[1,2]]: the frozen
      // testset's saans red-flags are consecutive ("साँस नहीं आ"). Together
      // these reject the cross-comma denial "साँस की दिक्कत नहीं, आ रही है" —
      // where नहीं negates दिक्कत and lands next to a later आ (fresh-attack).
      { lang: 'hi', p: ['सांस', 'नहीं', 'आ'], adj: [[1, 2]], w: 2 }, { lang: 'hi', p: ['साँस', 'नहीं', 'आ'], adj: [[1, 2]], w: 2 },
      { lang: 'hi', p: ['सांस', 'रुक*'] }, { lang: 'hi', p: ['साँस', 'रुक*'] },
      { lang: 'hi', p: ['सांस', 'नहीं', 'ले'], adj: [[1, 2]], w: 2 }, { lang: 'hi', p: ['साँस', 'नहीं', 'ले'], adj: [[1, 2]], w: 2 },
      // dam-ghut: "kamre mein dam ghutta hai, AC nahi" is stuffy-room smalltalk.
      { lang: 'hi', p: ['दम', 'घुट*'], not: ['कमरे', 'कमरा', 'कमरें', 'गर्मी', 'गरमी', 'एसी', 'ऐसी', 'पंखा'] },
      // साँस-फूल* is the one subacute pattern in this rule (exertional
      // breathlessness, not ATP <12h) — entry-level bookingDowngrade demotes
      // "seedhi chadhne par saans phool jaati hai, checkup karana hai"
      // (FP-hunt E) without touching the acute nahi-aa phrases.
      { lang: 'hi', p: ['सांस', 'फूल*'], bookingDowngrade: true },
      { lang: 'hi', p: ['साँस', 'फूल*'], bookingDowngrade: true },
      { lang: 'hing', p: ['saans', 'nahi', 'aa'], adj: [[1, 2]], w: 2 }, { lang: 'hing', p: ['saans', 'nahi', 'rahi'], adj: [[1, 2]], w: 2 },
      { lang: 'hing', p: ['saans', 'ruk*'] },
      { lang: 'hing', p: ['dam', 'ghut*'], not: ['kamre', 'kamra', 'kamare', 'garmi', 'garmii', 'ac', 'pankha'] },
      { lang: 'hing', p: ['saans', 'phool*'], bookingDowngrade: true },
      { lang: 'en', p: ['cannot', 'breathe'] }, { lang: 'en', p: ['cant', 'breathe'] },
      { lang: 'en', p: ['can', 'not', 'breathe'] }, { lang: 'en', p: ['unable', 'breathe'] },
      { lang: 'en', p: ['not', 'breathing'] }, { lang: 'en', p: ['stopped', 'breathing'] },
      { lang: 'en', p: ['gasping'] }, { lang: 'en', p: ['struggling', 'breathe'] },
      { lang: 'mr', p: ['श्वास', 'येत', 'नाही*'] }, { lang: 'mr', p: ['दम', 'कोंड*'] },
      { lang: 'mr', p: ['धाप', 'लाग*'] },
      { lang: 'kn', p: ['ಉಸಿರಾಡ*', 'ಆಗುತ್ತಿಲ್ಲ'] }, { lang: 'kn', p: ['ಉಸಿರು', 'ಕಟ್ಟ*'] },
      { lang: 'kn', p: ['ಉಸಿರು', 'ಸಿಗ*'] },
      { lang: 'ta', p: ['மூச்சு', 'முடியவில்லை'] }, { lang: 'ta', p: ['மூச்சு', 'திணற*'] },
      { lang: 'ta', p: ['சுவாசிக்க', 'முடியவில்லை'] },
      { lang: 'te', p: ['ఊపిరి', 'లేదు'] }, { lang: 'te', p: ['శ్వాస', 'లేదు'] },
      { lang: 'bn', p: ['শ্বাস', 'নিতে', 'পারছ*'] },
      // গরম exclusion: "দম বন্ধ করা গরম" is suffocating-HEAT smalltalk.
      { lang: 'bn', p: ['দম', 'বন্ধ'], not: ['গরম'] },
      { lang: 'bn', p: ['নিঃশ্বাস', 'বন্ধ'] },
      { lang: 'gu', p: ['શ્વાસ', 'નથી'] }, { lang: 'gu', p: ['શ્વાસ', 'તકલીફ'] },
      { lang: 'gu', p: ['દમ', 'ઘૂંટ*'] },
      { lang: 'pa', p: ['ਸਾਹ', 'ਨਹੀਂ'] }, { lang: 'pa', p: ['ਸਾਹ', 'ਰੁਕ*'] },
      { lang: 'pa', p: ['ਦਮ', 'ਘੁੱਟ*'] },
      { lang: 'ml', p: ['ശ്വാസം', 'കിട്ടുന്നില്ല'] }, { lang: 'ml', p: ['ശ്വാസംമുട്ട*'] },
      { lang: 'ml', p: ['ശ്വാസം', 'മുട്ട*'] },
      { lang: 'od', p: ['ନିଶ୍ୱାସ*', 'ପାରୁନ*'] }, { lang: 'od', p: ['ନିଶ୍ୱାସ*', 'ବନ୍ଦ'] },
      { lang: 'od', p: ['ଦମ', 'ବନ୍ଦ'] }
    ]
  },
  {
    category: 'unconscious', tier: 'RED',
    source: 'IITT-A/P "unresponsive" (S4 §1 row 1)',
    standalone: [
      { lang: 'hi', p: ['बेहोश*'] }, { lang: 'hi', p: ['होश', 'नहीं'] },
      { lang: 'hing', p: ['behosh*'] }, { lang: 'hing', p: ['hosh', 'nahi'] },
      { lang: 'en', p: ['unconscious'] }, { lang: 'en', p: ['fainted'] },
      // college/exam exclusion: Indian English "passed out of college" =
      // graduated. email/call exclusion: "doctor is not responding to my
      // emails" is a service complaint (FP-hunt D).
      { lang: 'en', p: ['passed', 'out'], not: ['college', 'school', 'university', 'exam', 'exams'] },
      { lang: 'en', p: ['collapsed'] },
      {
        lang: 'en', p: ['not', 'responding'],
        not: ['email', 'emails', 'mail', 'mails', 'message', 'messages', 'msg',
              'call', 'calls', 'phone', 'whatsapp', 'reply', 'replying']
      },
      { lang: 'en', p: ['wont', 'wake'] },
      { lang: 'en', p: ['not', 'waking'] },
      { lang: 'mr', p: ['बेशुद्ध*'] }, { lang: 'mr', p: ['शुद्ध', 'हरपल*'] },
      { lang: 'kn', p: ['ಪ್ರಜ್ಞೆ', 'ತಪ್ಪ*'] }, { lang: 'kn', p: ['ಮೂರ್ಛೆ*'] },
      { lang: 'ta', p: ['மயங்கி', 'விழுந்*'] }, { lang: 'ta', p: ['சுயநினைவு', 'இல்லை'] },
      { lang: 'te', p: ['స్పృహ', 'తప్ప*'] }, { lang: 'te', p: ['స్పృహ', 'లేదు'] },
      { lang: 'te', p: ['మూర్ఛ*'] },
      { lang: 'bn', p: ['অজ্ঞান*'] }, { lang: 'bn', p: ['জ্ঞান', 'নেই'] },
      { lang: 'gu', p: ['બેભાન*'] }, { lang: 'gu', p: ['ભાન', 'નથી'] },
      { lang: 'pa', p: ['ਬੇਹੋਸ਼*'] }, { lang: 'pa', p: ['ਹੋਸ਼', 'ਨਹੀਂ'] },
      { lang: 'ml', p: ['ബോധം', 'ഇല്ല'] }, { lang: 'ml', p: ['ബോധം', 'കെട്ട*'] },
      { lang: 'ml', p: ['ബോധം', 'പോയി'] }, { lang: 'ml', p: ['ബോധക്ഷയം'] },
      { lang: 'od', p: ['ଅଚେତ*'] }, { lang: 'od', p: ['ଚେତା', 'ନାହିଁ'] }
    ]
  },
  {
    category: 'bleeding', tier: 'RED',
    source: 'IITT-A heavy bleeding; ATP active bleeding incl. hematemesis (S4 §1 row 5)',
    bookingDowngrade: true,
    pairWindow: 4,
    standalone: [
      { lang: 'en', p: ['heavy', 'bleeding'] }, { lang: 'en', p: ['severe', 'bleeding'] },
      // "bleeding stop" alone matched RESOLVED states ("bleeding stop ho gayi
      // hai" — FP-hunt B). Now the not-stopping form requires the negation.
      { lang: 'en', p: ['bleeding', 'not', 'stop*'] },
      { lang: 'hing', p: ['bleeding', 'stop', 'nahi'] },
      { lang: 'en', p: ['bleeding', 'wont'] },
      { lang: 'en', p: ['lot', 'blood'] }, { lang: 'en', p: ['pouring', 'blood'] },
      { lang: 'hi', p: ['खून', 'उल्टी'] }, { lang: 'hi', p: ['खून', 'उलटी'] },
      { lang: 'hing', p: ['khoon', 'ulti'] }, { lang: 'en', p: ['vomiting', 'blood'] },
      { lang: 'en', p: ['blood', 'vomit*'] }
    ],
    sites: [
      { lang: 'hi', t: 'खून' }, { lang: 'hi', t: 'ख़ून' }, { lang: 'hi', t: 'रक्त*' },
      { lang: 'hing', t: 'khoon' }, { lang: 'hing', t: 'khun' }, { lang: 'en', t: 'blood' },
      { lang: 'kn', t: 'ರಕ್ತ*' }, { lang: 'ta', t: 'ரத்த*' }, { lang: 'ta', t: 'இரத்த*' },
      { lang: 'te', t: 'రక్త*' }, { lang: 'bn', t: 'রক্ত*' }, { lang: 'gu', t: 'લોહી*' },
      { lang: 'pa', t: 'ਖੂਨ' }, { lang: 'ml', t: 'രക്ത*' }, { lang: 'od', t: 'ରକ୍ତ*' }
    ],
    // FIX (FP-hunt B, systematic): bare intensifiers (बहुत/bahut/खूप/చాలా/
    // ತುಂಬಾ/অনেক/બહુ/ഒരുപാട്) are GONE from this list — "blood group AB
    // negative hai, bahut rare" and every "रक्त तपासणी खूप…" booking fired on
    // blood-word + intensifier. Flow verbs carry the criterion alone;
    // stop-verbs carry it only when negated (needNeg).
    symptoms: [
      // बह is EXACT + explicit inflections (a 2-char stem would swallow बहुत/बहन).
      { lang: 'hi', t: 'बह|बहा|बही|बहे' },
      { lang: 'hi', t: 'रुक*', needNeg: true },
      { lang: 'hi', t: 'बंद', needNeg: true },
      // निकल: acute forms only. निकलवाना = blood-DRAW causative. Habitual
      // निकलता/निकलती REMOVED (FP-hunt F3): gums-on-brushing, piles, summer
      // nosebleeds, menorrhagia are chronic complaints — the acute progressive
      // "खून निकल रहा है" still fires on the bare निकल token.
      { lang: 'hi', t: 'निकल|निकला|निकली|निकले' },
      { lang: 'hing', t: 'beh|behta' },
      { lang: 'hing', t: 'nikal|nikla' },
      { lang: 'hing', t: 'ruk*', needNeg: true },
      { lang: 'hing', t: 'band', needNeg: true },
      { lang: 'en', t: 'stop', needNeg: true }, { lang: 'en', t: 'stopping', needNeg: true },
      { lang: 'en', t: 'pouring' },
      { lang: 'mr', t: 'वाहत*' }, { lang: 'mr', t: 'थांबत*', needNeg: true },
      { lang: 'kn', t: 'ಸೋರ*' }, { lang: 'kn', t: 'ನಿಲ್ಲುತ್ತಿಲ್ಲ' },
      { lang: 'kn', t: 'ನಿಲ್ಲ*', needNeg: true },
      { lang: 'ta', t: 'நிற்காம*' }, { lang: 'ta', t: 'வழி*' }, { lang: 'ta', t: 'கொட்டு*' },
      { lang: 'te', t: 'ఆగడం', needNeg: true }, { lang: 'te', t: 'ఆగటం', needNeg: true },
      { lang: 'te', t: 'కారుతోంది' },
      { lang: 'bn', t: 'পড়ছ*' }, { lang: 'bn', t: 'ঝরছ*' }, { lang: 'bn', t: 'বন্ধ', needNeg: true },
      { lang: 'gu', t: 'વહી' }, { lang: 'gu', t: 'વહે*' }, { lang: 'gu', t: 'બંધ', needNeg: true },
      { lang: 'pa', t: 'ਵਗ|ਵਗਦਾ|ਵਗਿਆ' },
      { lang: 'pa', t: 'ਵਹਿ*' }, { lang: 'pa', t: 'ਰੁਕ*', needNeg: true },
      { lang: 'ml', t: 'നിൽക്കുന്നില്ല' }, { lang: 'ml', t: 'ഒഴുക*' },
      { lang: 'od', t: 'ବହୁଛ*' }, { lang: 'od', t: 'ଝରୁଛି' }, { lang: 'od', t: 'ବନ୍ଦ', needNeg: true }
    ]
  },
  {
    category: 'stroke', tier: 'RED',
    source: 'ATP suspected stroke <24h, limb weakness <24h; FAST lay forms (S4 §1 row 14)',
    standalone: [
      // FIX (FP-hunt D): the side-not-working family now requires "one"
      // (एक/ek/ఒక/એક/ਇੱਕ/ଗୋଟିଏ) or a limb word alongside तरफ — "आपकी तरफ से
      // काम नहीं हुआ" (paperwork complaint) has neither.
      { lang: 'hi', p: ['एक', 'तरफ', 'काम', 'नहीं'] },
      { lang: 'hi', p: ['तरफ', 'हाथ', 'काम', 'नहीं'] },
      { lang: 'hi', p: ['तरफ', 'पैर', 'काम', 'नहीं'] },
      { lang: 'hi', p: ['मुँह', 'टेढ़ा'] },
      { lang: 'hi', p: ['मुंह', 'टेढ़ा'] }, { lang: 'hi', p: ['लकवा*'] },
      { lang: 'hi', p: ['पक्षाघात*'] },
      { lang: 'hing', p: ['ek', 'taraf', 'kaam', 'nahi'] },
      { lang: 'hing', p: ['taraf', 'haath', 'kaam', 'nahi'] },
      { lang: 'hing', p: ['taraf', 'hath', 'kaam', 'nahi'] },
      { lang: 'hing', p: ['lakwa*'] },
      { lang: 'hing', p: ['munh', 'tedha'] },
      { lang: 'en', p: ['face', 'drooping'] }, { lang: 'en', p: ['slurred', 'speech'] },
      { lang: 'en', p: ['speech', 'slurred'] }, { lang: 'en', p: ['one', 'side', 'weak'] },
      { lang: 'en', p: ['one', 'side', 'numb'] }, { lang: 'en', p: ['stroke'] },
      { lang: 'mr', p: ['बाजू*', 'लुळ*'] }, { lang: 'mr', p: ['अंग', 'लुळ*'] },
      { lang: 'mr', p: ['लुळ*', 'पडल*'] },
      { lang: 'kn', p: ['ಕಡೆ', 'ಆಡುತ್ತಿಲ್ಲ'] }, { lang: 'kn', p: ['ಕೈ', 'ಕಾಲು', 'ಆಡುತ್ತಿಲ್ಲ'] },
      { lang: 'kn', p: ['ಪಾರ್ಶ್ವವಾಯು*'] },
      { lang: 'ta', p: ['பக்கம்', 'செயலிழ*'] }, { lang: 'ta', p: ['பக்கவாதம்*'] },
      { lang: 'ta', p: ['கை', 'கால்', 'செயலிழ*'] },
      { lang: 'te', p: ['ఒక', 'వైపు', 'పని', 'లేదు'] }, { lang: 'te', p: ['పక్షవాతం*'] },
      { lang: 'bn', p: ['দিকের', 'অবশ'] }, { lang: 'bn', p: ['অবশ', 'হাত'] },
      { lang: 'bn', p: ['পক্ষাঘাত*'] },
      { lang: 'gu', p: ['એક', 'બાજુ', 'કામ', 'નથી'] },
      { lang: 'gu', p: ['બાજુ', 'હાથ', 'કામ', 'નથી'] }, { lang: 'gu', p: ['લકવ*'] },
      { lang: 'pa', p: ['ਇੱਕ', 'ਪਾਸੇ', 'ਕੰਮ', 'ਨਹੀਂ'] },
      { lang: 'pa', p: ['ਪਾਸੇ', 'ਹੱਥ', 'ਕੰਮ', 'ਨਹੀਂ'] }, { lang: 'pa', p: ['ਲਕਵਾ*'] },
      { lang: 'ml', p: ['വശം', 'തളർ*'] }, { lang: 'ml', p: ['പക്ഷാഘാതം*'] },
      { lang: 'od', p: ['ଗୋଟିଏ', 'ପଟ', 'କାମ', 'କରୁନ*'] },
      { lang: 'od', p: ['ହାତ', 'ଗୋଡ', 'କରୁନ*'] },
      { lang: 'od', p: ['ପକ୍ଷାଘାତ*'] }
    ]
  },
  {
    category: 'seizure', tier: 'RED',
    source: 'IITT-A/P active convulsions (S4 §1 row 6)',
    // pastDowngrade (FP-hunt F5): "दौरा पड़ा था कल" (had a seizure yesterday) is
    // history → AMBER. The EVENT-now phrasing has no past marker → stays RED.
    pastDowngrade: true,
    standalone: [
      // पड़: acute inflections only. Habitual पड़ता/पड़ते REMOVED (FP-hunt F5):
      // "मिर्गी के दौरे पड़ते हैं, refill चाहिए" is chronic-epilepsy admin — it
      // now falls to the inherently-AMBER मिर्गी rule. "दौरा पड़ा/पड़ रहा है"
      // (acute) stays RED. (पड़ोस stayed excluded by the explicit-list trick.)
      { lang: 'hi', p: ['दौरा', 'पड़|पड़ा|पड़ी|पड़े|पड़ने'] },
      { lang: 'hi', p: ['दौरे', 'पड़|पड़े'] },
      { lang: 'hi', p: ['झटके', 'आ'] }, { lang: 'hi', p: ['झटके', 'रहे'] },
      { lang: 'hing', p: ['daura', 'pad|pada|padne'] },
      { lang: 'hing', p: ['jhatke', 'aa'] },
      { lang: 'en', p: ['seizure*'] }, { lang: 'en', p: ['convulsion*'] },
      { lang: 'mr', p: ['झटके', 'येत*'] }, { lang: 'mr', p: ['फेफर*'] },
      { lang: 'mr', p: ['आकडी*'] },
      { lang: 'kn', p: ['ಫಿಟ್ಸ್*'] }, { lang: 'ta', p: ['வலிப்பு*'] },
      { lang: 'te', p: ['ఫిట్స్*'] }, { lang: 'bn', p: ['খিঁচুনি*'] },
      { lang: 'gu', p: ['આંચકી*'] }, { lang: 'gu', p: ['ખેંચ', 'આવે'] },
      { lang: 'pa', p: ['ਦੌਰਾ', 'ਪੈ'] }, { lang: 'pa', p: ['ਦੌਰਾ', 'ਪਿਆ'] }, { lang: 'ml', p: ['അപസ്മാരം*'] },
      { lang: 'ml', p: ['ഫിറ്റ്സ്*'] }, { lang: 'od', p: ['ଫିଟ୍ସ*'] },
      { lang: 'od', p: ['ବାତ', 'ମାଡ଼*'] }
    ]
  },
  {
    category: 'poisoning', tier: 'RED',
    source: 'IITT-R ingestion "should initially be up-triaged to Red" (S4 §1 row 10)',
    standalone: [
      { lang: 'hi', p: ['ज़हर'] }, { lang: 'hi', p: ['जहर'] },
      { lang: 'hi', p: ['गोलियां', 'खा'] }, { lang: 'hi', p: ['गोलियाँ', 'खा'] },
      { lang: 'hi', p: ['गोलियां', 'खाई'] }, { lang: 'hi', p: ['गोलियाँ', 'खाई'] },
      { lang: 'hing', p: ['zeher'] }, { lang: 'hing', p: ['zehar'] },
      { lang: 'en', p: ['poison*'] }, { lang: 'en', p: ['overdose'] },
      // mr विष is EXACT, never a stem — the stem would swallow विषय ("topic").
      { lang: 'mr', p: ['विष'] }, { lang: 'mr', p: ['विष', 'प्याय*'] },
      { lang: 'kn', p: ['ವಿಷ'] }, { lang: 'ta', p: ['விஷம்'] },
      { lang: 'te', p: ['విషం'] }, { lang: 'bn', p: ['বিষ'] },
      { lang: 'gu', p: ['ઝેર'] }, { lang: 'pa', p: ['ਜ਼ਹਿਰ'] },
      { lang: 'ml', p: ['വിഷം'] }, { lang: 'od', p: ['ବିଷ'] }
    ]
  },
  {
    category: 'selfharm', tier: 'RED',
    source: 'S4 §1 row 24 (Garcia v. Character Technologies duty of care); routes to helpline path',
    standalone: [
      // जान-देना: बूझ kills "जान बूझ कर" (deliberately); span-3 kills the "जान
      // है तो जहान है" proverb. FP-hunt F7 adds the DEDICATION-idiom vetoes:
      // लगा/laga (effort: "इस काम में जान लगा दूंगा"), and के-लिए/liye + काम
      // ("बच्चे के लिए जान दे दूंगी" = sacrifice-for-someone, not ideation).
      { lang: 'hi', p: ['जान', 'देना|देने|दूंगा|दूंगी'], not: ['बूझ', 'बूझकर', 'लगा', 'लगाना', 'लिए', 'काम', 'मेहनत'] },
      { lang: 'hi', p: ['मरना', 'चाहता'] }, { lang: 'hi', p: ['मरना', 'चाहती'] },
      // जीना-नहीं REQUIRES a चाह-form: "जीना नहीं चाहता" = suicidal ideation;
      // "घुटने की वजह से जीना नहीं चढ़ पाता" = a STAIRCASE (जीना homonym, the
      // worst FP of the hunt — a knee patient routed to the self-harm path).
      { lang: 'hi', p: ['जीना', 'नहीं', 'चाह*'] },
      { lang: 'hi', p: ['आत्महत्या*'] }, { lang: 'hi', p: ['खुदकुशी*'] },
      { lang: 'hi', p: ['ख़ुदकुशी*'] }, { lang: 'hi', p: ['सुसाइड*'] },
      { lang: 'hing', p: ['jaan', 'dena|dene|dunga|dungi'], not: ['boojh', 'bujh', 'laga', 'lagana', 'lagaunga', 'kaam', 'mehnat', 'liye'] },
      { lang: 'hing', p: ['jeena', 'nahi', 'chah*'] }, { lang: 'hing', p: ['jina', 'nahi', 'chah*'] },
      { lang: 'hing', p: ['marna', 'chahta'] }, { lang: 'hing', p: ['khudkushi*'] },
      // PASSIVE IDEATION (2026-08-29). The entries above all name an ACT; the
      // commonest real presentation names an ABSENCE of wanting to live —
      // measured missed by both detectors on the enforced category. जीने-the-
      // staircase is excluded by requiring मन/इच्छा/बेकार alongside.
      { lang: 'hi', p: ['जीने', 'मन', 'नहीं'], w: 3 }, { lang: 'hi', p: ['जीने', 'इच्छा', 'नहीं'], w: 3 },
      { lang: 'hi', p: ['जीना', 'बेकार'] }, { lang: 'hi', p: ['खुद', 'खत्म|ख़त्म'], w: 2 },
      { lang: 'hi', p: ['अपनी', 'जान', 'ले|लूंगा|लूंगी|लेना'], w: 2 },
      { lang: 'hi', p: ['मर', 'जाऊं|जाऊँ|जाऊ', 'अच्छा|ठीक|बेहतर'], w: 3 },
      { lang: 'hing', p: ['jeene', 'man', 'nahi'], w: 3 }, { lang: 'hing', p: ['jeene', 'ichha|iccha', 'nahi'], w: 3 },
      { lang: 'hing', p: ['jeena', 'bekar|bekaar'] }, { lang: 'hing', p: ['khud', 'khatam|khatm'], w: 2 },
      { lang: 'hing', p: ['apni', 'jaan', 'le|lunga|lungi|lena'], w: 2 }, { lang: 'hing', p: ['mar', 'jaun|jau', 'accha|acha|theek|behtar'], w: 3 },
      { lang: 'hing', p: ['do', 'not', 'want', 'to', 'live'] }, { lang: 'hing', p: ['dont', 'want', 'to', 'live'] },
      { lang: 'hing', p: ['better', 'off', 'dead'] },
      { lang: 'hing', p: ['no', 'point', 'living'] }, { lang: 'hing', p: ['nothing', 'to', 'live', 'for'] },
      { lang: 'mr', p: ['जगावंसं|जगावसं', 'वाटत', 'नाही'], w: 2 }, { lang: 'mr', p: ['जगायची', 'इच्छा', 'नाही'], w: 2 },
      { lang: 'mr', p: ['मरून', 'जावंसं|जावसं'] }, { lang: 'mr', p: ['संपवून', 'टाक*'], w: 2 },
      { lang: 'kn', p: ['ಬದುಕೋಕೆ|ಬದುಕಲು', 'ಇಷ್ಟ', 'ಇಲ್ಲ'], w: 2 }, { lang: 'kn', p: ['ಸಾಯಬೇಕು|ಸಾಯೋಕೆ'] }, { lang: 'kn', p: ['ಆತ್ಮಹತ್ಯೆ*'] },
      { lang: 'hing', p: ['aatmahatya*'] },
      // Tamil / Telugu / Malayalam passive ideation (2026-09-03) — absent until today.
      { lang: 'ta', p: ['வாழ', 'ஆசை|விருப்பம்', 'இல்லை'], w: 3 }, { lang: 'ta', p: ['வாழ', 'விரும்பவில்லை'], w: 2 }, { lang: 'ta', p: ['சாகணும்|சாக'] }, { lang: 'ta', p: ['தற்கொலை*'] },
      { lang: 'te', p: ['బతకాలని', 'లేదు'], w: 2 }, { lang: 'te', p: ['బతకడం', 'ఇష్టం', 'లేదు'], w: 3 }, { lang: 'te', p: ['చనిపోవాలని'] }, { lang: 'te', p: ['ఆత్మహత్య*'] },
      { lang: 'ml', p: ['ജീവിക്കാൻ', 'താൽപ്പര്യമില്ല|താല്പര്യമില്ല|ഇഷ്ടമില്ല'], w: 2 }, { lang: 'ml', p: ['ജീവിക്കണ്ട'] }, { lang: 'ml', p: ['മരിക്കണം'] }, { lang: 'ml', p: ['മരിച്ചാൽ', 'മതി'], w: 2 }, { lang: 'ml', p: ['ആത്മഹത്യ*'] },
      { lang: 'en', p: ['kill', 'myself'] },
      // default span 3: "end my life" fires; "end of the day … my life
      // schedule" (span 5, FP-hunt D) does not.
      { lang: 'en', p: ['end', 'life'] },
      { lang: 'en', p: ['want', 'die'] }, { lang: 'en', p: ['suicid*'] },
      { lang: 'en', p: ['harm', 'myself'] },
      { lang: 'mr', p: ['जगायच*', 'नाही*'] }, { lang: 'mr', p: ['जगायच*', 'नको*'] },
      { lang: 'kn', p: ['ಸಾಯಬೇಕು'] }, { lang: 'kn', p: ['ಸಾಯ*', 'ಅನಿಸ*'] },
      { lang: 'kn', p: ['ಆತ್ಮಹತ್ಯೆ*'] },
      { lang: 'ta', p: ['சாக', 'விரும்*'] }, { lang: 'ta', p: ['தற்கொலை*'] },
      { lang: 'te', p: ['చనిపోవాల*'] }, { lang: 'te', p: ['ఆత్మహత్య*'] },
      { lang: 'bn', p: ['বাঁচতে', 'চাই', 'না'] }, { lang: 'bn', p: ['আত্মহত্যা*'] },
      { lang: 'bn', p: ['মরতে', 'চাই'] },
      { lang: 'gu', p: ['જીવવું', 'નથી'] }, { lang: 'gu', p: ['આપઘાત*'] },
      { lang: 'pa', p: ['ਜੀਣਾ', 'ਨਹੀਂ'] }, { lang: 'pa', p: ['ਖੁਦਕੁਸ਼ੀ*'] },
      { lang: 'pa', p: ['ਮਰਨਾ', 'ਚਾਹੁੰਦਾ'] },
      { lang: 'ml', p: ['ജീവിക്കണ്ട'] }, { lang: 'ml', p: ['ആത്മഹത്യ*'] },
      { lang: 'od', p: ['ବଞ୍ଚିବାକୁ', 'ଚାହୁଁନ*'] }, { lang: 'od', p: ['ଆତ୍ମହତ୍ୟା*'] },
      { lang: 'od', p: ['ମରିବାକୁ', 'ଚାହ*'] }
    ]
  },
  {
    category: 'snakebite', tier: 'RED',
    source: 'IITT-A + IITT-P + ATP all explicit; ~58k deaths/yr — v1 dead zone #1 (S4 §1 row 11)',
    standalone: [
      { lang: 'hi', p: ['सांप', 'काट*'] }, { lang: 'hi', p: ['साँप', 'काट*'] },
      { lang: 'hi', p: ['सांप', 'डस'] }, { lang: 'hi', p: ['साँप', 'डस'] },
      { lang: 'hi', p: ['सांप', 'डसा'] }, { lang: 'hi', p: ['साँप', 'डसा'] },
      { lang: 'hi', p: ['सर्पदंश*'] }, { lang: 'hi', p: ['बिच्छू*'] },
      { lang: 'hing', p: ['saap', 'kat*'] }, { lang: 'hing', p: ['saanp', 'kat*'] },
      { lang: 'hing', p: ['saap', 'das*'] }, { lang: 'hing', p: ['bichhu*'] },
      { lang: 'en', p: ['snake', 'bit*'] }, { lang: 'en', p: ['snakebite'] },
      { lang: 'en', p: ['scorpion'] },
      { lang: 'mr', p: ['साप', 'चाव*'] }, { lang: 'mr', p: ['विंचू*'] },
      { lang: 'kn', p: ['ಹಾವು', 'ಕಚ್ಚ*'] }, { lang: 'kn', p: ['ಚೇಳು*'] },
      { lang: 'ta', p: ['பாம்பு', 'கடி*'] }, { lang: 'ta', p: ['தேள்*'] },
      { lang: 'te', p: ['పాము', 'కరి*'] }, { lang: 'te', p: ['పాము', 'కాట*'] },
      { lang: 'te', p: ['తేలు*'] },
      { lang: 'bn', p: ['সাপ*', 'কামড়*'] },
      { lang: 'gu', p: ['સાપ', 'કરડ*'] }, { lang: 'gu', p: ['વીંછી*'] },
      { lang: 'pa', p: ['ਸੱਪ', 'ਡੰਗ*'] }, { lang: 'pa', p: ['ਸੱਪ', 'ਵੱਢ*'] },
      { lang: 'pa', p: ['ਸੱਪ', 'ਲੜਿਆ'] },
      { lang: 'ml', p: ['പാമ്പ്', 'കടി*'] },
      { lang: 'od', p: ['ସାପ', 'କାମୁଡ଼*'] }, { lang: 'od', p: ['ବିଛା*'] }
    ]
  },
  {
    category: 'obstetric', tier: 'RED',
    source: 'GoI-B7 + IITT-A pregnancy block: pregnant + bleeding/seizure/severe pain; absent fetal movements (S4 §1 row 20 — v1 dead zone #2)',
    // FIX (FP-hunt C): bookingDowngrade — "pregnant hoon, blood test book
    // karna hai" / "गर्भवती हूँ appointment चाहिए खून की जांच के लिए" are
    // routine ANC lab traffic → AMBER (one-question tier), never RED.
    // pairWindow 8: pregnancy disclosure and the danger sign are naturally
    // far apart ("मैं गर्भवती हूँ और मुझे सुबह से खून आ रहा है").
    bookingDowngrade: true,
    pairWindow: 8,
    standalone: [
      // w:3 — genuine "बच्चा हिल नहीं रहा" spans ≤3; the hyperactive-kid
      // inversion "बच्चा एक जगह टिकता नहीं, बहुत हिलता है" spans 6 (FP-hunt C).
      { lang: 'hi', p: ['बच्चा', 'हिल*', 'नहीं'], w: 3 },
      { lang: 'hing', p: ['baccha', 'hil*', 'nahi'], w: 3 },
      { lang: 'hing', p: ['bacha', 'hil*', 'nahi'], w: 3 },
      { lang: 'en', p: ['baby', 'not', 'moving'] },
      { lang: 'mr', p: ['बाळ', 'हालचाल', 'नाही'] }, { lang: 'mr', p: ['बाळ', 'हलत', 'नाही'] }
    ],
    sites: [
      { lang: 'hi', t: 'गर्भवती*' }, { lang: 'hi', t: 'प्रेग्नेंट*' }, { lang: 'hi', t: 'प्रेगनेंट*' },
      { lang: 'en', t: 'pregnant' }, { lang: 'en', t: 'pregnancy' },
      { lang: 'mr', t: 'गरोदर*' }, { lang: 'kn', t: 'ಗರ್ಭಿಣಿ*' }, { lang: 'ta', t: 'கர்ப்பிணி*' },
      { lang: 'te', t: 'గర్భిణి*' }, { lang: 'bn', t: 'গর্ভবতী*' }, { lang: 'gu', t: 'ગર્ભવતી*' },
      { lang: 'pa', t: 'ਗਰਭਵਤੀ*' }, { lang: 'ml', t: 'ഗർഭിണി*' }, { lang: 'od', t: 'ଗର୍ଭବତୀ*' }
    ],
    symptoms: [
      // खून/रक्त/blood need an ACTIVE-FLOW co-token (FP-hunt F4): "गर्भवती हूँ
      // और खून की कमी है, iron चाहिए" is ANEMIA (low blood), not bleeding — it
      // has no flow word. "खून आ रहा है" / "खून बह रहा है" (bleeding) fire.
      // ('bleeding' below is itself the active verb, so it carries no needCo.)
      { lang: 'hi', t: 'खून', needCo: ['बह', 'बहा', 'बही', 'निकल', 'निकला', 'आ', 'रहा', 'रही', 'जा', 'जारी', 'धब्बे', 'ज़्यादा', 'ज्यादा'] },
      { lang: 'hi', t: 'ख़ून', needCo: ['बह', 'बहा', 'बही', 'निकल', 'निकला', 'आ', 'रहा', 'रही', 'जा', 'जारी', 'धब्बे', 'ज़्यादा', 'ज्यादा'] },
      { lang: 'hi', t: 'रक्त*', needCo: ['बह', 'बहा', 'बही', 'निकल', 'निकला', 'आ', 'रहा', 'रही', 'जा', 'जारी', 'स्राव'] },
      { lang: 'hing', t: 'khoon', needCo: ['beh', 'behta', 'nikal', 'nikla', 'aa', 'raha', 'rahi', 'ja', 'zyada', 'jyada', 'spotting'] },
      { lang: 'en', t: 'blood', needCo: ['coming', 'flowing', 'lot', 'heavy', 'spotting', 'passing', 'bahut', 'aa', 'raha'] },
      { lang: 'en', t: 'bleeding' },
      { lang: 'hi', t: 'झटके' }, { lang: 'hi', t: 'दौरा' }, { lang: 'hi', t: 'दौरे' },
      { lang: 'en', t: 'seizure*' }, { lang: 'en', t: 'fits' },
      // GoI-B7 REDs SEVERE abdominal pain — bare दर्द swept in "पीठ में हल्का
      // दर्द रहता है" backache (FP-hunt C). needCo: severity or abdomen word.
      { lang: 'hi', t: 'दर्द', needCo: ['तेज़', 'तेज', 'बहुत', 'ज़्यादा', 'ज्यादा', 'पेट', 'असहनीय'] },
      { lang: 'hing', t: 'dard', needCo: ['tez', 'bahut', 'zyada', 'jyada', 'pet'] },
      { lang: 'en', t: 'pain', needCo: ['severe', 'unbearable', 'stomach', 'abdomen', 'abdominal', 'bahut', 'tez'] },
      { lang: 'hi', t: 'बेहोश*' }, { lang: 'gu', t: 'લોહી*' }, { lang: 'mr', t: 'रक्तस्राव*' }
    ]
  },
  {
    category: 'pediatric_fever', tier: 'RED',
    source: 'IITT-P: lethargic WITH fever = RED; <2mo + fever = RED (S4 §1 row 21)',
    standalone: [
      { lang: 'hi', p: ['बुखार', 'सुस्त*'], w: 5 }, { lang: 'hi', p: ['बुखार', 'उठ', 'नहीं'] },
      { lang: 'hi', p: ['नवजात*', 'बुखार'], w: 5 }, { lang: 'hi', p: ['बुखार', 'जाग', 'नहीं'] },
      // IITT-P "unable to drink/breastfeed" is an INFANT criterion — बच्च*
      // required. "मैं दूध नहीं पी सकता, lactose intolerance" (adult, FP-hunt
      // E) no longer fires.
      // not नखरे/vitamin (FP-hunt F8): "बच्चा दूध नहीं पीता, नखरे करता है,
      // vitamin बता दो" is a FUSSY-TODDLER feeding complaint, not the infant
      // "unable to feed" red flag. A newborn (नवजात) has no such veto.
      { lang: 'hi', p: ['बच्च*', 'दूध', 'नहीं'], not: ['नखरे', 'नखरा', 'नखरें', 'विटामिन', 'vitamin', 'जिद', 'ज़िद'] },
      { lang: 'hi', p: ['नवजात*', 'दूध', 'नहीं'] },
      { lang: 'hing', p: ['bachch*', 'doodh', 'nahi'], not: ['nakhre', 'nakhra', 'vitamin', 'zid', 'jid'] },
      { lang: 'hing', p: ['bukhar', 'sust*'], w: 5 }, { lang: 'hing', p: ['bukhar', 'uth', 'nahi'] },
      { lang: 'en', p: ['fever', 'lethargic'], w: 5 }, { lang: 'en', p: ['fever', 'not', 'waking'] },
      { lang: 'en', p: ['newborn', 'fever'], w: 5 }
    ]
  },
  {
    // Fever-without-lethargy is deliberately AMBER: IITT-P REDs fever only
    // with a second criterion (age <2mo is unknowable from one utterance).
    category: 'pediatric_fever', tier: 'AMBER',
    source: 'IITT-P high fever in a child — concerning, one-question tier (S4 §2.6)',
    standalone: [
      { lang: 'hi', p: ['बच्च*', 'तेज़', 'बुखार'] }, { lang: 'hi', p: ['बच्च*', 'तेज', 'बुखार'] },
      { lang: 'hing', p: ['bachch*', 'tez', 'bukhar'] }, { lang: 'hing', p: ['tez', 'bukhar'] },
      { lang: 'hi', p: ['तेज़', 'बुखार'] }, { lang: 'hi', p: ['तेज', 'बुखार'] },
      { lang: 'en', p: ['high', 'fever'] }
    ]
  },
  {
    category: 'anaphylaxis', tier: 'RED',
    source: 'ATP anaphylaxis; IITT-A stridor/angioedema of face (S4 §1 rows 3+12)',
    // Downgrades (FP-hunt E + F6): booking ("ENT appointment"), chronic/duration
    // ("गले में सूजन दो दिन से" = tonsillitis, "allergic reaction होता है कभी
    // कभी" = chronic allergy), and past ("गला सूज गया कल से"). Anaphylaxis is
    // sudden/minutes — any multi-day or recurring framing → AMBER. The acute
    // "अचानक गला सूज गया, साँस नहीं आ रही" carries none of these → stays RED.
    bookingDowngrade: true,
    chronicDowngrade: true,
    pastDowngrade: true,
    standalone: [
      { lang: 'hi', p: ['गला', 'सूज*'] },
      { lang: 'hi', p: ['गले', 'सूज*'] }, { lang: 'hi', p: ['जीभ', 'सूज*'] },
      { lang: 'hi', p: ['होंठ', 'सूज*'] },
      { lang: 'hing', p: ['gala', 'sooj*'] },
      { lang: 'en', p: ['throat', 'swelling'] }, { lang: 'en', p: ['throat', 'swollen'] },
      { lang: 'en', p: ['tongue', 'swelling'] }, { lang: 'en', p: ['tongue', 'swollen'] },
      { lang: 'en', p: ['allergic', 'reaction'] }, { lang: 'en', p: ['injection', 'reaction'] },
      { lang: 'en', p: ['anaphyla*'] }
    ]
  },
  {
    category: 'drowning_hanging_electrocution', tier: 'RED',
    // NOTE: a hanging report must fire 108 (this path), not only the
    // self-harm helpline — ATP lists hanging as time-sensitive RED. The
    // dual-path follow-up is escalation-UX work (spec T11), not detection.
    source: 'ATP time-sensitive: drowning / hanging / electrocution, all three named (S4 §1 row 15)',
    standalone: [
      // डूब exclusions (FP-hunt D idioms): कर्ज में डूबना = debt, सूरज डूबना
      // = sunset, सोच/नींद में डूबना = absorbed/asleep.
      { lang: 'hi', p: ['डूब', 'गया'], not: ['कर्ज', 'कर्जा', 'कर्जे', 'सूरज', 'सोच', 'नींद', 'पैसे', 'पैसा', 'पैसों', 'फीस', 'रुपये', 'रकम'] },
      { lang: 'hi', p: ['डूब', 'गयी'], not: ['कर्ज', 'कर्जा', 'कर्जे', 'सूरज', 'सोच', 'नींद', 'पैसे', 'पैसा', 'पैसों', 'फीस', 'रुपये', 'रकम'] },
      { lang: 'hi', p: ['डूब', 'गए'], not: ['कर्ज', 'कर्जा', 'कर्जे', 'सूरज', 'सोच', 'नींद', 'पैसे', 'पैसा', 'पैसों', 'फीस', 'रुपये', 'रकम'] },
      { lang: 'hi', p: ['डूब', 'गई'], not: ['कर्ज', 'कर्जा', 'कर्जे', 'सूरज', 'सोच', 'नींद', 'पैसे', 'पैसा', 'पैसों', 'फीस', 'रुपये', 'रकम'] },
      { lang: 'hi', p: ['डूब', 'रहा'], not: ['कर्ज', 'कर्जा', 'कर्जे', 'सूरज', 'सोच', 'नींद', 'पैसे', 'पैसा', 'पैसों', 'फीस', 'रुपये', 'रकम'] },
      { lang: 'hi', p: ['डूब', 'रही'], not: ['कर्ज', 'कर्जा', 'कर्जे', 'सूरज', 'सोच', 'नींद', 'पैसे', 'पैसा', 'पैसों', 'फीस', 'रुपये', 'रकम'] },
      { lang: 'hing', p: ['doob', 'gaya'], not: ['karz', 'karza', 'karze', 'sooraj', 'suraj', 'paise', 'paisa', 'fees', 'rupaye', 'rupya'] },
      { lang: 'hing', p: ['doob', 'gayi'], not: ['karz', 'karza', 'karze', 'sooraj', 'suraj', 'paise', 'paisa', 'fees', 'rupaye', 'rupya'] },
      { lang: 'hing', p: ['doob', 'raha'], not: ['karz', 'karza', 'karze', 'sooraj', 'suraj', 'paise', 'paisa', 'fees', 'rupaye', 'rupya'] },
      { lang: 'hing', p: ['doob', 'rahi'], not: ['karz', 'karza', 'karze', 'sooraj', 'suraj', 'paise', 'paisa', 'fees', 'rupaye', 'rupya'] },
      { lang: 'en', p: ['drowning'] }, { lang: 'en', p: ['drowned'] },
      { lang: 'hi', p: ['फांसी*'] }, { lang: 'hi', p: ['फ़ांसी*'] }, { lang: 'hi', p: ['फंदा*'] },
      { lang: 'hing', p: ['phansi*'] }, { lang: 'hing', p: ['phanda*'] },
      { lang: 'en', p: ['hanged'] },
      // ordered — "current laga" is a shock report; "mujhe laga current nahi
      // hai" (power-cut smalltalk, FP-hunt D) has laga BEFORE current.
      // बिल/bill exclusion: "बिजली का बिल … लगा" (electricity bill).
      { lang: 'hi', p: ['करंट', 'लगा'], ordered: true }, { lang: 'hi', p: ['करंट', 'लगी'], ordered: true },
      { lang: 'hi', p: ['करेंट', 'लगा'], ordered: true }, { lang: 'hi', p: ['करेंट', 'लगी'], ordered: true },
      { lang: 'hi', p: ['बिजली', 'झटका'], not: ['बिल'] },
      { lang: 'hi', p: ['बिजली', 'लगा'], w: 2, ordered: true, not: ['बिल'] },
      { lang: 'hi', p: ['बिजली', 'लगी'], w: 2, ordered: true, not: ['बिल'] },
      { lang: 'hing', p: ['current', 'laga'], ordered: true, not: ['bill'] },
      { lang: 'hing', p: ['current', 'lagi'], ordered: true, not: ['bill'] },
      { lang: 'hing', p: ['current', 'lag'], ordered: true, not: ['bill'] },
      { lang: 'hing', p: ['bijli', 'laga'], w: 2, ordered: true, not: ['bill'] },
      { lang: 'hing', p: ['bijli', 'lagi'], w: 2, ordered: true, not: ['bill'] },
      { lang: 'en', p: ['electric', 'shock'] }, { lang: 'en', p: ['electrocut*'] }
    ]
  },
  {
    category: 'hypoglycemia', tier: 'RED',
    source: 'IITT-A hypoglycaemia RED (S4 §1 row 8)',
    pastDowngrade: true,
    standalone: [
      // Only the EVENT forms stay RED ("शुगर गिर गया"). The शुगर लो/कम/डाउन
      // family is condition-management talk → AMBER rule below (FP-hunt E:
      // "शुगर कम करने के उपाय बताइए" is the most common diabetic request).
      { lang: 'hi', p: ['शुगर', 'गिर*'], w: 2 },
      { lang: 'hing', p: ['sugar', 'gir*'], w: 2 },
      { lang: 'en', p: ['hypoglyc*'] }
    ]
  },
  {
    category: 'burns', tier: 'RED',
    source: 'IITT-R: ANY burn to face/neck, ANY burn age <2 — "baccha jal gaya" must fire without severity words (S4 §1 row 18)',
    standalone: [
      // जल is EXACT + inflections — the stem would fire inside जलेबी/जलन.
      // Food exclusions: "खाना जल गया, बच्चा भूखा है" is a burnt DINNER.
      { lang: 'hi', p: ['बच्च*', 'जल|जला|जली|जले'], w: 5, not: ['खाना', 'रोटी', 'सब्जी', 'दाल'] },
      { lang: 'hi', p: ['चेहरा', 'जल|जला'] },
      { lang: 'hi', p: ['गर्दन', 'जल|जली'] },
      { lang: 'hing', p: ['bachch*', 'jal|jala|jali'], w: 5, not: ['khana', 'roti', 'sabzi', 'daal'] },
      { lang: 'hing', p: ['baccha|bacha', 'jal|jala|jali'], w: 5, not: ['khana', 'roti', 'sabzi', 'daal'] },
      { lang: 'hing', p: ['chehra', 'jal|jala'] },
      { lang: 'en', p: ['face', 'burnt'] }, { lang: 'en', p: ['neck', 'burnt'] },
      { lang: 'en', p: ['child', 'burnt'] }, { lang: 'en', p: ['baby', 'burnt'] }
    ]
  },
  {
    // Burn event without site/age/severity qualifiers — concerning, not
    // auto-RED (adult limb burn is IITT YELLOW). v1 already REDs "bahut jal".
    category: 'burns', tier: 'AMBER',
    source: 'IITT-R burn below RED thresholds → AMBER confirm tier (S4 §2.6)',
    standalone: [
      { lang: 'hi', p: ['जल', 'गया'] }, { lang: 'hi', p: ['जल', 'गयी'] },
      { lang: 'hi', p: ['जल', 'गए'] }, { lang: 'hi', p: ['जल', 'गई'] },
      { lang: 'hing', p: ['jal', 'gaya'] }, { lang: 'hing', p: ['jal', 'gayi'] },
      { lang: 'hing', p: ['jal', 'gaye'] },
      { lang: 'mr', p: ['भाजल*'] }
    ]
  },
  {
    category: 'headache_thunderclap', tier: 'RED',
    source: 'ATP sudden severe (thunderclap) headache; IITT-A meningitis any-two (S4 §1 rows 7+16)',
    pastDowngrade: true,
    standalone: [
      { lang: 'hi', p: ['अचानक', 'सिर', 'दर्द'] }, { lang: 'hi', p: ['गर्दन', 'अकड़*', 'बुखार'] },
      { lang: 'hing', p: ['achanak', 'sir', 'dard'] },
      { lang: 'en', p: ['worst', 'headache'] }, { lang: 'en', p: ['sudden', 'severe', 'headache'] },
      { lang: 'en', p: ['stiff', 'neck', 'fever'] }
    ]
  },
  {
    category: 'headache_severe', tier: 'AMBER',
    source: 'Severe-headache report without thunderclap qualifier → confirm tier (S4 §2.6)',
    pastDowngrade: true,
    standalone: [
      { lang: 'hi', p: ['सिर', 'फट'] }, { lang: 'hi', p: ['सिर', 'फटा'] }, { lang: 'hi', p: ['तेज़', 'सिर', 'दर्द'] },
      { lang: 'hi', p: ['तेज', 'सिर', 'दर्द'] },
      { lang: 'hing', p: ['sir', 'phat'] }, { lang: 'en', p: ['severe', 'headache'] }
    ]
  },
  // ── Inherently-AMBER condition-management rules (FP-hunt families C/E) ────
  // Naming a chronic condition to a receptionist is admin traffic (refill,
  // diet advice, side-effect question). AMBER = logged, one-question tier,
  // never escalates. The corresponding EVENT phrasings stay RED above
  // (मिर्गी का दौरा पड़ा → seizure RED via दौरा-पड़; शुगर गिर गया → RED).
  {
    category: 'seizure', tier: 'AMBER',
    source: 'Condition-name-only (epilepsy) — refill/admin traffic → confirm tier (FP-hunt E)',
    standalone: [
      { lang: 'hi', p: ['मिर्गी*'] }, { lang: 'hing', p: ['mirgi*'] },
      { lang: 'en', p: ['epilep*'] }
    ]
  },
  {
    category: 'hypoglycemia', tier: 'AMBER',
    source: 'Sugar low/kam/down — dominant phrasing is diabetes MANAGEMENT ("शुगर कम करने के उपाय") → confirm tier (FP-hunt E)',
    standalone: [
      { lang: 'hi', p: ['शुगर', 'लो'] }, { lang: 'hi', p: ['शुगर', 'कम'] },
      { lang: 'hi', p: ['शुगर', 'डाउन'] },
      { lang: 'hing', p: ['sugar', 'low'] }, { lang: 'hing', p: ['sugar', 'down'] },
      { lang: 'hing', p: ['sugar', 'kam'] }
    ]
  },
  {
    category: 'anaphylaxis', tier: 'AMBER',
    source: 'दवा+सूजन/reaction — mostly side-effect questions & resolved states ("दवा से सूजन कम हो गयी") → confirm tier (FP-hunt E)',
    standalone: [
      { lang: 'hi', p: ['दवा*', 'सूज*'] }, { lang: 'hi', p: ['दवा*', 'रिएक्शन*'] },
      { lang: 'hing', p: ['dawa*', 'sooj*'] }, { lang: 'hing', p: ['dawa*', 'sujan'] },
      { lang: 'hing', p: ['dawa*', 'reaction'] }
    ]
  }
];

// ─── 4. Build-time compilation ──────────────────────────────────────────────
// Every term is pushed through the SAME canonicalize() as live input. A term
// variant whose canonical form contains a virama also gets a virama-stripped
// shadow form (matching v1's probe.replace(/्/g,'') trick) — but ONLY when
// the stripped form is ≥5 chars, so a short stripped form like விஷம்→विषम (4)
// cannot collide with an unrelated Hindi word (विषम "odd").
const STRIP_MIN = 5;
const PHRASE_GAP = 3;        // default max gap contribution per extra term
const PAIR_WINDOW_DEFAULT = 4; // default site↔symptom token distance

function compileTerm(raw, where) {
  const variants = raw.split('|').map(v => {
    const stem = v.endsWith('*');
    const s = canonicalize(stem ? v.slice(0, -1) : v);
    if (!s) throw new Error(`emergencyDetectorV2: empty canonical term "${v}" in ${where}`);
    if (stem && [...s].length < 3) {
      throw new Error(`emergencyDetectorV2: stem "${v}" (${where}) canonicalizes to <3 chars — word-boundary unsafe`);
    }
    const stripped = s.replace(VIRAMA, '');
    const ss = (stripped !== s && [...stripped].length >= STRIP_MIN) ? stripped : null;
    return { s, stem, ss };
  });
  return { raw, variants };
}

function compileTokenList(list, where) {
  return (list || []).map(t => {
    const c = canonicalize(t);
    if (!c || /\s/.test(c)) throw new Error(`emergencyDetectorV2: bad guard token "${t}" in ${where}`);
    return c;
  });
}

const COMPILED = RULES.map((rule, ri) => ({
  category: rule.category,
  tier: rule.tier,
  source: rule.source,
  negationDowngrade: !!rule.negationDowngrade,
  pastDowngrade: !!rule.pastDowngrade,
  chronicDowngrade: !!rule.chronicDowngrade,
  bookingDowngrade: !!rule.bookingDowngrade,
  pairWindow: rule.pairWindow != null ? rule.pairWindow : PAIR_WINDOW_DEFAULT,
  standalone: (rule.standalone || []).map(e => ({
    lang: e.lang,
    src: e.p.join(' '),
    terms: e.p.map(t => compileTerm(t, `${rule.category}#${ri}`)),
    w: e.w != null ? e.w : (e.p.length - 1) * PHRASE_GAP,
    ordered: !!e.ordered,
    // adj: [[i,j],…] — the two term-indices must land within 1 token of each
    // other. "साँस न␣हीं आ" needs नहीं adjacent to आ (negates the breath);
    // "नहीं nahi, साँस आ रही" (a denial) has नहीं far from आ (FP-hunt F1).
    adj: (e.adj || []).map(pair => pair.slice()),
    not: compileTokenList(e.not, `${rule.category}#${ri}/not`),
    bookingDowngrade: !!e.bookingDowngrade
  })),
  sites: (rule.sites || []).map(e => ({
    lang: e.lang, src: e.t, term: compileTerm(e.t, `${rule.category}#${ri}/site`),
    // Site-level exclusion + pair-window override (FP-hunt F8): दिल carries
    // not:['घबरा'…] (anxiety idiom "दिल घबरा रहा है" is not chest pain);
    // గుండె/ಎದೆ carry not:['కాదు'/'ಅಲ್ಲ'] ("గుండె డాక్టర్ కాదు" = a specialty
    // mention, the pain belongs to the leg).
    not: compileTokenList(e.not, `${rule.category}#${ri}/site-not`),
    pw: e.pw != null ? e.pw : null
  })),
  symptoms: (rule.symptoms || []).map(e => ({
    lang: e.lang, src: e.t,
    term: compileTerm(e.t, `${rule.category}#${ri}/symptom`),
    needNeg: !!e.needNeg,
    needCo: compileTokenList(e.needCo, `${rule.category}#${ri}/needCo`),
    notWith: compileTokenList(e.notWith, `${rule.category}#${ri}/notWith`)
  }))
}));

// ─── 5. Matching engine ─────────────────────────────────────────────────────
// Match surfaces per token position i, in order:
//   1. exact/stem on canonical tokens[i];
//   2. entry's virama-stripped shadow (ss, ≥5 chars) vs fully-stripped
//      tokens[i] (v1's probe.replace(/्/g,'') trick, length-gated);
//   3. TRAILING-virama-stripped tokens[i] — a Hindi phrase transcribed by a
//      pinned Dravidian STT session comes out with dead-consonant endings
//      (దర్ద్ → canonical दर्द्); trailing-strip recovers दर्द. Utterance-side
//      only, so entry விஷம் (विषम्) can never collide with Hindi विषम.
// All surfaces share the position index, so proximity windows stay exact.

function termPositions(term, surf) {
  const { tokens, strippedTokens, trailTokens } = surf;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const v of term.variants) {
      let hit;
      if (v.stem) {
        hit = tokens[i].startsWith(v.s)
          || (v.ss && strippedTokens[i].startsWith(v.ss))
          || trailTokens[i].startsWith(v.s);
      } else {
        hit = tokens[i] === v.s
          || (v.ss && strippedTokens[i] === v.ss)
          || trailTokens[i] === v.s;
      }
      // NO SCRIPT FOLD HERE, deliberately (tried 2026-08-29 and removed the same
      // day). English spoken into an Indic-pinned session — ಹಾರ್ಟ್ ಅಟ್ಯಾಕ್ —
      // is carried by emergencyDetector (v1) through a romanized probe, because
      // v1 owns the English/Hinglish vocabulary. This file's ASCII terms are
      // dil/daura/seene: folding them to consonant skeletons matched exactly one
      // term in the whole rule set ('bleeding') and, on 3,246 real utterances,
      // lit 25 false REDs — फंड (fund) and फंदा (noose) share the skeleton "fnd".
      if (hit) { out.push(i); break; }
    }
  }
  return out;
}

// Smallest assignment of one position per term satisfying the span budget
// (and order, if required). Position lists are tiny; DFS with pruning.
function phraseAssignment(posLists, maxSpan, ordered, adjPairs) {
  const n = posLists.length;
  let best = null;
  const adjOk = ch => !adjPairs || adjPairs.every(([a, b]) => Math.abs(ch[a] - ch[b]) <= 1);
  const rec = (k, chosen, lo, hi, prev) => {
    if (best) return;
    if (k === n) { if (adjOk(chosen)) best = chosen.slice(); return; }
    for (const p of posLists[k]) {
      if (ordered && p <= prev) continue;
      const nlo = Math.min(lo, p), nhi = Math.max(hi, p);
      if (nhi - nlo > maxSpan) continue;
      chosen.push(p);
      rec(k + 1, chosen, nlo, nhi, p);
      chosen.pop();
      if (best) return;
    }
  };
  rec(0, [], Infinity, -Infinity, -Infinity);
  return best;
}

function anySetToken(tokenSet, closedSet) {
  for (const t of tokenSet) if (closedSet.has(t)) return t;
  return null;
}

// Booking marker with negation-adjacency discount: "जांच नहीं, appointment
// नहीं" is a caller REFUSING routine care mid-emergency — an immediately
// adjacent negation cancels that marker (FP-hunt bonus FN).
function bookingPresent(surf) {
  const { tokens, trailTokens } = surf;
  const isNeg = i => i >= 0 && i < tokens.length
    && (NEGATION.has(tokens[i]) || NEGATION.has(trailTokens[i]));
  for (let i = 0; i < tokens.length; i++) {
    if (BOOKING_MARKERS.has(tokens[i]) || BOOKING_MARKERS.has(trailTokens[i])) {
      if (!isNeg(i - 1) && !isNeg(i + 1)) return true;
    }
  }
  return false;
}

/**
 * Detect an emergency in a transcript turn. Deterministic, proximity-
 * windowed, fail-open: a hit is only ever DOWNGRADED to AMBER, never
 * suppressed.
 *
 * @param {string} text — raw STT transcript (any of the 11 scripts / Latin)
 * @param {object} [ctx]
 * @param {string} [ctx.lastRituText] — Ritu's own previous utterance, for the
 *   elicited-negative echo gate (spec §2.4). Optional; omitting it simply
 *   disables the gate (spontaneous-turn behavior).
 * @returns {null | { tier: 'RED'|'AMBER', category: string,
 *                    matchedTerm: string, lang: string }}
 */
function detectEmergencyV2(text, ctx = {}) {
  if (!text || typeof text !== 'string') return null;
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const surf = {
    tokens,
    strippedTokens: tokens.map(t => t.replace(VIRAMA, '')),
    trailTokens: tokens.map(t => t.replace(/्+$/u, ''))
  };
  const tokenSet = new Set(tokens);
  for (const t of surf.trailTokens) tokenSet.add(t);

  // Ritu-echo token sets: exact canonical + virama-stripped + script-agnostic
  // fold (deterministic, no NLP — see foldEcho()).
  let rituSet = null, rituFold = null;
  if (ctx && typeof ctx.lastRituText === 'string' && ctx.lastRituText) {
    const rituTokens = tokenize(ctx.lastRituText);
    rituSet = new Set(rituTokens);
    rituFold = new Set();
    for (const t of rituTokens) {
      rituSet.add(t.replace(VIRAMA, ''));
      rituFold.add(foldEcho(t));
    }
  }

  const negPresent = !!anySetToken(tokenSet, NEGATION);
  const pastPresent = !!anySetToken(tokenSet, PAST_MARKERS);
  const chronicPresent = !!anySetToken(tokenSet, CHRONIC_MARKERS);
  const bookPresent = bookingPresent(surf);

  // Clause-scoped negation positions (FP-hunt F2): a needNeg stop-verb ("खून
  // बंद") counts ONLY when a negation sits within NEG_WINDOW tokens of it —
  // "खून बंद नहीं हो रहा" (RED) vs "खून बंद हो गया है, दर्द नहीं है" (a
  // resolved bleed + an unrelated denial two clauses away — must not fire).
  const NEG_WINDOW = 2;
  const negPositions = [];
  for (let i = 0; i < tokens.length; i++) {
    if (NEGATION.has(tokens[i]) || NEGATION.has(surf.trailTokens[i])) negPositions.push(i);
  }
  const negNear = b => negPositions.some(np => Math.abs(np - b) <= NEG_WINDOW);

  let amber = null;
  for (const rule of COMPILED) {
    let matchedTerm = null, lang = null, hitPositions = null, entryBooking = false;

    for (const entry of rule.standalone) {
      if (entry.not.length && entry.not.some(x => tokenSet.has(x))) continue;
      const posLists = entry.terms.map(t => termPositions(t, surf));
      if (posLists.some(l => l.length === 0)) continue;
      const pos = phraseAssignment(posLists, entry.w, entry.ordered, entry.adj.length ? entry.adj : null);
      if (pos) {
        matchedTerm = entry.src; lang = entry.lang; hitPositions = pos;
        entryBooking = entry.bookingDowngrade;
        break;
      }
    }

    if (!matchedTerm && rule.sites.length && rule.symptoms.length) {
      outer:
      for (const se of rule.sites) {
        // Site-level exclusion (FP-hunt F8): दिल+घबरा (anxiety), గుండె+కాదు.
        if (se.not.length && se.not.some(x => tokenSet.has(x))) continue;
        const sitePos = termPositions(se.term, surf);
        if (!sitePos.length) continue;
        const pw = se.pw != null ? se.pw : rule.pairWindow;
        for (const sy of rule.symptoms) {
          if (sy.needCo.length && !sy.needCo.some(x => tokenSet.has(x))) continue;
          if (sy.notWith.length && se.term.variants.some(v => sy.notWith.includes(v.s))) continue;
          const symPos = termPositions(sy.term, surf);
          if (!symPos.length) continue;
          for (const a of sitePos) {
            for (const b of symPos) {
              if (a !== b && Math.abs(a - b) <= pw) {
                // needNeg is clause-scoped: the negation must sit near the
                // symptom token itself, not anywhere in the utterance (F2).
                if (sy.needNeg && !negNear(b)) continue;
                matchedTerm = `${se.src}+${sy.src}`;
                lang = se.lang;
                hitPositions = [a, b];
                break outer;
              }
            }
          }
        }
      }
    }
    if (!matchedTerm) continue;

    let tier = rule.tier;
    // Deterministic downgrade markers (spec §2.2/§2.6) — demote, never drop.
    if (tier === 'RED') {
      if (rule.negationDowngrade && negPresent) tier = 'AMBER';
      else if (rule.pastDowngrade && pastPresent) tier = 'AMBER';
      else if (rule.chronicDowngrade && chronicPresent) tier = 'AMBER';
      else if ((rule.bookingDowngrade || entryBooking) && bookPresent) tier = 'AMBER';
    }
    // Elicited-negative echo gate (spec §2.4): if EVERY token that produced
    // this hit also appears in Ritu's own last utterance (exact, virama-
    // stripped, or cross-script fold), the caller may just be echoing Ritu's
    // screening question. Require an affirmation token to keep the tier;
    // otherwise AMBER. Never null — fail-open.
    if (tier === 'RED' && rituSet) {
      const hitToks = hitPositions.map(i => tokens[i]);
      const allEchoed = hitToks.every(t =>
        rituSet.has(t) || rituSet.has(t.replace(VIRAMA, '')) || rituFold.has(foldEcho(t)));
      if (allEchoed && !anySetToken(tokenSet, AFFIRM)) tier = 'AMBER';
    }

    const result = { tier, category: rule.category, matchedTerm, lang };
    if (tier === 'RED') return result;       // first RED wins
    if (!amber) amber = result;              // else remember first AMBER
  }
  return amber;
}

// Which v2 categories ESCALATE (as opposed to shadow-log). Read at call time,
// not frozen at require, so a flag change is live and a test can flip it
// in-process. EMERGENCY_V2=on still means "every category". Voice and WhatsApp
// both consume THIS; WhatsApp used to gate on EMERGENCY_V2=on alone, so the
// per-category setting recommended for production enforced nothing there.
function v2Enforces(category) {
  if (String(process.env.EMERGENCY_V2 || '').trim().toLowerCase() === 'on') return true;
  const set = String(process.env.EMERGENCY_V2_ENFORCE || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return set.includes(String(category || '').toLowerCase());
}

module.exports = {
  detectEmergencyV2,
  v2Enforces,
  // Introspection surface for the offline eval suite (read-only).
  RULES,
  _internals: { canonicalize, tokenize, toDevanagari, foldEcho, COMPILED }
};
