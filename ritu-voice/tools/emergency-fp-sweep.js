// ═══════════════════════════════════════════════════════════════════════════
// EMERGENCY DETECTOR FALSE-POSITIVE SWEEP — over REAL speech, not fixtures.
//
// Replays every patient turn from the last 30 days of production plus the
// 1,417-line MUCS Marathi corpus (hypotheses and references) through BOTH
// detectors, composing v1's probe exactly as callHandler does, and writes what
// fired. Run once BEFORE a detector change and once after; the diff is the
// cost of the change on speech that actually happens.
//
// Born 2026-08-29: the first version of the v2 script fold looked correct,
// passed every fixture, and on this sweep lit 25 new REDs in one category —
// फंड (mutual fund) and फंदा (noose) share a consonant skeleton. Fixtures did
// not contain a caller asking about a mutual fund. Production does.
//
// Not a gate step (needs the database). Usage:
//   node tools/emergency-fp-sweep.js /tmp/before.json          # old probe shape
//   node tools/emergency-fp-sweep.js /tmp/after.json  roman     # with romanize()
//   node tools/emergency-fp-sweep.js --diff /tmp/before.json /tmp/after.json
// ═══════════════════════════════════════════════════════════════════════════
process.env.SKIP_BOOT_AUDIO='1'; require('dotenv').config();
const fs=require('fs');const {Pool}=require('pg');
const {detectEmergency}=require('../emergencyDetector.js');const {detectEmergencyV2}=require('../emergencyDetectorV2.js');
const {toDevanagari}=require('../translit');const {romanize}=require('../devanagari.js');
if (process.argv[2] === '--diff') {
  const b = require(require('path').resolve(process.argv[3])), a = require(require('path').resolve(process.argv[4]));
  const n1 = Object.keys(a.v1).filter(k => !b.v1[k]), n2 = Object.keys(a.v2).filter(k => !b.v2[k]);
  console.log(`  NEW v1 fires: ${n1.length} | NEW v2 REDs: ${n2.length}`);
  n1.forEach(k => console.log('   v1 +', a.v1[k].type, a.v1[k].src, JSON.stringify(a.v1[k].t).slice(0, 90)));
  n2.forEach(k => console.log('   v2 +', a.v2[k].cat, a.v2[k].src, JSON.stringify(a.v2[k].t).slice(0, 90)));
  process.exit(0);
}
const withRoman=process.argv[3]==='roman';
const { composeEmergencyProbe } = require('../emergencyDetector'); const probe=(t)=>composeEmergencyProbe(t,{roman:withRoman});   // the LIVE composition
(async()=>{
  const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:2});
  const {rows}=await p.query(`SELECT transcript FROM calls WHERE created_at>NOW()-INTERVAL '30 days' AND transcript IS NOT NULL`); await p.end();
  const texts=[];for(const r of rows)for(const x of (r.transcript||[]))if(x.role==='patient'&&x.text)texts.push({src:'prod',t:x.text});
  for(const l of fs.readFileSync(require('path').join(__dirname, '..', '..', 'ritu-evals', 'data', 'mucs-marathi-raw.jsonl'),'utf8').split('\n')){if(!l.trim())continue;const j=JSON.parse(l);if(j.hyp)texts.push({src:'mucs',t:j.hyp});if(j.ref)texts.push({src:'mucs-ref',t:j.ref});}
  const out={n:texts.length,v1:{},v2:{}};
  texts.forEach((x,i)=>{const a=detectEmergency(probe(x.t));if(a)out.v1[i]={src:x.src,t:x.t,type:a.type||a.id};const b=detectEmergencyV2(x.t,{});if(b&&b.tier==='RED')out.v2[i]={src:x.src,t:x.t,cat:b.category};});
  fs.writeFileSync(process.argv[2],JSON.stringify(out));
  console.log(`  ${withRoman?'NEW-probe':'OLD-probe'} sweep: ${out.n} texts · v1 fires ${Object.keys(out.v1).length} · v2 RED ${Object.keys(out.v2).length}`);
})().catch(e=>{console.error('  ERR',e.message);process.exit(1)});
