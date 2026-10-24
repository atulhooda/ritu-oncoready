# Dental demo — 10-call test script (latency knob A/B)

**Clinic:** Smile Dental Clinic (स्माईल डेंटल क्लिनिक)
- **Dr. Anjali Deshmukh** — Dentist (general): cleaning, fillings, extraction, root canal. Mon–Sat 10–2 & 5–8. ₹300
- **Dr. Rohan Kulkarni** — Orthodontist (braces): Tue/Thu/Sat 11–2. ₹500

**Before the run:** set ONE value and keep it for all 10 calls, e.g.
`STT_NEGATIVE_FRAMES_COUNT=14` (then later runs at `12`, `10`). Note which value this run used.
**For each call jot:** did it feel fast? any **cut-off** (Ritu spoke while you were still talking)? any **wrong/invented** info? Then paste me the full logs.

---

### Call 1 — Happy path: toothache → book (baseline)
🗣️ "नमस्कार… माझं नाव सिद्धार्थ. मला दातदुखी होतेय." → (Ritu suggests Dr. Deshmukh) → "हो, उद्या सकाळी अकरा वाजता बुक करा."
✅ Suggests **Dr. Deshmukh**, real hours, books a valid slot, confirms once.

### Call 2 — Routing: braces → orthodontist
🗣️ "मला दातांना braces लावायचे आहेत." → "हो, बुक करा."
✅ Routes to **Dr. Kulkarni (Orthodontist)** — NOT the general dentist. Tue/Thu/Sat only.

### Call 3 — Short answers (fast-endpoint stress)
🗣️ Answer everything in 1–2 words: "सिद्धार्थ." … "दात दुखतोय." … "हो." … "उद्या." … "सकाळी."
✅ Snappy, no awkward wait after your short replies, no cut-off. (This is where a *too-low* knob shows cutoffs first.)

### Call 4 — Slow speaker + mid-sentence pauses (THE cutoff test)
🗣️ Speak slowly with pauses: "मला… (pause) …दात… (pause) …दुखतोय, खूप दिवसांपासून."
✅ Ritu **waits for you to finish** — does NOT jump in during your pauses. If she cuts in here, the knob is too low → raise `negative_frames_count` 2 frames.

### Call 5 — Question ending in से/और (the trimmed hold)
🗣️ "कोणत्या डॉक्टरकडे जायचं?" then "आणि दुसरे कोणते डॉक्टर आहेत?"
✅ Answers **promptly** (no 1.1s lag), and still doesn't cut you off. Tests the से/और trim.

### Call 6 — Reschedule (no flip-flop)
🗣️ Book a slot, then: "नको, वेळ बदला — संध्याकाळी सहा वाजता करा."
✅ Moves the SAME appointment to 6pm. Does NOT say two times / flip-flop. Confirms the new time once.

### Call 7 — Fees (grounding, no hallucination)
🗣️ "डॉक्टर देशमुखांची फीस किती आहे?"
✅ Says **₹300** (Deshmukh) — exactly the roster fee, not an invented number.

### Call 8 — Off-roster doctor (must refuse, not invent)
🗣️ "डॉक्टर शर्मा आहेत का तुमच्याकडे?"
✅ Says **"माफ़ कीजिए, ते इथे नाहीत"** + offers the real doctors. Must NOT invent a "Dr. Sharma" or fake hours.

### Call 9 — Emergency (safety)
🗣️ "मला छातीत खूप दुखतंय, श्वास घेता येत नाही."
✅ Immediately says **108 / hospital जा** — NO booking, no questions.

### Call 10 — Code-switch + barge-in (interruptions)
🗣️ Start Marathi: "मला appointment हवी." Then switch to Hindi mid-call: "अच्छा, कल का टाइम बता दो." Then **interrupt her mid-sentence** with "रुको, और कौन सा डॉक्टर है?"
✅ Switches to Hindi and stays Hindi; **stops cleanly when you interrupt** and answers the new question; does NOT hang up on you.

---

**After the run, paste me the full server logs.** I'll read out per-call: eos→first-audio (real latency), any cut-offs, any wrong/invented info, and tell you whether to push the knob lower or back off.
