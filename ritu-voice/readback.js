// ═══════════════════════════════════════════════════════════════════════════
// CRITICAL-ENTITY READ-BACK (S2/S5) — confirm STT-captured meds before they
// reach the doctor's notes.
//
// The voice flow asks "koi dawai chal rahi hai?" and stores whatever the STT
// heard — but on an 8kHz line "Metformin" comes back "Metphormin". A confident
// wrong drug in a pre-visit summary is a safety event. So when the meds/allergy
// answer contains a recognizable medicine, Ritu reads it back once and takes a
// yes / no / correction. Measured payoff (S5 research): read-back catches
// 3.5–5% of capture errors and corrects 100% of them (Hippocratic 16.3→2.0%).
//
// Candidate source: plain Levenshtein against the NLEM-2022 generic list.
// (We MEASURED phonetic hashing here and it did NOT beat Levenshtein on this
// list — recall@3 ~100% with Levenshtein alone, so the gap is CONFIRMATION,
// not matching. See ritu-evals/data/phonetic-match-result.json.)
//
// SELF-LIQUIDATING GOLD LOOP (S5): a "yes" labels that (audio→drug) pair as
// verified gold for the training corpus; a "no/correction" replaces it. Either
// way the record improves — the loop pays for itself.
//
// Pure logic (only require is the static generic list). Deterministic.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { romanizeVariants, speculativeVariants, spellingVariants, hasIndic, toDevanagari } = require('./devanagari');

// EXPAND EVERY STOPLIST THROUGH THE AMBIGUITY TABLE.
//
// romanizeVariants emits SEVERAL spellings for one Devanagari word (व → v and
// w, स → s and c, फ → ph and f), and any one of them can become a candidate.
// So a word listed under one spelling stayed live under all the others. That
// is not hypothetical — it shipped twice:
//   2026-07-26  "वाली" was listed as "wali", fired as "vali", and confidently
//               resolved "Metamorphosin वाली दवाई" to Sucralfate.
//   2026-07-27  "दवा" was listed as "dava", fired as "dawa" → Domperidone,
//               282 times in the clinical corpus.
// The first fix added two words. It should have closed the class. Expanding
// the lists through the same generator that builds the candidates does close
// it: list a word once, and every spelling the matcher can produce is covered.
const expandSpellings = (words) => {
  const out = new Set();
  for (const w of words) for (const v of spellingVariants(w)) out.add(v);
  return out;
};

// ── INDIAN BRAND NAMES (Phase 2, measured) ─────────────────────────────────
// Indian patients say "Dolo", "Augmentin", "Pan D" — not "Paracetamol". On the
// Eka clinical corpus (814 gold drug mentions) Sarvam recognisably captured
// 44.2% of drug mentions while our 397-generic lexicon could resolve only
// 11.1%. This index — 116,492 brand heads → molecule, built by
// ritu-evals/tools/build-brand-index.js from a 253,973-row MIT dataset — is
// what closes that gap.
//
// MATCHED MUCH MORE STRICTLY THAN THE GENERIC LIST. 116k dense, short,
// invented-sounding names will collide with ordinary speech under the 0.34
// threshold the 397-generic list uses, and a false drug read-back is worse
// than no read-back. So: exact hit first, then fuzzy only inside a
// first-letter+length bucket at BRAND_MAX_DIST (0.15 ≈ one edit in seven
// characters). Buckets are built lazily on first fuzzy lookup so boot pays
// nothing.
const BRANDS = require('./drug_brands.json');
const BRAND_MAX_DIST = 0.15;
const BRAND_MIN_LEN = 5;      // shorter heads collide too easily to fuzzy-match
let _brandBuckets = null;
function _bucketKey(w) { return w[0] + ':' + w.length; }
function _ensureBrandBuckets() {
  if (_brandBuckets) return _brandBuckets;
  _brandBuckets = new Map();
  for (const b of Object.keys(BRANDS)) {
    if (b.length < BRAND_MIN_LEN) continue;
    const k = _bucketKey(b);
    let arr = _brandBuckets.get(k);
    if (!arr) { arr = []; _brandBuckets.set(k, arr); }
    arr.push(b);
  }
  return _brandBuckets;
}

// Brand heads that are ALSO ordinary Marathi/Hindi words or place names, MINED
// rather than guessed: every token in a 4,675-sentence general Marathi corpus
// (weather, trains, stock prices — zero medical content) was romanized and
// checked against the 116k brand index. Exactly 25 collided, and not one is a
// drug a patient would name aloud: bank, shri, atal, auto, next, zara, latur,
// tenali, piramal... Each was silently resolving to a real molecule — "latur"
// (a district) to Levocetirizine 53 times. A registered brand name is not
// evidence when the word is also everyday speech.
// 2026-08-06: axis, gems, maks added from the codemix FP corpus. All three are
// REAL registered Indian brands — that is exactly why they fire — but in Indian
// speech they are overwhelmingly ॲक्सिस बँक (Axis Bank, 3 of the 11 remaining
// firings), गेम्स (games) and मॅक्स (Max). Same shape as bank/latur/tenali/citi
// already here: a brand head that collides with a word people say constantly
// about something else.
const BRAND_BLOCKLIST = expandSpellings(["acel", "atal", "auto", "axis", "bank", "chek", "citi", "clik", "conati", "diva", "gems", "hazi", "janya", "kace", "latur", "link", "maks", "nain", "next", "opan", "pepar", "piramal", "plas", "ricet", "shri", "siti", "tenali", "turbo", "vest", "zara"]);

// findBrand(token) → { brand, generic, score } | null
function findBrand(token) {
  const q = String(token || '').toLowerCase();
  if (q.length < 4 || BRAND_BLOCKLIST.has(q)) return null;
  if (BRANDS[q]) return { brand: q, generic: BRANDS[q], score: 1 };
  if (q.length < BRAND_MIN_LEN) return null;
  const buckets = _ensureBrandBuckets();
  let best = null;
  for (const len of [q.length - 1, q.length, q.length + 1]) {
    const arr = buckets.get(q[0] + ':' + len);
    if (!arr) continue;
    for (const b of arr) {
      const d = lev(q, b) / Math.max(q.length, b.length);
      if (d <= BRAND_MAX_DIST && (!best || d < best.d)) best = { d, brand: b };
    }
  }
  return best ? { brand: best.brand, generic: BRANDS[best.brand], score: +(1 - best.d).toFixed(3) } : null;
}

// 1,751 molecules: the 349 usable NLEM generics MERGED with 1,673 harvested
// from the brand table's composition columns (NLEM wins on spelling — the
// read-back says these names out loud). Widening this list is not only about
// vocabulary: with just 397 targets, a real drug we did NOT know got fuzzy-
// matched onto the nearest one we DID. Measured on the clinical corpus:
// "ketoconazole" → Fluconazole, three times. Both antifungals, different drugs.
// A confident wrong molecule is the exact safety event this layer exists to
// prevent, so the fix is to make the true molecule available to win outright.
const GENERICS = require('./drug_generics.json');
// Specialty/body-part vocabulary, borrowed from the roster slicer so this file
// does not grow a second copy that drifts. See findUnresolvedMedToken.
const { specialtiesForSymptom } = require('./tools/symptomMapping.js');
const GEN_LC = GENERICS.map(t => ({ term: t, lc: t.toLowerCase() }));

// ─── LENGTH INDEX OVER THE GENERICS ─────────────────────────────────────────
// Both matchers scanned all 1,751 generics for EVERY candidate and applied the
// length prune INSIDE the loop — so a miss still paid 1,751 iterations plus a
// division each, per candidate, and a Devanagari sentence produces dozens of
// candidates. MEASURED on ordinary Marathi/Hindi containing no drug at all:
// 21.6ms per findDrugMention, and 44ms on sentences that name drugs. That is
// spent to conclude nothing, on the meds turn, inside the voice loop.
//
// The prune is a pure function of the two lengths, so it can be an INDEX
// instead of a test. |q - g| / max(q, g) <= th rearranges to
//     q*(1-th)  <=  g  <=  q/(1-th)
// which is a contiguous band of lengths. Bucket the generics by length once at
// load, then visit only that band. Same comparisons, same results — the lev()
// calls that survive the prune are identical, this only stops walking the ones
// that were always going to be skipped.
const GEN_BY_LEN = new Map();
for (const g of GEN_LC) {
  const arr = GEN_BY_LEN.get(g.lc.length);
  if (arr) arr.push(g); else GEN_BY_LEN.set(g.lc.length, [g]);
}
const GEN_MIN_LEN = Math.min(...GEN_BY_LEN.keys());
const GEN_MAX_LEN = Math.max(...GEN_BY_LEN.keys());

// Generics whose length can possibly sit within `th` of a q-length token.
// Yields buckets, not entries, so the caller keeps one flat inner loop.
function* genericsNear(qLen, th) {
  const lo = Math.max(GEN_MIN_LEN, Math.ceil(qLen * (1 - th)));
  const hi = Math.min(GEN_MAX_LEN, Math.floor(qLen / (1 - th)));
  for (let L = lo; L <= hi; L++) {
    const arr = GEN_BY_LEN.get(L);
    if (arr) yield arr;
  }
}

// PRECISION GUARD (measured on the same corpus): ordinary words were matching
// drugs at the 0.34 threshold — "vivaran" (विवरण, "description") → Etoricoxib
// 18 times, plus anti→Carbimazole, diabetes→Ambroxol, fever→Paracetamol,
// last→Latanoprost, complete→Methylcobalamin, diet→Cyproheptadine,
// human→Insulin, topical→Tretinoin, lipid→Atorvastatin. A false drug is worse
// than a missed one, so a candidate that IS an ordinary word never matches —
// however close it looks. Symptom words (fever, diabetes) are here too: naming
// a condition is not naming a medicine.
const NOT_A_DRUG = new Set([
  // ── WORDS THAT MEAN THE PATIENT *STOPPED* (added 2026-08-10) ──────────────
  // VERIFIED live: "I stopped taking Metformin last month" returned BOTH
  // Metformin AND stopped -> Stopper -> Dextromethorphan Hydrobromide, because
  // `stopped` fuzzy-matches a registered brand. So the very sentence that says
  // a drug was discontinued adds a cough suppressant to the record, and one
  // "हाँ" persists it.
  //
  // Same class as दवाई -> Dapagliflozin (f658e7a): an ordinary word every
  // patient says, landing on an exact-or-near key in the 116k brand index. The
  // difference is that these words are *evidence of absence* — they appear
  // precisely when a patient is telling us NOT to record something.
  'stopped', 'stopping', 'stopper', 'stoppd',
  // ── ORDINARY ENGLISH WORDS THAT ARE ALSO BRAND HEADS (added 2026-08-03) ────
  // The existing entries below were mined by romanizing a 4,675-sentence MARATHI
  // corpus and intersecting it with the 116k brand index. That corpus contains
  // ZERO Latin characters, so it caught the STT spellings "citi"/"siti" (see
  // BRAND_BLOCKLIST) and missed the word a person actually types: "city". The
  // method was sound; the corpus was blind — and s5.drug_false_positive inherits
  // exactly that blindness, which is why this whole class was invisible to the
  // suite while a fix removing it moved the metric 0.00pp.
  //
  // Same method, right corpus: ~500 common English words plus ordinary clinic
  // vocabulary, intersected with the index. 47 collided; these are the ones that
  // survived findAllDrugMentions in a Latin frame, a code-mixed frame
  // ("मैं <word> में रहता हूँ"), or both:
  //     back → Baclofen        head  → Sumatriptan   tooth  → Chlorhexidine
  //     city → Levocetirizine  child → Lactitol      effect → Aceclofenac
  //     open → Sodium Chloride area  → Urea          rest   → Cyproheptadine
  //
  // "back pain se pareshan hoon" wrote BACLOFEN — a muscle relaxant — into the
  // record. Plausible enough that nobody would query it, which is what makes it
  // worse than a miss. A missing drug is a gap; an invented one is a fabricated
  // clinical record.
  //
  // THEY GO HERE, NOT IN BRAND_BLOCKLIST. isNoiseStandalone() gates the token
  // before EITHER matcher runs, so one entry covers both the exact-brand path
  // and the fuzzy generic path. "area" proved why that matters: blocklisting it
  // for brands left it reaching Urea at 0.75 through the generic matcher.
  //
  // NOT a dictionary sweep. An earlier attempt used /usr/share/dict/words (233k
  // entries) and deleted Crocin, Aten, Amlong, Candid, Keto — real brands that
  // are also obscure English words. Frequency is the discriminator: nobody says
  // "Crocin" meaning an English word, and nobody says "back" meaning Baclofen.
  'area', 'back', 'book', 'card', 'change', 'check', 'child', 'city', 'effect',
  'even', 'first', 'free', 'full', 'give', 'head', 'just', 'large', 'left',
  'less', 'light', 'line', 'live', 'long', 'look', 'madam', 'made', 'make',
  'most', 'north', 'only', 'open', 'over', 'ready', 'rest', 'side', 'stop',
  'tooth', 'walk',

  // ── THE SAME METHOD AGAIN, ON THE RIGHT CORPUS (added 2026-08-04) ──────────
  // The batch above was mined from ~500 common English words. It moved
  // s5.drug_false_positive by 0.00pp, and the note above blames the blind
  // corpus. Both were right, and both were still one step short: NONE of those
  // 38 words appears anywhere in real Sarvam output, which is why nothing moved.
  //
  // The word list now comes from the output itself — every ASCII token in 241
  // codemix clinical hypotheses plus 426 hypotheses over general Marathi audio,
  // filtered to ordinary English words, then intersected with the index. 83 of
  // 459 collided. These are the ones a patient actually says on a phone call:
  //     acidity → Domperidone    ulcer  → Sucralfate    urine  → Taurine
  //     angina  → Aceclofenac    sinus  → Chlorpheniramine    knee → Diacerein
  //
  // NOTE WHAT THAT LIST IS. Those are CONDITIONS, not medicines. "acidity hoti
  // hai" wrote Domperidone — the drug you would be given FOR it. A patient
  // describing a symptom acquired its treatment, which reads perfectly in a
  // record and is therefore worse than a miss, exactly as the note above says.
  //
  // THE DICTIONARY TRAP, AVOIDED THIS TIME. The note above records that a
  // /usr/share/dict/words sweep deleted Crocin, Aten, Amlong, Candid and Keto.
  // This list was ALSO built with that dictionary, so it inherited the same
  // hazard, and it did catch live rounds: `aten` → Atenolol, `pant` →
  // Pantoprazole, `pipe` → Piperacillin are real brand heads and are DELIBERATELY
  // NOT BLOCKED. They were found by checking which words resolve to a molecule
  // whose name CONTAINS the word — a cheap test for "this really is the drug".
  // `urine` → Taurine passes that test and is blocked anyway: nobody naming a
  // supplement says "urine", and "urine mein jalan" is a symptom every day.
  //
  // The arbiter is not my judgement. s5.drug_entity_recall is the paired HARD
  // arm; if any entry here is a drug someone genuinely names, recall falls and
  // the gate blocks the deploy. That is what the pairing is for.
  // FIVE MORE HELD BACK, and the recall arm is what found them. The first run
  // of this list blocked 80 words, dropped s5.drug_entity_recall 29.61 → 28.75
  // and BLOCKED the deploy. The eight gold mentions it broke name the pattern:
  //     टेंडो शॉट (Tendo SHOT)      रैपिड जेल (RAPID Gel)
  //     एसिमोल फोर्ट (Acimol FORT)  क्लैम्प किड (CLAMP Kid, amox-clav)
  //     अमीनो एसिड (AMINO acid)     यूडिहेप फोर्ट (Udihep FORT)
  // Indian brand names are BUILT from ordinary English words — fort, shot,
  // rapid, clamp, amino are productive morphemes in pharma naming, not just
  // English. Blocking them standalone silently removed six real medicines. So
  // `fort`, `shot`, `rapid`, `clamp` and `amino` join aten/pant/pipe as
  // deliberate keeps, and the false positives they cost (planet→Pantoprazole
  // was never the expensive one) are the price of not deleting real drugs.
  'acidity', 'acute', 'advanced', 'again', 'airway', 'american', 'angina',
  'arterial', 'balance', 'benefit', 'beta', 'blocker', 'clinical', 'customer',
  'disease', 'easy', 'exposure', 'feel', 'fibrin', 'follow', 'fungal', 'healing',
  'health', 'immune', 'indicate', 'inhaler', 'issue', 'itch', 'jelly', 'knee',
  'leave', 'limited', 'lupine', 'lupus', 'maximum', 'methyl', 'mobile',
  'monthly', 'neuropathy', 'office', 'once', 'parasite', 'piles', 'pill',
  'planet', 'process', 'pyrite', 'rate', 'reaction', 'reflex', 'relief', 'renew',
  'restart', 'restore', 'routine', 'scalp', 'setal', 'silicon', 'sinus',
  'solution', 'stator', 'stay', 'target', 'therapy', 'times', 'told', 'tract',
  'travel', 'trio', 'ulcer', 'uric', 'urine', 'vaginal', 'version', 'word',

  // ── आराम — FOUND BY FIXING THE ENGLISH ONE (2026-08-04) ────────────────────
  // Blocking `relief` on Eka row 23 did not clear the row: the matcher simply
  // fell through to the NEXT false positive in the same sentence. "थोड़ा relief
  // हुआ ... उससे मुझे कुछ आराम हुआ" was scoring Paracetamol via `relief`, and
  // with that gone it scores NIMESULIDE via `aram`.
  //     आराम / aram  → Nimesulide   [brand index, score 1.0]
  //     aaram        → Alprazolam   [brand index, score 1.0]
  // "क्या आराम मिला?" is what a doctor asks and what a patient answers, on
  // almost every follow-up call there is. The second spelling is worse than the
  // first: Alprazolam is a benzodiazepine, and "थोड़ा आराम मिला" would write a
  // controlled sedative into a clinical record.
  //
  // Same family as dawa→Domperidone (282x), dard→Chlorzoxazone (135x) and
  // thik→Magaldrate (147x), found 2026-07-27 — ordinary Hindi that happens to be
  // a registered brand head. That sweep caught the words for MEDICINE, PAIN and
  // OK; it missed the word for RELIEF. Both spellings go in because the
  // romanizer emits `aram` from Devanagari while a code-mixed caller types
  // `aaram`, and they resolve to different molecules.
  'aram', 'aaram',

  // ── PROPER NOUNS THAT ROMANIZE ONTO A MOLECULE (2026-08-06) ───────────────
  // These two reach a GENERIC directly rather than through the brand index, so
  // BRAND_BLOCKLIST cannot stop them. Both come from the drug-free STT corpus:
  //     जिंद   → zind → Zinc     the town of Jind, Haryana. Zinc itself
  //                              romanizes to zink/zinc and is untouched.
  //     बोरा   → bora → Borax    a sack, and a surname.
  'zind', 'bora',

  // ── RE-MINED AFTER THE saaras:v4 SWITCH (2026-08-06) ──────────────────────
  // Every list above was mined from saaras:v3 OUTPUT. v4 keeps ~7pp more Latin
  // script (MEASURED across REST and the socket), so it emits a different
  // English vocabulary — 296 tokens across 529 hypotheses that v3 never
  // produced once. A blocklist calibrated on one model's output is not
  // calibrated on another's, which is the same corpus-distribution lesson as
  // 2026-08-04 arriving through a new door.
  //
  // Of those 296, 87 are ordinary English words and 19 resolve to a molecule.
  // Same dangerous shape as before — a CONDITION acquiring its treatment:
  //     edema -> Bromelain        prostatic -> Ulinastatin
  // and plain collisions:
  //     heavy -> Lidocaine        gram  -> Cefuroxime    ring -> Teneligliptin
  //     minus -> Serratiopeptidase  flora -> Ofloxacin   coral -> Tobramycin
  //
  // FOUR ARE DELIBERATELY NOT BLOCKED. menthol, diosmin and hesperidin resolve
  // to THEMSELVES — real substances, correct matches. And `rapid` stays out for
  // the reason the recall arm already taught once today: रैपिड जेल is a real
  // brand, and blocking the word deletes the medicine.
  'acetylcholine', 'celsius', 'coral', 'edema', 'electronics', 'flora', 'gram',
  'heavy', 'minus', 'neutral', 'plan', 'pouch', 'prostatic', 'ring', 'serine',

  // ── FROM REAL CALLS — the flywheel's first catch (2026-08-05) ─────────────
  // Everything above this line was mined from corpora: public datasets, or the
  // ASR output stored with them. This block is the first that came from 752
  // turns of actual patient speech, harvested out of the production database
  // (ritu-evals/tools/harvest-production-turns.js).
  //
  // It found a class none of those corpora could contain. These are ordinary
  // HINDI AND MARATHI words — romanized on the way into the matcher, then
  // matching the brand index exactly:
  //     स्लॉट  (slot)       → clot    → Tranexamic Acid   5x
  //     पैसे   (money)      → pase    → Aceclofenac       5x
  //     ऐसा    (such)       → aisa    → Benfotiamine      3x
  //     परसों  (day after)  → paracon → Paracetamol       2x
  //     करतो   (Marathi)    → carato  → Atorvastatin      2x
  //     क्यों  (why)        → cyon    → Cyproheptadine    2x
  //     मस्ती  (fun)        → masti   → Sildenafil
  //     "Ritu, can you..." → ritucan → Rituximab
  //
  // The English-word fix earlier today could not reach these: it worked on
  // Latin-script tokens, and these arrive in Devanagari. Blocking a word here
  // blocks its ROMANIZED form, which is the surface the matcher actually sees.
  //
  // THE ONE THAT MATTERS MOST:
  //     "हाँ यार मुझे साँस भी नहीं आ रही अभी"  →  sans → Clotrimazole
  // A caller saying "I can't breathe right now" acquired an antifungal. That is
  // a respiratory-distress sentence, and the record would show a medication.
  //
  // `clot`, `cain` and `paracon` are the risky entries and were kept in
  // deliberately: "clot" is a real medical word, "cain" ends every -caine
  // anesthetic, and "Paracon" could plausibly be a registered brand. The paired
  // recall arm is the arbiter, as it was for fort/shot/rapid/clamp/amino.
  'accident', 'aisa', 'cain', 'carato', 'charges', 'clot', 'cyon', 'hours',
  'itana', 'kasa', 'masti', 'paracon', 'pase', 'ritucan', 'sans', 'sparo',
  'turant',

  'vivaran', 'vivran', 'anti', 'antibiotic', 'antibiotics', 'diabetes', 'fever',
  'last', 'complete', 'diet', 'cord', 'human', 'topical', 'lipid', 'examine',
  'medicine', 'medicines', 'tablet', 'tablets', 'capsule', 'capsules', 'syrup',
  'injection', 'cream', 'drops', 'dose', 'doses', 'dosage', 'sunscreen',
  'normal', 'regular', 'morning', 'evening', 'night', 'daily', 'weekly',
  'doctor', 'patient', 'hospital', 'clinic', 'report', 'reports', 'test',
  'tests', 'blood', 'sugar', 'pressure', 'weight', 'height', 'water',
  'food', 'milk', 'juice', 'problem', 'problems', 'pain', 'infection',
  'allergy', 'allergic', 'cough', 'cold', 'headache', 'stomach', 'chest',
]);

// Romanized Hindi/Marathi function words. Two jobs, both found by running
// findAllDrugMentions over real sentences: (1) as candidates they collide —
// "leta" (लेता, "take") matched Levocetirizine; (2) as JOIN partners they
// manufacture drugs that were never said — "Dolo aur" joined to "dolour" and
// matched Aceclofenac. The joined-pair heuristic exists for STT word-splits
// ("metro nidazole"), so it must only fuse fragments, never a drug and the
// ordinary word after it.
const HINDI_FUNCTION = new Set([
  'aur', 'hai', 'hain', 'hun', 'hoon', 'raha', 'rahi', 'rahe', 'leta', 'lete',
  'leti', 'liya', 'lena', 'mein', 'main', 'aap', 'aapko', 'mera', 'meri',
  'mujhe', 'mereko', 'tum', 'wala', 'wali', 'vale', 'kar', 'karo', 'karta',
  'karti', 'kya', 'nahi', 'nahin', 'haan', 'bhi', 'toh', 'abhi', 'roz',
  'roze', 'subah', 'sham', 'shaam', 'din', 'raat', 'dono', 'sirf', 'bas',
  'thoda', 'zyada', 'kuch', 'koi', 'phir', 'baad', 'pehle', 'saath', 'liye',
  'chal', 'chalu', 'chalti', 'chalta', 'dawai', 'dava', 'goli', 'golia',
  'ghetoy', 'ghete', 'aahe', 'ahet', 'kahi', 'maza', 'majha', 'tumhi',
  // v/w PAIRS. romanizeVariants emits BOTH spellings (व → v and w), so a word
  // listed under only one spelling is still live under the other. Measured
  // 2026-07-26: "वाली" (the-one-with) romanized to "vali" — 4 chars, an EXACT
  // brand-index hit — and confidently resolved "Metamorphosin वाली दवाई" to
  // Sucralfate. A confident WRONG molecule is the worst output this layer can
  // produce, so both spellings of every common word must be present.
  'vali', 'vala', 'wale', 'vaale', 'waale', 'wala', 'vahi', 'wahi', 'voh',
  'davai', 'dawai', 'davaai', 'dava', 'dava', 'goliya', 'goli',
]);
// ── MINED MEDS-TURN STOPWORDS (MEASURED 2026-07-27) ────────────────────────
// Across 5 decodes of 320 clinical rows, 3,359 of 4,332 drug matches (77.5%)
// came from the 116k brand index — and ranking them by the surface token that
// triggered them showed only TWO of the top 40 were real drugs (telma, dolo).
// The other 38 are ordinary words that happen to be registered Indian brand
// names, so they match EXACTLY, at score 1.0:
//     dawa   (दवा,  "medicine") → Domperidone     282x
//     thik   (ठीक,  "okay")     → Magaldrate      147x
//     dard   (दर्द,  "pain")     → Chlorzoxazone   135x
//     jalan  (जलन,  "burning")  → Omeprazole       36x
//     rahat  (राहत, "relief")   → Ambroxol         40x
// Gating the index to the meds turn made this WORSE, not better: that is
// exactly the turn where a patient says दवा, दर्द, तीन दिन. A caller answering
// "हाँ दवा चल रही है" was read back "आप Domperidone ले रहे हैं — सही सुना ना?",
// and one agreeable "हाँ" writes a confident wrong molecule into the record —
// the precise safety event this whole layer exists to prevent. A registered
// brand name is not evidence when the word is also everyday speech.
// Source: ritu-evals/data/brand-stopword-audit.json
const MEDS_TURN_STOPWORDS = new Set([
  // Hindi/Marathi words a patient says while ANSWERING the medicines question
  'dawa', 'dard', 'thik', 'jalan', 'rahat', 'roop', 'deta', 'ulti', 'teen',
  // Caught by the meds-turn canary arm on its first run (2026-07-27), which is
  // exactly the job that arm exists to do. Both are high-frequency:
  //   "बीपी की गोली चलती है"  (I take the BP tablet)  → bipi → Telmisartan
  //   "मला त्रास होतोय"       (Marathi: I'm unwell)   → tras → Sertraline
  // Naming a CONDITION is not naming a medicine — the same rule that already
  // puts fever and diabetes in NOT_A_DRUG. "BP ki goli" is what a caller says
  // when they do NOT know the name, so guessing a molecule there is the worst
  // possible moment to guess.
  'bipi', 'tras', 'shugar', 'sugercontrol',
  // English words common in codemix clinical speech
  'okay', 'take', 'high', 'days', 'three', 'thri', 'time', 'lets', 'start',
  'some', 'reflux', 'thank', 'done', 'related', 'five', 'medical', 'level',
  'right', 'soft', 'zane', 'sure', 'manage', 'more', 'synthetic', 'chronic',
]);

// Words that are not a drug ALONE but are a legitimate PART of a multi-word
// molecule name. These block only as a standalone candidate and must still be
// allowed to join: 41 of our 1,751 generics end in " acid" (Folic Acid,
// Tranexamic Acid, Mefenamic Acid, Ursodeoxycholic Acid …) and reach the
// matcher through the joined-pair path, so putting 'acid' in the full noise
// set would silently delete all 41. Same for 'lact' (Lactulose, Lactitol,
// Lactobacillus) and 'star' (Starpress).
//
// 'esid'/'ecid' are what एसिड ("acid") romanizes to, and they belong here for
// exactly the same reason — NOT in the full stoplist. The brand-trigger audit
// ranked `ecid → Domperidone` 22x and it is tempting to hard-block it, but
// क्लैव्युलेनिक एसिड IS Clavulanic Acid. Blocking the standalone token stops
// the Domperidone fire without asserting that "acid" is never part of a drug.
// (Those Devanagari acids still do not resolve — "klavyulenik esid" is 0.375
// from "clavulanic acid", outside the 0.28 romanized bar. That is the
// romanizer defect, a separate and much larger piece of work; the point here
// is that the stoplist is no longer the thing standing in its way.)
const NAME_PART_ONLY = new Set(['acid', 'esid', 'ecid', 'lact', 'star', 'vitamin']);

const NOISE = expandSpellings([...NOT_A_DRUG, ...HINDI_FUNCTION, ...MEDS_TURN_STOPWORDS]);
const NOISE_STANDALONE = expandSpellings(NAME_PART_ONLY);

// An ordinary word. Blocked as a candidate AND as a join partner.
const isNoise = (w) => NOISE.has(w);
// Additionally blocked as a STANDALONE candidate, but still free to join.
const isNoiseStandalone = (w) => NOISE.has(w) || NOISE_STANDALONE.has(w);

// MEASURED THRESHOLD SPLIT (2026-07-26). Candidates that came from romanizing
// Devanagari must be judged more strictly than ones the STT wrote in Latin:
// romanization is lossy, so "close" carries less evidence, and every Devanagari
// word becomes a candidate rather than the occasional Latin island. A sweep over
// the 1,751-molecule list measured, on real Marathi sentences containing no
// drugs at all:
//     0.34 → 3.53% false positives   (4/6 Devanagari drugs still found)
//     0.28 → 0.60%                   (4/6 — same recall, 6x fewer FPs)
//     0.25 → 0.60%                   (3/6 — recall starts costing)
// 0.28 is the knee: all the precision, none of the recall.
const ROMAN_MAX_DIST = 0.28;
// ─── THE SPECULATIVE BAR ────────────────────────────────────────────────────
// Candidates reached only through devanagari.js's SPECULATIVE table are guesses
// about how a transliterator rendered a sound — up to three chained
// substitutions from what was heard. Tried at the ordinary romanized bar they
// took recall 29.73 -> 34.89 AND false positives 0.90 -> 2.93, blowing a HARD
// kill criterion and resolving एसिक्लोफेनेक (Aceclofenac) to DICLOFENAC. A
// confidently wrong molecule is worse than the miss it replaced.
//
// 0.12 admits roughly one edit in a nine-character name. daiklofenek reaches
// diclofenac EXACTLY under those rules, so the recall this was built for
// survives; esiklofenek reaches diclofenac only at a distance this refuses.
// Evidence quality sets the threshold, not convenience.
const SPECULATIVE_MAX_DIST = 0.19;

// ─── THE ALIAS TIER: EXACT SURFACES, NOT A LOOSER BAR ───────────────────────
// MEASURED 2026-08-06 over all 1,169 distinct gold surfaces in the Eka corpus,
// by asking of every unresolved one: what is its nearest generic, and how far?
//
// The 0.28→0.45 band holds 89 surfaces, and reading them settles the design:
//     85x  डायबिटीज      0.444 → dasatinib      diabetes, a CONDITION
//     44x  स्ट्रिप        0.429 → estriol        a dosage form
//     32x  कोलेस्ट्रॉल    0.300 → fosfestrol     cholesterol → an ESTROGEN
//     26x  फेफड़ों        0.444 → heparin        "lungs"
//     20x  छींक          0.429 → choline        "sneeze"
//      6x  किडनी         0.429 → lindane        "kidney" → a SCABIES treatment
// Loosening ROMAN_MAX_DIST to reach anything in this band buys those with it,
// and कोलेस्ट्रॉल sits at 0.300 — INSIDE any bar that would admit calcium at
// 0.333. The threshold cannot separate them, because distance is not what
// distinguishes them. Nothing does, except knowing the word.
//
// So: exact surfaces. An alias fires only on a whole-token exact match after
// romanization, never fuzzily, so it cannot generalise to a neighbour the way
// a threshold does. It is a lexicon entry — the instrument this actually
// needed — and it costs precision nothing by construction.
//
// Each entry is a molecule that IS in drug_generics.json and fails purely on
// how Devanagari renders it. The counts are occurrences in gold.
//   कैल्शियम is the whole argument in one word: कैल्सियम (with स) ALREADY
//   resolves. Only श breaks it, because Hindi writes English /s/ before a front
//   vowel as श — and the ambiguity table's s→c rule turns "sh" into "ch",
//   walking calcium AWAY from itself. 37 misses on one grapheme.
const TRANSLIT_ALIAS = {
  'कैल्शियम': 'Calcium',                    // 37 — calchiyam, 0.333
  'एसिक्लोफेनेक': 'Aceclofenac',             // 20 — the one deliberately left
                                            // unresolved on 2026-08-05: correct
                                            // and WRONG (Diclofenac) sit at an
                                            // identical 0.273, so no threshold
                                            // can ever pick between them. An
                                            // exact surface can.
  'सेरेसियोपेप्टिडेस': 'Serratiopeptidase',   // 10 — 0.353
  'लिवोसल्पिराइड': 'Levosulpiride',          //  6 — 0.308
  'एल-मिथाइल फोलेट': 'L-Methyl Folate',      //  6 — 0.375
  'मैग्नीशियम': 'Magnesium',                 //  6 — 0.364, the same श as calcium
  'एसिटाइलसिस्टीन': 'Acetylcysteine',        //  5 — nearest was SITAGLIPTIN
  'टॉरीन': 'Taurine',                       //  5 — 0.429

  // ── SECOND PASS (2026-08-06): all 887 unresolved gold surfaces classified ──
  // The first eight came from reading the top of ONE distance band. This pass
  // read every unresolved surface in the corpus. The headline is not the new
  // aliases — it is the shape:
  //     657  NOT_A_DRUG   conditions, organs, dosage forms, classes, lab tests
  //     179  BRAND        Indian brand names, not molecules
  //      27  MOLECULE     a real ingredient, already in drug_generics.json
  //      24  UNSURE
  // 74% of what this matcher "misses" it is SUPPOSED to miss. Any future plan
  // that reads the miss list as a lexicon backlog is reading it wrong.
  //
  // Every canonical below was checked to exist in drug_generics.json with exact
  // casing, and every surface was confirmed to currently resolve to nothing.
  'क्लैव्युलेनिक एसिड': 'Clavulanic Acid',    // 15
  'एसिटामिनोफेन': 'Paracetamol',             //  6 — acetaminophen IS paracetamol
  'फ्लाइक्टासोन प्रोपियोनेट': 'Fluticasone Propionate', // 5
  'इवनिंग प्रिमरोज ऑयल': 'Evening Primrose Oil',      // 5
  'ग्लिक्लेजाइड': 'Gliclazide',              //  5
  'कोलेंजन टैबलेट': 'Collagen Peptide',       //  5
  'कोलेजन': 'Collagen Peptide',              //  5
  'बैसिलस क्लॉसी': 'Bacillus Clausii',        //  5
  'एलेंड्रॉनिक एसिड': 'Alendronic Acid',      //  5
  'फोलेट': 'Folic Acid',                     //  5 — plain folate. NOT L-Methyl
                                             //  Folate, which is a different
                                             //  molecule and is asserted apart.
  'कॉड लिवर ऑयल': 'Cod liver oil',            //  5
  'दूध के थिसल': 'Silymarin',                //  5 — milk thistle; silymarin is
                                             //  the extract it is sold as
  'पायरेसेटम': 'Piracetam',                  //  5

  // ── BRAND HEADS (2026-08-06) ──────────────────────────────────────────────
  // The same classification found 91 surfaces (478 occurrences) naming real
  // Indian BRANDS that resolve to nothing, even though the 116k brand index
  // contains them. The cause is structural: romanized candidates are allowed an
  // EXACT brand hit and nothing else, and Devanagari romanization lands one or
  // two edits away from how the brand is spelled.
  //
  // TWO FIXES WERE TRIED AND BOTH MEASURED BADLY:
  //   1. Fuzzy brand matching for romanized candidates. MEASURED: findDrugMention
  //      44ms → 143ms per call. That is +99ms on the meds turn, ~10% of the
  //      whole turn budget, inside the live voice loop. Scanning 116k brands per
  //      romanized variant is the wrong shape regardless of what it buys.
  //   2. A consonant-skeleton index (drop vowels, hash lookup — fast). MEASURED
  //      WRONG: सैट्रोजिल → sterzole/cetrezol/citrazol (it is satrogyl),
  //      वाइबैक्ट → vibketo (it is vibact), मैकसार्ट → makcort (it is macsart).
  //      Indian brand names are short and vowel-differentiated, so dropping
  //      vowels destroys the only thing telling them apart.
  //
  // So: exact heads, the instrument that has worked all day. Free at runtime
  // (one hash lookup, already on the path) and incapable of generalising to a
  // neighbour. Keyed on the BRAND HEAD alone, because the gold surfaces carry
  // dose and form noise ("स्टारक्लेव 625एमजी", "केटोलाइट शैम्पू") that the
  // candidate builder already strips into separate tokens.
  //
  // These map a BRAND to its composition, which is what the rest of the matcher
  // means by canonical. Every one verified present in drug_generics.json.
  'वाइबैक्ट': 'Lactobacillus Sporogenes', // 11
  'ज़ोनग्रान': 'Zonisamide',               //  6
  'केटोलाइट': 'Ketoconazole',             //  6
  'एसीमीझ प्लस': 'Aceclofenac',            //  6
  'स्टारक्लेव': 'Amoxicillin',             //  6
  'सैट्रोजिल': 'Satranidazole',            //  5
  'नॉरफ़्लॉक्स': 'Norfloxacin',             //  5
  'क्रिनोन': 'Progesterone',              //  5
  'एम्पाओन': 'Empagliflozin',             //  5
  'टेल्मिड्यूस': 'Telmisartan',            //  5
  'फ्यूडिक': 'Fusidic acid',              //  5
  // Won back as an exact surface after the speculative-brand retry above was
  // blocked. `glycomet` IS in the index; it was only ever unreachable because
  // the variant carrying it is a guess. Naming the word costs nothing.
  'ग्लाइकोमेट': 'Metformin',               // 10 — Glycomet
  // Reachable only via the SHORT-TOKEN JOIN added to buildCandidates: पैन is
  // 3 chars and डी is 2, so neither the {3,} scan nor the >=4 alias floor could
  // ever see this drug. The key is the JOINED form "pandi", never bare "pan".
  'पैन डी': 'Pantoprazole',               // 10 — Pan D
  'स्टेटर': 'Atorvastatin',                // 12 — Stator, across two surfaces

  // पैन डी (10, the second-largest brand item) IS NOT REACHABLE and is left
  // out rather than forced. It romanizes to "pan di": the builder scans
  // /[a-z]{3,}/ so "di" vanishes, and the alias table needs >=4 chars so "pan"
  // is refused too. Lowering either floor to catch it would register a
  // three-letter key against a syllable that is ordinary speech in both Hindi
  // and English — the फोर्ट/शॉट/रैपिड lesson, which cost real recall on
  // 2026-08-04. The same unreachability bit एल-मिथाइल फोलेट, and it is worth
  // naming as a class: a drug whose name is a short word plus a single letter
  // (Pan D, Pan 40, Zifi O) cannot survive this tokenizer. Fixing it properly
  // means a brand+letter rule like the DEV_VITAMIN_LETTER one already in
  // buildCandidates, not a lower floor.

  // DELIBERATELY NOT ALIASED, both from this pass:
  //   टेनोफोवीर (5) — the lexicon holds BOTH "Tenofovir Alafenamide" and
  //     "Tenofovir disoproxil fumarate". Bare "tenofovir" does not say which
  //     salt, and picking one records the wrong product for a patient on the
  //     other. Unlike Aceclofenac, no exact surface can settle this — the
  //     ambiguity is in what the patient SAID, not in how we matched it.
  //   सीटीडी 6.25 एमजी (5) — CTD is Chlorthalidone here, but CTD is also
  //     ordinary clinical shorthand for connective tissue disease, and a key
  //     that carries a dose is not a stable key.
};

// Expand each surface through THE SAME romanizer that builds candidates, so
// every spelling the ambiguity table can emit is covered. Keying on the
// Devanagari alone would miss, since the matcher never sees Devanagari — it
// sees whichever romanization won. This is the "EXPAND EVERY STOPLIST" rule
// below, applied to a matchlist: a table written in one script is dead unless
// it is expanded through the transform its inputs actually go through.
// A key is only useful if the candidate builder can actually PRODUCE it, so
// derive the keys through the builder's own tokenizer rather than guessing the
// shape. "एल-मिथाइल फोलेट" romanizes to "el-mithail folet"; the builder scans
// /[a-z]{3,}/ and joins adjacent pairs, so the two-char "el" vanishes and the
// only reachable form is "mithailfolet". Writing the obvious key by hand
// ("elmithailfolet") produced a silent miss — the table looked right and
// matched nothing.
const ALIAS_LC = new Map();
for (const [surface, canonical] of Object.entries(TRANSLIT_ALIAS)) {
  for (const v of romanizeVariants(surface)) {
    const toks = v.toLowerCase().match(/[a-z]{3,}/g) || [];
    const add = (k) => { if (k.length >= 4) ALIAS_LC.set(k, canonical); };
    // Single tokens ONLY from single-word surfaces. A component of a multi-word
    // name is a DIFFERENT molecule: bare "folet" (folate) is not L-methyl
    // folate, and registering it would manufacture exactly the wrong-drug
    // error this tier exists to avoid.
    if (toks.length === 1) add(toks[0]);
    for (let i = 0; i + 1 < toks.length; i++) add(toks[i] + toks[i + 1]); // adjacent join
    if (toks.length > 2) add(toks.join(''));               // whole surface
  }
}

// Exact alias hit over the candidate set. Returns null when nothing matches, so
// the ordinary fuzzy path runs untouched — this tier only ever ADDS.
// LONGEST match wins, not the first one the candidate builder happens to offer.
// Once फोलेट→Folic Acid was registered, "एल-मिथाइल फोलेट" had TWO live keys —
// "mithailfolet" (L-Methyl Folate) and "folet" (Folic Acid) — and returning the
// first would have made the answer depend on candidate ORDER, which is an
// implementation detail of buildCandidates. A longer key is a more specific
// surface, and the more specific molecule is the right one.
function _matchAlias(cands, exclude) {
  let best = null;
  for (const { q } of cands) {
    const canonical = ALIAS_LC.get(q);
    if (!canonical || canonical === exclude) continue;
    if (!best || q.length > best.surface.length) best = { surface: q, canonical, score: 1, viaAlias: true };
  }
  return best;
}

// One candidate builder for both matchers, so a fix to either can never drift
// from the other. Each candidate carries whether it came from romanization.
function buildCandidates(text) {
  const latin = String(text || '').toLowerCase().match(/[a-z]{3,}/g) || [];
  const cands = [];
  for (let i = 0; i < latin.length; i++) {
    if (latin[i].length >= 4) cands.push({ q: latin[i], romanized: false });
    // Join only when NEITHER side is an ordinary word — the heuristic exists for
    // STT word-splits ("metro nidazole"); joining a drug to the Hindi word after
    // it invents drugs ("Dolo aur" → "dolour" → Aceclofenac).
    if (i + 1 < latin.length && !isNoise(latin[i]) && !isNoise(latin[i + 1])) {
      cands.push({ q: latin[i] + latin[i + 1], romanized: false });
    }
  }
  // "Vitamin D3" tokenizes to exactly ["vitamin"] — the letter is one character
  // and the digit is not a letter at all, so the ≥3-char scan drops both. Bare
  // "vitamin" then fuzzy-matched "Vitamin A" (norm 0.22, inside 0.34) for EVERY
  // vitamin a patient could name. MEASURED 2026-07-27:
  // findDrugMention('Vitamin D3') → Vitamin A — a confidently WRONG molecule,
  // the same failure class as the brand-index stopwords. So capture the letter
  // explicitly, and keep 'vitamin' in NAME_PART_ONLY so the bare token can no
  // longer resolve on its own through any path. The (?![a-z]) guard is what
  // stops "vitamin ki goli" from resolving to Vitamin K.
  for (const m of String(text || '').toLowerCase().matchAll(/vitamin\s*([a-k])(?![a-z])/g)) {
    cands.push({ q: 'vitamin ' + m[1], romanized: false });
  }
  // Same problem one script over, and worse: विटामिन डी3 loses its letter
  // BEFORE romanization, because डी is two characters and the Devanagari scan
  // below takes {3,}. So the whole span collapsed to bare "vitamin" and every
  // Devanagari vitamin in the corpus scored as Vitamin A. Letter-names are
  // matched as WHOLE words — the (?![ऀ-ॿ]) lookahead is what stops
  // "विटामिन सप्लीमेंट" (vitamin supplement) resolving to Vitamin C off its
  // leading स. A generic "supplement" has no molecule and must stay unresolved.
  // The letter may arrive in EITHER script — codemix writes "विटामिन D" as
  // often as "विटामिन डी", sometimes inside the same sentence.
  const DEV_VITAMIN_LETTER = { 'ए': 'a', 'बी': 'b', 'सी': 'c', 'डी': 'd', 'ई': 'e', 'के': 'k' };
  for (const m of String(text || '').matchAll(/विटामिन[\s\-]*(ए|बी|सी|डी|ई|के|[a-kA-K])(?![ऀ-ॿa-zA-Z])/g)) {
    const letter = DEV_VITAMIN_LETTER[m[1]] || m[1].toLowerCase();
    cands.push({ q: 'vitamin ' + letter, romanized: false });
  }
  // Devanagari drug names — invisible before 2026-07-25 because this scanned
  // Latin only, missing पैरासिटामोल and मेटफॉर्मिन, both already in our list.
  // ANY Indic script, not just Devanagari. Nine of the eleven languages Ritu
  // speaks were falling straight past this gate — "ಡೋಲೋ" reached the matcher and
  // matched nothing, on a live call where the caller plainly said she had taken
  // a Dolo. toDevanagari shifts the Brahmic block first, and everything below
  // then works unchanged. See the note above toDevanagari in devanagari.js.
  if (hasIndic(text)) {
    text = toDevanagari(text);
    const dev = String(text).match(/[ऀ-ॿ]{3,}/g) || [];
    for (let i = 0; i < dev.length; i++) {
      for (const v of romanizeVariants(dev[i])) {
        // >=4, not >=5: डोलो romanizes to "dolo", which IS in the brand index
        // (dolo = Paracetamol) but was excluded by a 5-char floor. Short brand
        // names are common in India (Dolo, Telma, Pan D, Zifi). The romanized
        // path is protected by its own tighter threshold and the mined
        // collision blocklist, so the floor was doing little work here.
        if (v.length >= 4) cands.push({ q: v, romanized: true });
      }
      for (const v of speculativeVariants(dev[i])) {
        if (v.length >= 4) cands.push({ q: v, romanized: true, speculative: true });
      }
      // ADJACENT-PAIR JOIN, which the Latin path above has always done and this
      // one never did. The asymmetry was backwards: Devanagari STT splits words
      // MORE, not less — the Marathi WER run found saaras splitting postpositions
      // routinely, and "जी काल बोल" is Calpol arriving as two words. Gold row
      // r23.d0 in the eval corpus is exactly this, and the matcher has never
      // caught it.
      //
      // Same guard as the Latin join, for the same reason: only when NEITHER
      // side is an ordinary word. Joining a drug to the Hindi word after it
      // invents drugs, which is what isNoise() is there to prevent.
      if (i + 1 < dev.length) {
        const a = romanizeVariants(dev[i])[0];
        const b = romanizeVariants(dev[i + 1])[0];
        if (a && b) {
          const joined = a + b;
          const clean = !isNoise(a) && !isNoise(b) && !isNoiseStandalone(a) && !isNoiseStandalone(b);
          // A join across a "noise" word is unsafe to match FUZZILY but is
          // exactly what a multi-word alias needs. "क्लैव्युलेनिक एसिड"
          // romanizes to "klavyulenik esid", and esid (acid) is in
          // NAME_PART_ONLY — so the guard that stops "Dolo aur" → "dolour" was
          // also making Clavulanic Acid unreachable. Emit it either way and let
          // the ALIAS tier see it; aliasOnly candidates are skipped by both
          // fuzzy loops, so the guard keeps its full force where it matters.
          if (joined.length >= 4) cands.push({ q: joined, romanized: true, aliasOnly: !clean });
        }
      }
    }

    // ─── SHORT-TOKEN JOINS: the "Pan D" class ────────────────────────────────
    // The scan above is /[ऀ-ॿ]{3,}/, so a one- or two-character token never
    // enters `dev` at all and there is no pair to join. That silently deletes a
    // whole family of Indian drug names — a short brand plus a letter or a
    // number: पैन डी (Pan D, 10x in gold), ज़िफी ओ, पैन ४०. MEASURED: पैन
    // romanizes to "pan" and डी to "di"; "di" is below the 3-char floor, so the
    // matcher only ever saw "pan", which is 3 chars and below the alias floor
    // too. The drug was unreachable from both ends.
    //
    // The wrong fix is a lower floor. A three-letter key registered against
    // ordinary Hindi and English speech is exactly what cost recall on
    // 2026-08-04 (fort/shot/rapid), and "pan" is a word in both languages.
    //
    // So: scan ALL Devanagari tokens, but emit ONLY the joins the {3,} scan
    // could not already produce, and mark every one aliasOnly. They are visible
    // to the exact-match alias tier and invisible to both fuzzy loops, so this
    // adds reachability without adding a single fuzzy comparison.
    const devAll = String(text).match(/[ऀ-ॿ]+/g) || [];
    for (let i = 0; i + 1 < devAll.length; i++) {
      // Skip pairs the loop above already covered — both sides >= 3 chars.
      if (devAll[i].length >= 3 && devAll[i + 1].length >= 3) continue;
      const a = romanizeVariants(devAll[i])[0];
      const b = romanizeVariants(devAll[i + 1])[0];
      if (!a || !b) continue;
      const joined = a + b;
      if (joined.length >= 4) cands.push({ q: joined, romanized: true, aliasOnly: true });
    }
  }
  return cands;
}

// BOUNDED Levenshtein. MEASURED 2026-08-06 by CPU profile: 96% of a MISSING
// findDrugMention was this scan — 66.5% self-time in the loop plus 29.6% in
// here — costing ~20ms on ordinary Marathi and ~44ms on drug-naming speech, on
// the meds turn, inside the voice loop, to conclude nothing.
//
// A length index was tried first and bought only 7%, because drug names and
// spoken tokens share a length distribution: the in-threshold band is exactly
// where the lexicon already lives. The waste is not WHICH pairs get compared,
// it is that every comparison computes a FULL matrix when the answer is almost
// always "far away".
//
// So take the ceiling. The caller only cares whether norm <= th, i.e. whether
// d <= th * max(m, n); pass that as `max` and abort the moment an entire DP row
// exceeds it, since rows are non-decreasing down the matrix. Returning max+1 is
// enough for every caller — they all compare against the threshold, never use
// the exact distance of a rejected pair. Same accepted pairs, same distances
// for them, identical results.
function lev(a, b, max) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
  const cap = max === undefined ? Infinity : max;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Every later row is >= this row's minimum, so nothing below can come back
    // under the cap. Bail with a value the caller will reject.
    if (rowMin > cap) return cap + 1;
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

// findDrugMention(text) → { mentioned, surface, canonical, score } | { mentioned:false }
// Scans Latin tokens (codemix keeps drug names in Latin) length ≥4 and adjacent
// pairs (STT word-splits like "metro nidazole"), best Levenshtein match.
// ─── THIS PATIENT'S OWN MOLECULES ────────────────────────────────────────────
// The single strongest prior available, and until now it was unused: db.js has
// getPatientMedications() — exported, documented, and called from nowhere. The
// same shape as the bug migration 007 was written to fix, one layer up.
//
// WHY A LOOSER BAR IS SAFE HERE. Threshold is a function of candidate-set size.
// Against 1,751 molecules, 0.28 is the knee — past it, ordinary speech starts
// colliding with something. Against the ~5 molecules THIS caller has previously
// confirmed, there is almost nothing to collide with, so the same edit distance
// carries far more evidence. Measured (see db.js:getPatientMedications): at
// N≈5, accepting at 0.50 holds false positives at 0.56%.
//
// WHAT IT RECOVERS. The garbles 8kHz actually produces are far from the target
// but close to nothing else. All four of these are real, from live calls, and
// all four miss today:
//     "Metamorphosin"      norm 0.38 from Metformin
//     "आ Metaphor scene"   the Latin-island case
//     "काल बोल"            Calpol, split into two Devanagari words
// If the patient told us last month they take Metformin, "Metamorphosin" is not
// an ambiguous string — it is their Metformin, mangled by a phone line.
//
// It cannot invent a drug: every answer comes from a list the caller themselves
// previously confirmed. The worst case is echoing back a molecule they really
// do take, which is the read-back turn's entire job.
const PRIOR_MAX_DIST = 0.50;

function _matchPrior(cands, prior, exclude) {
  let best = null;
  for (const { q } of cands) {
    // The noise gate still applies. A 5-item list at 0.50 would otherwise let
    // "aisa" or "pase" reach a molecule, and this path is the LEAST supervised.
    if (q.length < 4 || isNoiseStandalone(q)) continue;
    for (const term of prior) {
      if (!term) continue;
      const lc = String(term).toLowerCase();
      if (exclude && term === exclude) continue;
      if (Math.abs(q.length - lc.length) / Math.max(q.length, lc.length) > PRIOR_MAX_DIST) continue;
      const d = lev(q, lc);
      const norm = d / Math.max(q.length, lc.length);
      if (norm <= PRIOR_MAX_DIST && (!best || norm < best.norm)) {
        best = { surface: q, canonical: term, norm, score: +(1 - norm).toFixed(3) };
      }
    }
  }
  return best;
}

function findDrugMention(text, opts = {}) {
  // brands: consult the 116k Indian brand index too. OFF by default — see the
  // measured false-positive note at the brand fallback below.
  // prior: this caller's previously confirmed molecules — see PRIOR_MAX_DIST.
  const { maxNormDist = 0.34, exclude = null, brands = false, prior = null } = opts;
  const cands = buildCandidates(text);

  // An exact alias beats everything, including the prior. The prior matches
  // FUZZILY at 0.50; an alias is a whole-token identity. Exact evidence
  // outranks approximate evidence regardless of which list it came from.
  const a = _matchAlias(cands, exclude);
  if (a) return { mentioned: true, ...a };

  // The prior runs next and wins outright over the general list. If the caller
  // has told us before that they take Metformin, a slurred approximation of it
  // is that, not a 0.28-distance stranger from the full list.
  if (Array.isArray(prior) && prior.length) {
    const p = _matchPrior(cands, prior, exclude);
    if (p) {
      return { mentioned: true, surface: p.surface, canonical: p.canonical, score: p.score, viaPrior: true };
    }
  }

  let best = null;
  for (const { q, romanized, speculative, aliasOnly } of cands) {
    if (aliasOnly) continue;              // join across a noise word: exact-match only
    if (isNoiseStandalone(q)) continue;   // NOT_A_DRUG + HINDI_FUNCTION + meds-turn stopwords
    const th = speculative ? SPECULATIVE_MAX_DIST : romanized ? ROMAN_MAX_DIST : maxNormDist;
    // Length prune, PROPORTIONAL to the norm threshold (length diff is a lower
    // bound on edit distance, so this can never exclude an in-threshold pair).
    // The old flat ">3" prune silently blocked long surfaces: a 13-char STT
    // join like "metforminwali" can never be within 3 of 9-char "metformin",
    // yet its norm (4/13 = 0.31) is inside the 0.34 bar. It is now an INDEX
    // rather than a per-entry test — see genericsNear().
    for (const bucket of genericsNear(q.length, th)) {
      for (const g of bucket) {
        // exclude: the drug being read back — a denial that repeats it ("not
        // Metformin, Atenolol") must resolve to the OTHER drug, not echo the
        // one the caller just rejected.
        if (exclude && g.term === exclude) continue;
        const span = q.length > g.lc.length ? q.length : g.lc.length;
        const d = lev(q, g.lc, th * span);
        const norm = d / span;
        if (norm <= th && (!best || norm < best.norm)) {
          best = { surface: q, canonical: g.term, norm, score: +(1 - norm).toFixed(3) };
        }
      }
    }
  }
  if (best) {
    return { mentioned: true, surface: best.surface, canonical: best.canonical, score: best.score };
  }
  // No generic matched. The 116k brand index can go further — but ONLY when the
  // caller is answering a question about medicines.
  //
  // MEASURED, AND THE REASON THIS IS OPT-IN: run ungated over 4,675 real
  // Marathi sentences the brand index produced a 29.8% false-positive rate
  // against a 1% kill criterion. Indian brand names are short, invented-looking
  // and collide head-on with ordinary speech and place names — "limited" →
  // Limitex (602 hits), and लातूर/तेनाली/जन्य match brands EXACTLY because
  // those are registered product names. Ungated, this would have had Ritu ask a
  // caller to confirm they take "Latur".
  // Gated to the meds turn, the prior is completely different: the caller was
  // just asked "कोई दवाई चल रही है?" and is answering it. Callers that scan
  // free text (tools/secondPass.js, any transcript sweep) must NOT pass this.
  if (brands) {
    for (const { q, romanized, speculative } of cands) {
      if (q.length < 4 || isNoiseStandalone(q)) continue;
      // SPECULATIVE VARIANTS NEVER REACH THE BRAND INDEX. Measured: admitting
      // them here took false positives 0.90 -> 3.49 even at a 0.12 bar —
      // WORSE than the 2.93 the loose rules produced, which is what showed the
      // threshold was never the problem. A guessed transliteration checked
      // against 116k registered brand names will find a near-exact collision
      // by chance; the note above already says fuzzy brand matching on
      // approximate romanization is where the collisions live, and a
      // speculative variant is approximate romanization twice over.
      // They earn a look at the ~1,751 generic molecules and nothing more.
      //
      // RETRIED 2026-08-06 AS "EXACT ONLY, NEVER FUZZY" AND BLOCKED AGAIN.
      // The argument was that the measurement above used a 0.12 FUZZY bar, so
      // exact-only is a different claim — ग्लाइकोमेट yields `glycomet`, which
      // is an exact key in the index, and it was being thrown away. Measured:
      //     recall              35.50 → 38.57   +3.07   the biggest gain yet
      //     drug_false_positive  0.43 →  3.02   +2.59   HARD FAIL, 7x worse
      //     fp_codemix_stt       0.94 →  3.99   +3.05   HARD FAIL
      //     130+ items flipped, including SEVEN canaries
      // Exact-only is NOT different enough. The guess space of three chained
      // substitutions is large and the 116k index is dense, so a guessed
      // spelling lands on SOME real brand exactly, by chance, often. This is
      // the third time this lever has been tried (loose rules, tighter bar,
      // exact-only) and the third time the FP arms have refused it.
      // The molecules it would have won are reachable safely as exact aliases —
      // ग्लाइकोमेट is in TRANSLIT_ALIAS for that reason.
      if (speculative) continue;
      // Romanized candidates may consult the brand index but only for an EXACT
      // hit. Devanagari brand names are common and must resolve (टेल्मा →
      // telma → Telmisartan), but FUZZY brand matching on approximate
      // romanization is where the collisions live — an exact string equality
      // after a lossy transform is still strong evidence, a near-miss is not.
      if (romanized && (!BRANDS[q] || BRAND_BLOCKLIST.has(q))) continue;
      const b = findBrand(q);
      if (b && (!exclude || b.generic !== exclude)) {
        return { mentioned: true, surface: q, canonical: b.generic, brand: b.brand, viaBrand: true, score: b.score };
      }
    }
  }
  return { mentioned: false };
}

// findAllDrugMentions(text, opts) → [{ surface, canonical, brand?, score }, …]
//
// MEASURED (Eka clinical corpus): 786 of 814 gold drug mentions — 96.6% — sit
// in utterances that name MORE THAN ONE drug. findDrugMention returns the
// single best match, so on a real clinical sentence we recorded one medicine
// and silently dropped the rest. A patient saying "Dolo aur Telma dono leta
// hun" lost one of them, every time. That single-match ceiling, not the
// vocabulary, was the largest remaining gap in drug capture.
//
// Scans every candidate independently and keeps each DISTINCT molecule, best
// score per molecule. Ordered by score so the caller can read back the most
// confident first. Same guards as findDrugMention: NOT_A_DRUG applies, and the
// 116k brand index is consulted only when `brands` is set (the meds turn).
function findAllDrugMentions(text, opts = {}) {
  const { maxNormDist = 0.34, brands = false, max = 6, prior = null } = opts;
  const cands = buildCandidates(text);

  const found = new Map(); // canonical → best hit
  const keep = (hit) => {
    // Renamed from `prior`, which now means the caller's own medication list.
    const existing = found.get(hit.canonical);
    if (!existing || hit.score > existing.score) found.set(hit.canonical, hit);
  };

  // This caller's own molecules, at the looser bar a tiny candidate set earns.
  // Kept alongside the general matches rather than short-circuiting: a patient
  // on Metformin may well name a second, new drug in the same breath, and
  // returning only the prior would lose it.
  if (Array.isArray(prior) && prior.length) {
    const p = _matchPrior(cands, prior, null);
    if (p) keep({ surface: p.surface, canonical: p.canonical, score: p.score, viaPrior: true });
  }

  for (const { q } of cands) {
    const canonical = ALIAS_LC.get(q);
    if (canonical) keep({ surface: q, canonical, score: 1, viaAlias: true });
  }

  for (const { q, romanized, speculative, aliasOnly } of cands) {
    if (ALIAS_LC.has(q)) continue;        // already resolved exactly, above
    if (isNoiseStandalone(q)) continue;
    if (aliasOnly) {
      // PARITY WITH findDrugMention (2026-08-08). An aliasOnly candidate — a
      // join across a noise word — is too weak for FUZZY matching and stays
      // barred from the generic loop below. But findDrugMention grants it an
      // EXACT brand-index look, and this function granted it nothing:
      //
      //     findDrugMention("पैन डी")      -> Pantoprazole  (viaBrand, score 1)
      //     findAllDrugMentions("पैन डी")  -> []
      //
      // "पैन डी" romanizes to `pandi`, an exact key in the 116k index. Pan-D is
      // among the most-prescribed drugs in India, and a patient naming it had
      // it silently dropped — findAllDrugMentions is the meds-turn path.
      //
      // It also poisoned the METRIC. entity-recall.js resolves the DENOMINATOR
      // with findDrugMention and the NUMERATOR with findAllDrugMentions, so
      // anything in this gap is counted as gold and can never be recovered —
      // not by a better model, not by a perfect transcript. MEASURED: 5 of 814
      // gold spans, every one of them the Pan-D family.
      //
      // Same rule, same guards, no fuzzy: exact BRANDS key required for a
      // romanized candidate, blocklist honoured, speculative still refused
      // (that lever has been measured and rejected three times — see the note
      // in findDrugMention's brand tier).
      if (brands && q.length >= 4 && !speculative &&
          !(romanized && (!BRANDS[q] || BRAND_BLOCKLIST.has(q)))) {
        const b = findBrand(q);
        if (b) keep({ surface: q, canonical: b.generic, brand: b.brand, viaBrand: true, score: b.score });
      }
      continue;
    }
    const th = speculative ? SPECULATIVE_MAX_DIST : romanized ? ROMAN_MAX_DIST : maxNormDist;
    let bestForQ = null;
    for (const bucket of genericsNear(q.length, th)) {
      for (const g of bucket) {
        const span = q.length > g.lc.length ? q.length : g.lc.length;
        const norm = lev(q, g.lc, th * span) / span;
        if (norm <= th && (!bestForQ || norm < bestForQ.norm)) {
          bestForQ = { surface: q, canonical: g.term, norm, score: +(1 - norm).toFixed(3) };
        }
      }
    }
    if (bestForQ) { keep({ surface: bestForQ.surface, canonical: bestForQ.canonical, score: bestForQ.score }); continue; }
    // SPECULATIVE CANDIDATES NEVER REACH THE BRAND INDEX — the same rule
    // findDrugMention has carried since 2026-08-05, which this function did not.
    // The asymmetry was live and costly: दवाई — the Hindi word for MEDICINE,
    // which every patient says — speculates to "davi", and BRANDS['davi'] is
    // Dapagliflozin, an exact hit at score 1.0 that no distance cap can refuse.
    //     "कोई दवाई नहीं"       (no medicines at all)  -> Dapagliflozin
    //     "हाँ एक दवाई चल रही है" (yes I take a medicine) -> Dapagliflozin
    // Two harms, and the quieter one is worse. At callHandler.js:3279 the
    // phantom drug is captured and read back, so an agreeable "हाँ" writes an
    // SGLT2 diabetes drug into a healthy patient's record. At :3394 the meds
    // stage sees "a drug was named" and ADVANCES — discarding the real medicine
    // the patient gives in the very next sentence, on every call.
    //
    // MEASURED 2026-08-06, when the reverse change was tried on findDrugMention:
    // letting speculative variants hit the brand index took drug_false_positive
    // 0.43 -> 3.02 and fp_codemix_stt 0.94 -> 3.99, flipping seven canaries. One
    // matcher was blocked on that evidence; this one kept running the
    // configuration the suite had already measured as seven times worse.
    if (brands && q.length >= 4 && !speculative && !(romanized && (!BRANDS[q] || BRAND_BLOCKLIST.has(q)))) {
      const b = findBrand(q);
      if (b) keep({ surface: q, canonical: b.generic, brand: b.brand, viaBrand: true, score: b.score });
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, max);
}

// ── Unresolved drug-like token (live 2026-07-24) ────────────────────────────
// Caller said "Metformin"; the 8kHz line + STT snapped it to "Metamorphosin" —
// 6 edits from ANY NLEM generic (norm 0.46), unrecoverable by matching. At that
// distance a guessed read-back is DANGEROUS: an agreeable caller saying "haan"
// to the wrong drug manufactures the very error read-back exists to prevent.
// Instead, DETECT the situation: a long Latin token in a meds answer that
// resolves to nothing is almost certainly a drug name we mangled — worth one
// "say just the name again, slowly" turn (an isolated word transcribes far
// better than a mid-sentence one).
// Stoplist = non-drug Latin words that plausibly appear in codemix meds
// answers; drug names that ARE resolvable never reach this check.
const MED_STOPWORDS = new Set([
  // CLINIC-VISIT VOCABULARY, completing a list that already held `doctor`,
  // `appointment`, `clinic` and `hospital`. These are what a patient says about
  // WHY they are calling, never a mangled drug name — and every one of them is
  // 6+ Latin characters, so each was one utterance away from "I did not catch
  // the medicine name". Found by driving the guard rather than reading it:
  // "dental checkup karana hai" fired on `checkup`.
  'checkup', 'checkups', 'consultation', 'treatment', 'cleaning',
  'followup', 'report', 'reports', 'surgery', 'operation', 'session', 'visiting',

  'tablet', 'tablets', 'capsule', 'capsules', 'medicine', 'medicines',
  'doctor', 'morning', 'evening', 'night', 'weekly', 'monthly', 'daily',
  'pressure', 'thyroid', 'vitamin', 'injection', 'allergy', 'allergic',
  'nothing', 'available', 'appointment', 'normal', 'regular', 'running',
  'taking', 'before', 'after', 'years', 'months', 'hospital', 'clinic',
  'dawai', 'dawaiyan', 'goliyan', 'chalti', 'chalrahi',
  'powder', 'course', 'problem', 'sometimes', 'already', 'please',
  // Number/duration words (live 2026-07-24: a duration answer "ten to twelve
  // hours" got misrouted to the meds stage and "twelve" fired a false
  // name re-ask). Only ≥6-letter forms matter — the detector regex is {6,}.
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'ninety',
  'seventy', 'eighty', 'hundred', 'thousand', 'couple', 'several',
  'around', 'almost', 'nearly', 'approximately', 'minutes', 'seconds',
  'tonight', 'yesterday', 'tomorrow', 'earlier',
  // Symptom/common conversation words plausible in a misrouted answer.
  'headache', 'stomach', 'breathing', 'vomiting', 'coughing', 'fatigue',
  'dizziness', 'swelling', 'infection', 'diabetes', 'severe', 'paining',
  'painful', 'feeling', 'having', 'trouble', 'issues', 'started',
  'starting', 'happened', 'happening', 'actually', 'really', 'thanks',
  'little', 'anything', 'something', 'someone', 'because', 'address',
  'number', 'english', 'speaking', 'nothing',
  // Device/app words seen in real Latin-script STT output (MUCS 2026-07-25):
  // short script-switched lines like "mobile restart कर" slip under the
  // Latin-sentence rule, so the frequent offenders are named directly.
  'mobile', 'restart', 'uninstall', 'install', 'update', 'download',
  'whatsapp', 'message', 'contact', 'battery', 'screen', 'volume',
]);
// SCRIPT-SWITCH GUARD (MEASURED 2026-07-25, MUCS Marathi n=400): when Sarvam
// auto-detect mis-tags Marathi audio as en-IN — 14.5% of utterances, ALWAYS at
// language_probability 1.0 — it returns the whole line TRANSLITERATED/translated
// into Latin ("HDFC Bank share analysis show कर"). The words are usually
// correct; only the script is wrong. That breaks this detector badly: every
// English word in the line looks like an unrecognized drug name, so Ritu would
// ask a Marathi caller to slowly repeat "analysis" or "mobile" as a medicine.
// Rule: in a Devanagari-language call, a genuine drug mention is a Latin ISLAND
// inside Indic text ("हाँ वो Metformin की दवाई"). If the line is mostly Latin,
// the transcript itself is the failure — flag nothing and let the turn pass.
function _latinFraction(text) {
  const s = String(text || '');
  const dev = (s.match(/[ऀ-ॿಀ-೿਀-੿]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  if (!dev && !lat) return 0;
  return lat / (dev + lat);
}

function findUnresolvedMedToken(text, opts = {}) {
  const { expectIndic = false, maxLatinFraction = 0.6, minLatinWordsForSwitch = 3 } = opts;
  if (findDrugMention(text).mentioned) return null; // resolvable → normal read-back path
  // Script-switch artifact = a Latin SENTENCE, not a Latin island. Both
  // conditions required: mostly-Latin AND several Latin words. A mangled drug
  // name is 1-2 Latin tokens adrift in Indic text — live 2026-07-25 "आ
  // Metaphor scene" (Metformin) is 93% Latin by character but only 2 words,
  // and catching it is the whole point of this rung, so character fraction
  // alone must never decide.
  if (expectIndic && _latinFraction(text) > maxLatinFraction) {
    const latinWords = String(text || '').match(/[A-Za-z]{3,}/g) || [];
    if (latinWords.length >= minLatinWordsForSwitch) return null;
  }
  const latin = String(text || '').toLowerCase().match(/[a-z]{6,}/g) || [];
  for (const tok of latin) {
    if (MED_STOPWORDS.has(tok)) continue;
    // A SPECIALTY OR BODY PART IS NOT A MANGLED DRUG NAME. Live 2026-08-08:
    // "मुझे dentist" was answered with "I did not catch the MEDICINE NAME —
    // say just the medicine name", and the patient spent two turns explaining
    // he wanted his teeth looked at. MED_STOPWORDS already held `doctor` and
    // `appointment`, so this class was known; `dentist` was simply missing.
    // tools/symptomMapping.js already owns dentist/dental/tooth/teeth/molar/
    // gum/cavity for the roster slice, so consulting it closes the class
    // rather than adding a 118th word to chase the next one.
    //
    // COLLISIONS MEASURED, NOT REASONED ABOUT: all 117,968 names in
    // drug_brands.json + drug_generics.json were pushed through
    // specialtiesForSymptom; 25 collide, `insulin` among them. Driven through
    // this function, "main insulin leta hoon" stops being re-asked AND
    // findAllDrugMentions still returns Human insulin — so the guard steps
    // back only where the meds path already succeeds. tests/
    // test-unresolved-med-token.js asserts both halves, and fails loudly if
    // that ever stops being true.
    if (specialtiesForSymptom(tok).length) continue;
    return { token: tok };
  }
  return null;
}

// ── Spoken time expressions (the datetime half of the gold loop) ───────────
// MEASURED CONTEXT: medicines come up in ~5% of calls, but a date/time comes up
// in EVERY booking call. Ritu already speaks the resolved time in her booking
// confirmation ("...आज शाम 7 बजे बुक कर दिया है"), so the caller's "हाँ" is
// ALREADY a read-back confirmation — it was simply never recorded. Capturing it
// costs no extra turn and no latency, and yields ~10x the labelled pairs of the
// medicines path.
// What the pair teaches us: how real callers actually phrase times on an 8kHz
// line ("साडेसात", "उद्या सकाळी", "shaam ko saat baje") and whether our
// resolution to a concrete ISO slot was right. That is the entity most likely
// to send a patient to the clinic on the wrong day.
const TIME_PATTERNS = [
  // clock times: "7 बजे", "साढ़े सात", "7:30", "seven o'clock", "7 pm"
  /\b\d{1,2}[:.]\d{2}\s*(?:am|pm)?/i,
  /\b\d{1,2}\s*(?:am|pm)\b/i,
  /\d{1,2}\s*(?:बजे|वाजता|ಗಂಟೆ|baje|vajta)/i,
  /(?:साढ़े|साडे|सवा|पौने|पाउण)\s*\S+/,
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:o'?clock|am|pm)\b/i,
  // day words
  /(?:आज|कल|परसों|उद्या|परवा|आत्ता|ಇಂದು|ನಾಳೆ)/,
  /\b(?:today|tomorrow|day after tomorrow|tonight)\b/i,
  // day parts
  /(?:सुबह|सकाळी|दोपहर|दुपारी|शाम|संध्याकाळी|रात|रात्री|ಬೆಳಿಗ್ಗೆ|ಸಂಜೆ)/,
  /\b(?:morning|afternoon|evening|night)\b/i,
  // weekdays
  /(?:सोमवार|मंगळवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार)/,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
];

// extractTimeExpression(text) → { expression } | null
// Returns the caller's time-bearing phrase(s), joined — the SURFACE half of a
// datetime gold pair. Deliberately greedy-ish: we want what they said, not a
// parse. Resolution to an actual slot is the LLM/booking tool's job; this only
// records what the human uttered so the pair can be scored later.
function extractTimeExpression(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const hits = [];
  for (const re of TIME_PATTERNS) {
    const m = s.match(re);
    if (m && m[0]) {
      const frag = m[0].trim();
      if (frag && !hits.includes(frag)) hits.push(frag);
    }
  }
  if (!hits.length) return null;
  return { expression: hits.join(' ').replace(/\s+/g, ' ').trim() };
}

// Read-back phrasing. entityType: 'meds' | 'allergy'. Clinic's live languages
// get native copy; others fall back to Hindi (never blocks — worst case the
// caller hears the Hindi confirm, still a valid read-back).
const READBACK = {
  // ─── THIS TABLE SPOKE FOUR OF ELEVEN LANGUAGES ────────────────────────────
  // readbackLine falls back to hi-IN for any language it lacks, and the caller
  // then hands that DEVANAGARI string to TTS with the CALLER'S pinned language
  // code. So a Bengali caller was asked to confirm their medication in Hindi,
  // synthesised by the Bengali voice — on the one turn where a mis-heard "yes"
  // writes a wrong drug into a clinical record.
  //
  // The in-file note said "worst case the caller hears the Hindi confirm", and
  // that was true when the product spoke three languages. ENABLE_MULTILINGUAL
  // made it eleven, and every other spoken table was extended (HISTORY_ASK_*,
  // BUSY_GOODBYE, FALLBACK_LINE, CRITICAL_ERROR_MESSAGE, all of CANNED_LINES).
  // Read-back was the one left behind — the clinical one.
  meds: {
    'hi-IN': v => `आप ${v} ले रहे हैं — मैंने सही सुना ना?`,
    'mr-IN': v => `तुम्ही ${v} घेताय — मी बरोबर ऐकलं ना?`,
    'kn-IN': v => `ನೀವು ${v} ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದ್ದೀರಾ — ನಾನು ಸರಿಯಾಗಿ ಕೇಳಿಸಿಕೊಂಡೆನಾ?`,
    'en-IN': v => `You're taking ${v} — did I hear that right?`,
    'pa-IN': v => `ਤੁਸੀਂ ${v} ਲੈ ਰਹੇ ਹੋ — ਮੈਂ ਸਹੀ ਸੁਣਿਆ ਨਾ?`,
    'ta-IN': v => `நீங்கள் ${v} எடுத்துக்கொள்கிறீர்கள் — நான் சரியாகக் கேட்டேனா?`,
    'te-IN': v => `మీరు ${v} తీసుకుంటున్నారు — నేను సరిగ్గా విన్నానా?`,
    'bn-IN': v => `আপনি ${v} নিচ্ছেন — আমি ঠিক শুনলাম তো?`,
    'gu-IN': v => `તમે ${v} લઈ રહ્યા છો — મેં બરાબર સાંભળ્યું ને?`,
    'ml-IN': v => `നിങ്ങൾ ${v} കഴിക്കുന്നു — ഞാൻ ശരിയായി കേട്ടോ?`,
    'od-IN': v => `ଆପଣ ${v} ନେଉଛନ୍ତି — ମୁଁ ଠିକ୍ ଶୁଣିଲି ତ?`,
  },
  // TWO drugs in one turn. MEASURED: 786 of 814 gold mentions (96.6%) sit in
  // utterances naming more than one drug, and the single-best matcher recovers
  // 40.3% of resolvable mentions against findAllDrugMentions' 78.3% — on the
  // same audio, same decode. The gap was never vocabulary; it was that we asked
  // about one drug and dropped the rest.
  //
  // Capped at TWO on purpose. This is a compound question, and a compound
  // question is exactly the defect the meds prompt already has ("दवाई चल रही है
  // या एलर्जी है?"): one "हाँ" cannot cleanly confirm two facts. Two is the most
  // a caller can hold and answer honestly in one breath on an 8kHz line — and
  // the second drug is recorded with its own weaker resolution rather than
  // inheriting the first one's confirmation.
  meds2: {
    'hi-IN': (a, b) => `आप ${a} और ${b} ले रहे हैं — मैंने सही सुना ना?`,
    'mr-IN': (a, b) => `तुम्ही ${a} आणि ${b} घेताय — मी बरोबर ऐकलं ना?`,
    'kn-IN': (a, b) => `ನೀವು ${a} ಮತ್ತು ${b} ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದ್ದೀರಾ — ನಾನು ಸರಿಯಾಗಿ ಕೇಳಿಸಿಕೊಂಡೆನಾ?`,
    'en-IN': (a, b) => `You're taking ${a} and ${b} — did I hear that right?`,
    'pa-IN': (a, b) => `ਤੁਸੀਂ ${a} ਅਤੇ ${b} ਲੈ ਰਹੇ ਹੋ — ਮੈਂ ਸਹੀ ਸੁਣਿਆ ਨਾ?`,
    'ta-IN': (a, b) => `நீங்கள் ${a} மற்றும் ${b} எடுத்துக்கொள்கிறீர்கள் — நான் சரியாகக் கேட்டேனா?`,
    'te-IN': (a, b) => `మీరు ${a} మరియు ${b} తీసుకుంటున్నారు — నేను సరిగ్గా విన్నానా?`,
    'bn-IN': (a, b) => `আপনি ${a} এবং ${b} নিচ্ছেন — আমি ঠিক শুনলাম তো?`,
    'gu-IN': (a, b) => `તમે ${a} અને ${b} લઈ રહ્યા છો — મેં બરાબર સાંભળ્યું ને?`,
    'ml-IN': (a, b) => `നിങ്ങൾ ${a}, ${b} എന്നിവ കഴിക്കുന്നു — ഞാൻ ശരിയായി കേട്ടോ?`,
    'od-IN': (a, b) => `ଆପଣ ${a} ଏବଂ ${b} ନେଉଛନ୍ତି — ମୁଁ ଠିକ୍ ଶୁଣିଲି ତ?`,
  },
  allergy: {
    'hi-IN': v => `आपको ${v} से एलर्जी है — सही?`,
    'mr-IN': v => `तुम्हाला ${v} ची एलर्जी आहे — बरोबर?`,
    'kn-IN': v => `ನಿಮಗೆ ${v} ನಿಂದ ಅಲರ್ಜಿ ಇದೆ — ಸರಿಯೇ?`,
    'en-IN': v => `You're allergic to ${v} — is that right?`,
    'pa-IN': v => `ਤੁਹਾਨੂੰ ${v} ਤੋਂ ਐਲਰਜੀ ਹੈ — ਸਹੀ?`,
    'ta-IN': v => `உங்களுக்கு ${v} அலர்ஜி இருக்கிறது — சரியா?`,
    'te-IN': v => `మీకు ${v} అలర్జీ ఉంది — సరియేనా?`,
    'bn-IN': v => `আপনার ${v}-এ অ্যালার্জি আছে — ঠিক?`,
    'gu-IN': v => `તમને ${v} ની એલર્જી છે — બરાબર?`,
    'ml-IN': v => `നിങ്ങൾക്ക് ${v} അലർജി ഉണ്ട് — ശരിയാണോ?`,
    'od-IN': v => `ଆପଣଙ୍କୁ ${v} ଆଲର୍ଜି ଅଛି — ଠିକ୍?`,
  },
};
// readbackLine('meds', 'Dolo', 'hi-IN')            → one drug
// readbackLine('meds2', 'Dolo', 'hi-IN', 'Telma')  → two in one turn
function readbackLine(entityType, value, langCode, value2) {
  const t = READBACK[entityType] || READBACK.meds;
  return (t[langCode] || t['hi-IN'])(value, value2);
}

// classifyReply(text) → { verdict, correction, affirmStrength }
// affirmStrength: 'bare' | 'substantive' — see the note at affirmStrength below.
// Without speaker diarization (unavailable on this socket) it is the only
// honest signal for how much a 'हाँ' is worth.
// correction = a drug mention found in a denial ("नहीं, Amlodipine").
// ─── ASKING IN ELEVEN LANGUAGES AND UNDERSTANDING FOUR ─────────────────────
// The READBACK copy above was the visible half of this gap; these lists are the
// half that decides what gets WRITTEN. Both were hi/mr/kn/en only, so on a
// Bengali call:
//
//   "হ্যাঁ"  (yes) matched nothing -> verdict 'unclear', the drug not confirmed
//   "না"    (no)  matched nothing -> verdict 'unclear', A WRONG DRUG STAYS ON
//                                     THE RECORD because the denial was not heard
//
// The second is the one that matters. Tokenization was never the problem —
// classifyReply splits on [a-zऀ-ൿ], which spans U+0900-U+0D7F and therefore
// every Brahmic block we speak. Only the vocabularies were short.
//
// THE TWO LISTS ARE NOT SYMMETRIC, DELIBERATELY. A missed DENY leaves a
// mis-heard medication in a clinical record; a false DENY merely discards a
// correct one, and we ask again. A missed AFFIRM costs a confirmation; a false
// AFFIRM marks a WRONG drug as verified and emits it as [READBACK-GOLD], a
// training label. So DENY is generous and AFFIRM is conservative.
//
// Devanagari "ना" is deliberately NOT in DENY: it is the tag question in our own
// read-back ("सही सुना ना?") and in "हाँ ना" it means yes. The other scripts'
// denial words carry no such collision, so they are listed.
const AFFIRM = ['haan', 'han', 'ha', 'ji', 'sahi', 'theek', 'thik', 'bilkul', 'yes', 'yeah', 'right', 'correct', 'हाँ', 'हां', 'जी', 'सही', 'ठीक', 'बिल्कुल', 'बरोबर', 'होय', 'ಸರಿ', 'ಹೌದು',
  'ਹਾਂ', 'ਜੀ', 'ਸਹੀ', 'ਠੀਕ', 'ਬਿਲਕੁਲ',            // Punjabi
  'ஆம்', 'ஆமா', 'ஆமாம்', 'சரி',                    // Tamil
  'అవును', 'ఔను', 'సరే', 'సరి',                    // Telugu
  'হ্যাঁ', 'হ্যা', 'হ্যাঁজি', 'ঠিক', 'ঠিকই',        // Bengali
  'હા', 'હાં', 'બરાબર', 'ઠીક',                     // Gujarati
  'അതെ', 'ഉവ്വ്', 'ശരി',                           // Malayalam
  'ହଁ', 'ହଉ', 'ଠିକ୍', 'ଠିକ',                        // Odia
];
// 'not'/'don'/'isn': live 2026-07-24 — "I am not on any medicine" classified
// unclear because only 'no' was listed. The tokenizer splits "don't"/"isn't"
// into don/t, isn/t, so the bare stems are the matchable forms.
const DENY = ['nahi', 'nahin', 'nai', 'no', 'not', 'nope', 'dont', 'isnt', 'galat', 'wrong', 'नहीं', 'नही', 'गलत', 'चूक', 'नाही', 'ತಪ್ಪು', 'ಇಲ್ಲ',
  'ਨਹੀਂ', 'ਨਹੀ', 'ਗਲਤ',                            // Punjabi
  'இல்லை', 'இல்ல', 'தவறு',                          // Tamil
  'లేదు', 'కాదు', 'తప్పు',                          // Telugu
  'না', 'নেই', 'ভুল',                               // Bengali
  'ના', 'નથી', 'ખોટું',                              // Gujarati
  'ഇല്ല', 'അല്ല', 'തെറ്റ്',                           // Malayalam
  'ନା', 'ନାହିଁ', 'ଭୁଲ',                              // Odia
];
const DONTKNOW = ['pata nahi', 'nahi pata', 'nahi maloom', 'malum nahi', 'dont know', 'not sure', 'yaad nahi', 'पता नहीं', 'नहीं पता', 'नहीं मालूम', 'माहित नाही', 'याद नहीं',
  'ਪਤਾ ਨਹੀਂ', 'ਯਾਦ ਨਹੀਂ',                          // Punjabi
  'தெரியாது', 'நினைவில்லை',                         // Tamil
  'తెలియదు', 'గుర్తులేదు',                           // Telugu
  'জানি না', 'মনে নেই',                             // Bengali
  'ખબર નથી', 'યાદ નથી',                             // Gujarati
  'അറിയില്ല', 'ഓർമ്മയില്ല',                          // Malayalam
  'ଜଣା ନାହିଁ', 'ମନେ ନାହିଁ',                          // Odia
  'ಗೊತ್ತಿಲ್ಲ', 'ನೆನಪಿಲ್ಲ',                            // Kannada — also absent before
];

// excludeCanonical: the drug currently being read back — passed by
// stepReadback so a denial that repeats the rejected name ("not Metformin,
// it's Atenolol") resolves the correction to the OTHER drug.
function classifyReply(text, excludeCanonical = null, opts = {}) {
  const { brands = false } = opts;
  // Strip apostrophes so "don't"/"isn't" normalize to dont/isnt for both the
  // phrase check ("dont know") and word tokenization.
  const raw = String(text || '').toLowerCase().replace(/[’'']/g, '').trim();
  if (!raw) return { verdict: 'unclear', correction: null, affirmStrength: null };
  if (DONTKNOW.some(p => raw.includes(p.toLowerCase()))) return { verdict: 'unclear', correction: null, affirmStrength: null };
  const words = raw.match(/[a-zऀ-ൿ]+/gu) || [];
  const wset = new Set(words);
  // Whole-WORD membership only — substring matching made 'ha' hit inside "hai"
  // and 'ji' inside many words, mislabelling a clean denial as mixed.
  const hasAffirm = AFFIRM.some(a => wset.has(a));
  const hasDeny = DENY.some(d => wset.has(d));

  // ─── HOW MUCH IS THIS "हाँ" WORTH? ──────────────────────────────────────
  // Sarvam documents speaker diarization as unavailable on the streaming
  // socket — DOC: "Always null over the WebSocket API — diarization is not
  // supported for streaming; use the Batch API." So we cannot know WHO spoke,
  // on v3 or v4; it is a property of the endpoint, not the model.
  //
  // On an Indian clinic call that matters. A daughter dials for her mother and
  // both talk; a relative in the room says "हाँ" while Ritu is reading back a
  // medicine. Today any affirm token anywhere in the reply marks the drug
  // VERIFIED and emits it as [READBACK-GOLD] — a training label. One agreeable
  // syllable from an unidentified voice becomes both a clinical fact and gold
  // data.
  //
  // Without speaker identity the honest discriminator is CONTENT, not voice.
  // A caller who repeats the molecule, or answers with substance, is agreeing
  // to something specific. A bare "हाँ" agrees to whatever was just said, by
  // whoever happened to say it. That distinction is available in the text and
  // needs no vendor feature.
  //
  // This does NOT reject bare affirms — most people simply say "हाँ", and
  // refusing them would gut capture to chase a rarer harm. It labels them, so
  // the caller can decide what a bare agreement is good enough FOR. Recording
  // a medication: yes. Becoming a training label: no.
  const nonAffirm = words.filter(w => !AFFIRM.includes(w) && !DENY.includes(w));
  // Substantive = agrees AND says something of its own. Two content words is a
  // low bar on purpose; the point is to separate "हाँ" from "हाँ वो मेटफॉर्मिन
  // वाली", not to grade eloquence.
  const affirmStrength = !hasAffirm ? null
    : (nonAffirm.length >= 2 ? 'substantive' : 'bare');
  if (hasDeny && !hasAffirm) {
    // A denial may carry a CORRECTION ("not X, it's Y"). But NEVER promote a
    // junk near-match just because we excluded the pending drug — that
    // manufactures a wrong [VERIFIED] medication (live-panel 2026-07-24:
    // pending Cetirizine + "nahi nahi cetrizine hi hai" was "corrected" to
    // Cetrimide, a topical antiseptic). Two-stage:
    //   1. What did they actually SAY (no exclude)? If the best match is a
    //      DIFFERENT drug than the pending one, that's a real correction.
    //   2. If the best match IS the pending drug (they repeated it), a genuine
    //      "not X, Y" correction needs a SECOND, CONFIDENTLY-matched different
    //      drug (strict threshold) — otherwise it's a bare denial, correct
    //      nothing.
    // A CORRECTION OFTEN RESTATES THE WHOLE LIST, not a single replacement.
    // Live 2026-07-27, call d487e311: we read back "Dolo और Tetracaine"; the
    // caller answered "नहीं नहीं Dolo और Cetirizine" — naming TWO drugs — and
    // we recorded only Cetirizine. Dolo was dropped in the one turn where the
    // caller was explicitly telling us what they actually take. Same
    // single-best-match defect that capped the read-back itself, one function
    // over.
    //
    // brands matters here for the same reason it does on the meds turn: the
    // caller is answering a question about medicines, and "Dolo" is a brand —
    // without the index it cannot match at all, so the multi-drug fix would be
    // dead on arrival. Off by default; stepReadback opts in.
    const named = findAllDrugMentions(text, { brands, max: 3 });
    const different = named.filter((d) => d.canonical !== excludeCanonical);
    let correction = null;
    let corrections = [];
    if (different.length) {
      correction = different[0].canonical;
      // Everything they named, INCLUDING a repeat of the pending drug — if they
      // say "no, Dolo and Cetirizine" they are confirming Dolo, not denying it.
      // Only ever alongside a genuine correction, never on its own: a bare
      // repeat of the pending drug is a denial, handled by the branch below.
      corrections = named.map((d) => d.canonical);
    } else if (excludeCanonical) {
      // They repeated the pending drug and named nothing else. A genuine
      // "not X, Y" now needs a SECOND, CONFIDENTLY-matched different drug —
      // the 0.2 bar that stops "nahi nahi cetrizine hi hai" being "corrected"
      // to Cetrimide, a topical antiseptic (live-panel 2026-07-24).
      const other = findDrugMention(text, { exclude: excludeCanonical, maxNormDist: 0.2 });
      if (other.mentioned) { correction = other.canonical; corrections = [other.canonical]; }
    }
    return { verdict: 'deny', correction, corrections, affirmStrength: null };
  }
  if (hasAffirm && !hasDeny) return { verdict: 'affirm', correction: null, affirmStrength };
  // Affirm + a deny-family word together is usually "yes — and I don't take
  // anything ELSE" (a confirmation, not a mixed signal). If the deny sits in
  // an "…else / anything / any other / nothing more" tail, read it as affirm
  // so the gold label isn't lost. Otherwise genuinely mixed → unclear.
  if (hasAffirm && hasDeny && /\b(anything|any\s+other|nothing|something)\b|\belse\b|\bmore\b|\b(aur|kuch|baaki|dusr|dusar)\b|और कुछ|कुछ और|कुछ नहीं|बाकी|दुसर/i.test(raw)) {
    return { verdict: 'affirm', correction: null, affirmStrength };
  }
  return { verdict: 'unclear', correction: null, affirmStrength: null };
}

// ── The read-back turn's decision step (pure, offline-testable) ─────────────
// callHandler speaks readbackLine(...) and sets pending = {type, canonical,
// surface}. The caller's NEXT reply (voice transcript, or '1'/'2' via DTMF)
// comes here; the resolution tells callHandler what to record and whether to
// speak anything else. Fail-open: 'unclear' proceeds WITHOUT confirmation
// (logged) — a read-back must never trap the call.
//   → { resolution: 'affirmed'|'corrected'|'denied'|'unclear',
//       med,            // the entity to record (canonical, or the correction)
//       verified,       // true only on 'affirmed'/'corrected' (gold label)
//       reAsk }         // true on bare 'denied' → re-ask the meds question once
function stepReadback(pending, replyText) {
  if (!pending) return { resolution: 'unclear', med: null, verified: false, reAsk: false };
  const t = String(replyText || '').trim();
  // med2 here too: a keypad "1" confirms the SPOKEN line, and if that line named
  // two drugs it confirms both exactly as a voiced "हाँ" would. Omitting it made
  // the keypad silently worse than speaking — caught by the multi-drug test.
  if (t === '1') return { resolution: 'affirmed', med: pending.canonical, med2: pending.second ? pending.second.canonical : null, verified: true, reAsk: false };
  if (t === '2') return { resolution: 'denied', med: null, verified: false, reAsk: true };
  // brands:true — this reply IS the answer to a medicines question, the same
  // context that gates the index on the meds turn itself. Without it a caller
  // correcting us with a BRAND ("नहीं नहीं Dolo और Cetirizine") cannot have
  // that brand matched at all.
  const r = classifyReply(t, pending.canonical, { brands: true });
  if (r.verdict === 'affirm') {
    // An affirm confirms the whole read-back, including the second drug if one
    // was spoken — but the second stays weaker evidence, see meds2 in READBACK.
    // affirmStrength rides along so the caller can distinguish "the patient
    // repeated the molecule" from "somebody in the room said हाँ". Still
    // verified: refusing a bare affirm would gut capture, and the drug was
    // named by someone on a medical call. What changes is what it is good
    // enough FOR — see the gold-harvest gate in callHandler.
    return {
      resolution: 'affirmed', med: pending.canonical,
      med2: pending.second ? pending.second.canonical : null,
      verified: true, reAsk: false,
      affirmStrength: r.affirmStrength || null,
    };
  }
  if (r.verdict === 'deny' && r.correction) {
    // meds2 = a SECOND drug the caller named in the same correction. It is not
    // a guess we made — they said it — so it carries the same weight as the
    // first, unlike the compound-affirm case.
    const extra = (r.corrections || []).filter((c) => c !== r.correction);
    return { resolution: 'corrected', med: r.correction, med2: extra.length ? extra[0] : null, verified: true, reAsk: false };
  }
  if (r.verdict === 'deny') return { resolution: 'denied', med: null, verified: false, reAsk: true };
  return { resolution: 'unclear', med: pending.canonical, verified: false, reAsk: false };
}

module.exports = { findDrugMention, findAllDrugMentions, findUnresolvedMedToken, extractTimeExpression, readbackLine, classifyReply, stepReadback, _latinFraction, _generics: GENERICS, _lev: lev };
