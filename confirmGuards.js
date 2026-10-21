// ═══════════════════════════════════════════════════════════════════════════
// FALSE-CONFIRMATION GUARDS (S3) — the "Ritu can never claim what didn't
// happen" regexes, extracted from brain-lean.js into a PURE module so the
// immune suite tests the LIVE patterns (no stale copies) and brain-lean just
// requires them. Zero requires. Tested against the frozen 46-item corpus
// (ritu-evals/data/false-confirm-corpus.json).
//
// Tense discipline (S7): past tense ("कर दी है") requires a committed action —
// a sentinel/DB row. Future ("कर दूंगी") is always safe. These regexes catch
// the model SPEAKING a completed claim when no sentinel fired; the caller
// suppresses the line and re-asks. Suppress-and-re-ask is cheap; a patient
// believing a booking exists that doesn't is not.
//
// FIX ROUND 2026-07-22 (corpus ids in brackets):
//   [fc05] appointment…कर दी window 14→28 chars ("कल शाम पाँच बजे" is 17)
//   [fc21] mr "निश्चित केली" (confirmed the visit) added
//   [fc29] kn sandhi "ಖಚಿತವಾಗಿದೆ" (single word) added
//   [fc06/07/40] NEW claimsSent — "भेज दी हैं / confirmation भेज दिया गया है /
//       I've sent the details": claiming a SEND that hasn't happened is the
//       same tense-discipline violation as a fake booking
//   [fc08/09] future forms no longer trigger: कर द(?!ू|ें) blocks
//       दूंगी/दूंगा/दूं/दूँ/देंगे ("कर दी/दिया" still match)
//   [fc25] mr failure report "बुक झाली नाही" no longer triggers (नाही guard)
//   [fc45] en "not cancelled" no longer triggers (lookbehind)
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const claimsCancelled = /कैंसि?ल कर द(?!ू|ें)|कैन्सल कर द(?!ू|ें)|रद्द कर द(?!ू|ें)|रद्द केल(?! ?नाही)|कॅन्सल केल(?! ?नाही)|रद्द केली(?! ?नाही)|(?<!not )(?<!isn'?t )cancell?ed|cancel kar (di|diy)|has been cancel|ರದ್ದು.{0,5}(ಮಾಡಿದ|ಆಗಿದೆ|ಆಯಿತು)|ರದ್ದಾಗಿದೆ|ਰੱਦ ਕਰ ਦਿੱਤ|ਕੈਂਸਲ ਕਰ ਦਿੱਤ|ரத்து செய்த|ரத்து செய்துவிட்ட|రద్దు (చేశ|చేసా|అయ)|বাতিল করে দিয়েছি|রদ করে দিয়েছি|રદ કરી દીધ|કૅન્સલ કરી દીધ|റദ്ദാക്ക|ବାତିଲ୍ କରିଦେ/i;

const claimsBooked = /हो गया|(?:बुक|पक्का|कन्फर्म) कर द(?!ू|ें)|अपॉइंटमेंट.{0,28}(हो गई|कर दी(?! ?जिए)|पक्की(?! ?कर(?: ?द)?[ूें])|फिक्स)|book(ed| kar diy| ho gay| confirmed| done)|you'?re\s+(all\s+set|booked|scheduled|confirmed|sorted|in)\b|\ball\s+set\b|appointment('?s| is| has been)?\s*(confirmed|booked|scheduled|reserved)\b|i'?ve\s+(booked|scheduled|reserved|confirmed)\b|scheduled\s+(you|your)\b|झाल[ेंीं](?! ?नाही)|बुक केल(?!\S* ?नाही)|ठरल|निश्चित केल(?! ?नाही)|ಬುಕ್.{0,6}(ಆಗಿದೆ|ಮಾಡಿದ|ಆಯಿತು)|ಖಚಿತ.{0,4}(ಆಗಿದೆ|ವಾಗಿದೆ)|ಖಚಿತವಾಗಿದೆ|ਬੁੱਕ ਕਰ ਦਿੱਤ|ਪੱਕੀ ਕਰ ਦਿੱਤ|முடிந்த|பதிவு செய்த|உறுதி செய்த|புக்.{0,6}செய்த|బుక్.{0,6}(అయ|చేశ|చేసా|చేసిన)|ఖరారు (అయ|చేశ)|বুক.{0,6}(করে দিয়েছি|করেছি)|নিশ্চিত করে দিয়েছি|બુક કરી દીધ|પાકી કરી દીધ|ബുക്ക്.{0,6}ചെയ്ത|ഉറപ്പിച്ച|ବୁକ୍ କରିଦେ|ନିଶ୍ଚିତ କରିଦେ/i;

// NEW [fc06/07/40]: claiming a message/confirmation was SENT without the send
// having happened. Future "भेज दूंगी/भेज देती हूँ" stays safe. English needs the
// object nearby so a generic "sent" in other contexts doesn't trip.
const claimsSent = /भेज द(?!ू|ें|ेत)|bhej d(?!u|e)[iy]|(i'?ve|has been|have|already)\s+sent\b|sent\s+(you\s+)?(the\s+)?(details?|link|confirmation|message|appointment)|पाठवल[ीे](?! ?नाही)/i;

// ─── THE STREAMED GUARD IS THE SAME GUARD ───────────────────────────────────
// Until 2026-08-29 this was a SEPARATE, deliberately looser regex: a done-word
// had to sit within 28 characters of a booking noun, so that "an innocent
// 'हो गया' on a normal streamed turn never forces a needless fallback".
//
// Two things were wrong with that, and both are measured.
//
// First, the prompt itself (brain-lean.js rule 5) instructs the model to open
// a booking confirmation with exactly "हो गया जी! [doctor] के साथ बुक कर दिया
// है" — so a bare "हो गया जी!" as sentence one is, by our own instruction, the
// canonical first sentence of a booking claim. The streamed path yields
// sentence one before the sentinel at the end of the reply can be seen. The
// loose guard let that sentence through, and it was spoken aloud twice in 30
// days with no row behind it (calls 34f1c281 and f98508df: patient says yes,
// Ritu says "हो गया जी!", appointments on that handset: 0).
//
// Second, the innocent case it protected does not exist. Every Ritu turn in
// production over 30 days, replayed: 748 turns, 41 matching claimsBooked, 6 of
// those invisible to the loose guard — all 6 immediately after a booking offer,
// 4 real bookings, 2 false. Zero bare done-words on a non-booking turn. The
// looseness bought nothing and cost two patients a wasted trip.
//
// So the streamed detector is now DERIVED from the three non-streamed ones —
// the same sources, joined — and cannot disagree with them about any sentence.
// A needless fallback costs ~1s; a false confirmation costs a patient. The
// tense-discipline header above already says which of those is cheap.
// MOVE / RESCHEDULE claims — "बदल दी है", "shift kar di", "moved your
// appointment". Absent from every guard until 2026-09-03: a compliant
// UPDATE turn streamed "बदल दी है" before its sentinel arrived, and
// post-booking (where every turn is non-streamed and claimsBooked stands down)
// the model could say it moved an appointment with no sentinel at all.
// Questions and requests stay quiet: "बदल दूँ?", "बदल दीजिए", "badal dun".
const claimsMoved = new RegExp([
  '(?:बदल|शिफ्ट|शिफ़्ट)\\s*(?:कर\\s*)?द(?:ी|िया)(?:\\s*(?:है|हैं|गई|गया))?(?!\\s*(?:जिए|जिये|जिएगा))',
  'बदल(?:ली|ले|लेली)\\s*आहे', 'बदलून\\s*दिल[ीे]', 'हलव(?:ली|ले)\\s*आहे',
  "(?<!not )(?<!cannot )(?<!can'?t )(?<!be )(?:re-?scheduled|moved|shifted)\\b",
  '(?:badal|shift)\\s*(?:kar\\s*)?d(?:i|iy)[aiy]?\\b(?!\\s*(?:jiye|jiy))',
].join('|'), 'i');

const STREAMED_FALSE_CONFIRM = new RegExp(
  [claimsBooked.source, claimsCancelled.source, claimsSent.source, claimsMoved.source].join('|'), 'i'
);

module.exports = { claimsCancelled, claimsBooked, claimsSent, claimsMoved, STREAMED_FALSE_CONFIRM };
