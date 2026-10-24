#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Emergency detector tests
//
// Exercise every category with Hindi + Hinglish + English variants. Negative
// cases verify the detector doesn't false-fire on routine clinic-call phrasing
// (headache, back pain, fever, history of past chest pain mentioned calmly).
//
// Run: node test-emergency-detector.js
// ═══════════════════════════════════════════════════════════════════════════

require('./_bootstrap');   // production switches first — see tests/_bootstrap.js
const { detectEmergency } = require('../emergencyDetector');

const POSITIVES = [
  // Cardiac
  { text: 'Papa ko chest pain ho raha hai', expectedType: 'cardiac' },
  { text: 'I think my dad is having a heart attack', expectedType: 'cardiac' },
  { text: 'Dil mein dard ho raha hai bahut', expectedType: 'cardiac' },
  { text: 'सीने में दर्द हो रहा है', expectedType: 'cardiac' },
  { text: 'दिल का दौरा पड़ गया', expectedType: 'cardiac' },
  { text: 'Seene mein dard ho raha hai', expectedType: 'cardiac' },
  { text: 'Papa ko chest mein dard hai', expectedType: 'cardiac' },

  // Breathing
  { text: 'Saans nahi aa rahi', expectedType: 'breathing' },
  { text: 'मुझे साँस नहीं आ रही', expectedType: 'breathing' },
  { text: 'Bachhe ko saans nahi aa rahi', expectedType: 'breathing' },
  { text: "He can't breathe", expectedType: 'breathing' },
  { text: 'Dam ghut raha hai', expectedType: 'breathing' },
  { text: 'दम घुट रहा है', expectedType: 'breathing' },

  // Unconscious
  { text: 'Patient behosh ho gaya', expectedType: 'unconscious' },
  { text: 'Behoshi aa rahi hai', expectedType: 'unconscious' },
  { text: 'She is unconscious', expectedType: 'unconscious' },
  { text: 'पापा बेहोश हो गए', expectedType: 'unconscious' },
  { text: 'Hosh nahi aa raha', expectedType: 'unconscious' },
  { text: 'He passed out', expectedType: 'unconscious' },

  // Bleeding
  { text: 'Bahut khoon bah raha hai', expectedType: 'bleeding' },
  { text: 'Khoon nahi ruk raha', expectedType: 'bleeding' },
  { text: 'Heavy bleeding ho rahi hai', expectedType: 'bleeding' },
  { text: 'खून बह रहा है', expectedType: 'bleeding' },
  { text: 'खून नहीं रुक रहा', expectedType: 'bleeding' },
  { text: "The bleeding won't stop", expectedType: 'bleeding' },

  // Stroke
  { text: 'Mujhe lagta hai stroke aaya hai', expectedType: 'stroke' },
  { text: 'Brain stroke ho gaya', expectedType: 'stroke' },
  { text: 'Lakwa mar gaya', expectedType: 'stroke' },
  { text: 'लकवा हो गया है', expectedType: 'stroke' },
  { text: 'Sudden weakness on left side', expectedType: 'stroke' },

  // Accident / trauma
  { text: 'Road accident ho gaya', expectedType: 'accident_trauma' },
  { text: 'Bike accident hua hai abhi', expectedType: 'accident_trauma' },
  { text: 'Sir mein chot lagi hai', expectedType: 'accident_trauma' },
  { text: 'Sir phut gaya', expectedType: 'accident_trauma' },
  { text: 'सिर में चोट लगी है', expectedType: 'accident_trauma' },
  { text: 'दुर्घटना हो गई', expectedType: 'accident_trauma' },

  // Burn
  { text: 'Bachhi bahut jal gayi hai', expectedType: 'severe_burn' },
  { text: 'Severe burn ho gaya', expectedType: 'severe_burn' },
  { text: 'बहुत जल गया है', expectedType: 'severe_burn' },

  // Seizure
  { text: 'Patient ko fit aa rahi hai', expectedType: 'seizure' },
  { text: 'He is having a seizure', expectedType: 'seizure' },
  { text: 'Mirgi ka daura pad gaya', expectedType: 'seizure' },
  { text: 'मिर्गी का दौरा आ गया', expectedType: 'seizure' },

  // Choking
  { text: 'Bachhe ke gala mein kuch atak gaya', expectedType: 'choking' },
  { text: 'He is choking', expectedType: 'choking' },

  // Overdose / poisoning
  { text: 'Beti ne goliya kha li hai', expectedType: 'overdose_poison' },
  { text: 'Drug overdose case hai', expectedType: 'overdose_poison' },
  { text: 'Zehar pi liya hai', expectedType: 'overdose_poison' },
  { text: 'ज़हर खा लिया है', expectedType: 'overdose_poison' },

  // Marathi (shares Devanagari with Hindi but different words)
  { text: 'मला इमरजेंसी आहे', expectedType: 'emergency_mr' },
  { text: 'मला जगू शकत नाही', expectedType: 'emergency_mr' },
  { text: 'जगू ना सकत', expectedType: 'emergency_mr' },
  { text: 'छातीत खूप दुखतंय', expectedType: 'emergency_mr' },
  { text: 'मला श्वास घेता येत नाही', expectedType: 'emergency_mr' },
  { text: 'तो बेशुद्ध झाला आहे', expectedType: 'emergency_mr' },
  { text: 'खूप रक्त येतंय', expectedType: 'emergency_mr' },
  { text: 'वाचवा मला', expectedType: 'emergency_mr' }
];

// Negative cases — these MUST NOT trigger. They represent normal clinic-call
// phrasings that we cannot afford to false-fire on (or it'd be impossible to
// use the agent for routine bookings).
const NEGATIVES = [
  // Normal booking flow
  'Namaste, mujhe appointment chahiye',
  'Mera naam Siddharth hai',
  'Kal subah 11 baje aa sakta hoon',
  'Doctor se milna hai',

  // Non-emergency complaints
  'Mujhe halka sir dard hai',
  'Mild headache hai bas',
  'Back pain hai pichle do din se',          // ankle pain
  'Knee mein thoda dard hai',                // knee discomfort
  'Fever hai 100 degree',
  'Bukhar aa raha hai',
  'Stomach pain hai',                        // generic abdominal
  'Cold and cough hai',
  'Khansi ho rahi hai',                       // cough

  // Specialty / consult requests
  'Skin specialist se milna hai',
  'Cardiologist se appointment book karein', // mentions cardio but no acute symptom
  'Heart checkup karwana hai routine',       // routine cardiac checkup
  'Diabetes ka follow up hai',

  // Past tense / history mentions (NOT acute)
  // NOTE: these are genuinely tricky. The keyword filter accepts that
  // mentioning a *past* event ("had chest pain last year") may false-fire.
  // We document this as a known false-positive class. Comment lines below
  // are kept for visibility but NOT included in the negative test set.
  //   'Pichle saal chest pain hua tha',
  //   'Pehle bhi chest pain hua tha kabhi',
  // ↑ These WILL fire. Accepted false positive — see emergencyDetector.js
  //   header. Better to confirm with patient than miss a real emergency.

  // Words that should not collide with patterns
  'Restaurant menu mein dal chawal hai',     // "dal" near "chawal" — shouldn't match anything
  'Mera dilraj naam hai',                    // "dil" inside a name — shouldn't match dil-pattern
  'Saans le ke baat karein',                 // "saans" without "nahi" — shouldn't fire
  'Strike kal hai shahar mein',              // "stroke"-like English word
  'Hospital ka address bhejiye'              // mentions hospital, not an emergency
];

let pass = 0, fail = 0;
const failures = [];

console.log('\n──────── POSITIVE CASES (must fire) ────────');
for (const { text, expectedType } of POSITIVES) {
  const r = detectEmergency(text);
  const ok = r && r.type === expectedType;
  if (ok) {
    pass++;
    // console.log(`  ✓ "${text}" → ${r.type}`);
  } else {
    fail++;
    failures.push({ text, expectedType, got: r });
    console.log(`  ✗ "${text}" → expected ${expectedType}, got ${r ? r.type : 'null'}`);
  }
}

console.log(`\nPositives: ${pass}/${POSITIVES.length} passing`);

console.log('\n──────── NEGATIVE CASES (must NOT fire) ────────');
let negPass = 0, negFail = 0;
for (const text of NEGATIVES) {
  const r = detectEmergency(text);
  if (r === null) {
    negPass++;
    // console.log(`  ✓ "${text}" → no match`);
  } else {
    negFail++;
    failures.push({ text, expectedType: null, got: r });
    console.log(`  ✗ FALSE POSITIVE: "${text}" → ${r.type} (matched "${r.matched}")`);
  }
}

console.log(`\nNegatives: ${negPass}/${NEGATIVES.length} passing`);
console.log(`\n${pass + negPass}/${POSITIVES.length + NEGATIVES.length} total tests passing`);

if (failures.length > 0) {
  console.log('\n──────── FAILURE DETAIL ────────');
  for (const f of failures) {
    console.log(JSON.stringify(f, null, 2));
  }
  process.exit(1);
}

console.log('\n✓ All emergency detector tests passing.');
