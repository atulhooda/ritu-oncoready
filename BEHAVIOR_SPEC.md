# Voice Path Behavior Specification

> **Purpose.** This document is the contract that the `feature/llm-streaming` refactor must preserve. Every behavior listed below is **load-bearing** — each one was added or hardened in response to a real bug observed in a test call. If a behavior here changes after the refactor lands, that is a regression and the flag flips back to off.
>
> **Source of truth.** Pinned at tag `pre-streaming-stable` (`db1a2e8`). When in doubt, `git diff pre-streaming-stable feature/llm-streaming -- <file>` should reveal exactly what changed.

---

## 0. Tier definitions

- **Tier 1 — MUST NOT change.** Behavioral contract. If the refactor changes it, that's a bug.
- **Tier 2 — CAN change with explicit validation.** Order-of-operations is allowed to differ; observable behavior at the patient-facing boundary must match.
- **Tier 3 — New surface area introduced by the refactor.** Must coexist with Tier 1.

Every section below tags its claims with a tier.

---

## 1. End-to-end call flow (current, non-streaming) — Tier 1

A complete inbound call traverses these layers in order:

```
Exotel WS → index.js (event dispatch) → CallHandler.handleAudio()
                                          ↓
                                   STT batches (Sarvam saaras:v3, hi-IN)
                                          ↓
                                   _onTranscript(text)
                                     ├─ length filter   (< 2 chars dropped)
                                     ├─ echo blanking   (500ms post ritu_done)
                                     ├─ echo detection  (word overlap > 50%)
                                     ├─ ghost transcript filter (≤3 tokens, non-backchannel, post non-question monologue, within GHOST_TRANSCRIPT_WINDOW_MS)
                                     ├─ backchannel filter (≥80% of tokens are backchannels → ignored if isSpeaking)
                                     └─ barge-in        (≥ BARGE_IN_MIN_CHARS while isSpeaking → _clearAudio + abort TTS + ++_generationId)
                                          ↓
                                   debounce (TRANSCRIPT_DEBOUNCE_MS coalescing)
                                          ↓
                                   processIntent(combined)
                                     ├─ snapshot myGen = this._generationId
                                     ├─ await completeWithFailover(...)    // brain.js getResponse → llm/failover
                                     ├─ if myGen !== this._generationId → discard
                                     ├─ extract sentinels + update state
                                     ├─ if empty cleaned text → return silently
                                     └─ speak(text)
                                          ↓
                                   speak() / streamTTS
                                     ├─ store _activeTTS = handle
                                     ├─ for each PCM chunk → _sendStreamingAudio → Exotel media event
                                     ├─ _sendSilence(200ms tail)
                                     └─ _sendMark('ritu_done' | 'ritu_end_call')
                                          ↓
                                   Mark roundtrips back from Exotel/harness
                                          ↓
                                   onRituDone() → isSpeaking=false, _echoBlankingUntil = now+500, _lastRituTurnEndedAt = now, _lastRituTurnWasQuestion = /\?\s*$/
```

Every step is currently sequential. The refactor *only* changes the "await completeWithFailover → extract → speak" segment for non-booking turns — everything else is Tier 1 invariant.

**File refs:** [callHandler.js:_onTranscript](callHandler.js#L155-L230), [callHandler.js:processIntent](callHandler.js#L325-L420), [callHandler.js:speak](callHandler.js#L465-L520), [callHandler.js:onRituDone](callHandler.js#L165-L180).

---

## 2. Sentinel parsing (Tier 1 — exact preservation)

The LLM emits sentinel lines that the server parses. Every sentinel below is parsed by a specific regex and consumed by a specific code path. The refactor must produce **the same parsed values from the same accumulated text** as today.

| Sentinel | Regex | Consumer | Notes |
|---|---|---|---|
| `PATIENT_NAME:<name>` | `/PATIENT_NAME:\s*(.+)/i` | `extractPatientName()` | Passes through `isValidFieldValue()` denylist (rejects "मेरा नाम", "नहीं मिला अभी तक", "ji", "haan", "sir", "hai" etc.) |
| `PATIENT_REASON:<text>` | `/PATIENT_REASON:\s*(.+)/i` | `extractPatientReason()` | Same denylist guard |
| `BOOK_APPOINTMENT:{...}` | `/BOOK_APPOINTMENT:\s*(\{[\s\S]*?\})/` | `extractBookingIntent()` | JSON.parse — silent fail returns null. Triggers calendar.bookAppointment(). **Booking turns stay non-streaming (Option B).** |
| `UPDATE_APPOINTMENT:{...}` | `/UPDATE_APPOINTMENT:\s*(\{[\s\S]*?\})/` | `extractUpdateIntent()` | Same JSON pattern; triggers calendar.updateAppointment() |
| `END_CALL:true` | `fullText.includes('END_CALL:true')` | `result.endCall = true` | Sets `shouldEndCall`, mark becomes `ritu_end_call` |
| `EMERGENCY_DETECTED:true` | `fullText.includes('EMERGENCY_DETECTED:true')` | `result.emergency = true` | Sets `emergencyDetected`, bookingFailureReason = 'Emergency' |
| `NAME_CONFIRMED:true` | stripped only (defensive) | none — left over from a reverted feature; **do not re-introduce** |
| `TIME_CONFIRMED:true` | stripped only (defensive) | none — same |

All sentinels are stripped from spoken output by `cleanResponse()` in [brain.js:cleanResponse](brain.js#L150-L165). The refactor's per-sentence emission must run `cleanResponse()` on the **accumulated text up to each sentence boundary**, then split the difference into the next sentence to speak — NOT speak the raw stream.

**File refs:** [brain.js:107-200](brain.js#L107-L200) for all extractors, [brain.js:cleanResponse](brain.js#L150-L165).

**Hardened against:** LLM emitting "मेरा नाम" or "नहीं मिला अभी तक" as a name (real bug from call `call_md19y7txj`); LLM emitting Gurmukhi pronoun "ਤੁਸੀਂ" as a name (call `call_md19y7txj`); bare-sentinel responses (no spoken text).

---

## 3. State machine: marks + flags (Tier 1)

The voice agent's "state" is encoded across these flags on `CallHandler`:

| Field | Set when | Cleared when | Used for |
|---|---|---|---|
| `isSpeaking` | `speak()` enters | `onRituDone()` called from mark; or barge-in clears it | Barge-in gate, RMS log labeling, silence-timer pause |
| `_echoBlankingUntil` | `onRituDone()`: `now + ECHO_BLANKING_MS` (500ms) | (timestamp, expires naturally) | `_onTranscript()` drops transcripts arriving within window |
| `_lastRituTurnEndedAt` | `onRituDone()`: `now` | (never; overwritten next turn) | Ghost transcript filter window |
| `_lastRituTurnWasQuestion` | `onRituDone()`: regex `/\?\s*$/` on last spoken text | (overwritten next turn) | Ghost transcript filter bypass |
| `_lastRituText` | `speak()` entry | (overwritten next turn) | Echo word-overlap detection in `_isEcho()` |
| `_generationId` | `0` at construction | incremented on barge-in | Stale-response discard in `processIntent` |
| `_activeTTS` | `speak()` entry | `speak()` exit (finally) | Abort target on barge-in |
| `_pendingTranscript`, `_debounceTimer` | `_onTranscript` accumulator | Fires after `TRANSCRIPT_DEBOUNCE_MS` (300ms) | Coalesce rapid STT fragments |

**Critical transition: barge-in cancellation order** ([callHandler.js:200-215](callHandler.js#L200-L215))
```
1. console.log barge-in
2. this._clearAudio()                // tells Exotel to flush
3. this._activeTTS.abort()           // closes the Sarvam TTS WS so no more chunks generate
4. this.isSpeaking = false
5. this._generationId++              // any in-flight LLM call's response will be discarded
```

This exact ordering matters. Steps 2 and 3 together are what made Ritu actually stop speaking (the long-running bug from before commit `bbd9155`). Step 5 ensures a stale LLM response that arrives *after* barge-in doesn't get spoken.

**File refs:** [callHandler.js constructor](callHandler.js#L100-L160), [onRituDone](callHandler.js#L165-L180).

**Hardened against:** Ritu continuing to speak after barge-in (the "Ritu won't shut up" class of bug — see commit `bbd9155`).

---

## 4. Transcript filters (Tier 1)

Order of filters in `_onTranscript()` is significant — each protects against a different class of false positives.

### 4.1 Length filter
```js
if (trimmed.length < TRANSCRIPT_MIN_CHARS) return; // < 2 chars
```
Drops single Devanagari character STT noise.

### 4.2 Echo blanking window
```js
if (Date.now() < this._echoBlankingUntil) return;
```
500ms after `ritu_done` mark, suppresses residual phone-line echo that AEC missed. Set in `onRituDone()`.

### 4.3 Echo word-overlap detection
`_isEcho(text)` returns true if >50% of normalized transcript tokens appear in `_lastRituText`. Only runs while `isSpeaking`. Catches obvious echo of Ritu's current utterance.

### 4.4 Ghost transcript filter
```js
if (this._lastRituTurnEndedAt > 0 &&
    sinceRituEnded < GHOST_TRANSCRIPT_WINDOW_MS &&    // default 2000ms
    !this._lastRituTurnWasQuestion &&                  // bypass for question turns
    !isBackchannel(trimmed)) {
  if (tokens.length <= GHOST_TRANSCRIPT_MAX_TOKENS) drop;  // ≤ 3 tokens
}
```
Catches `"तथा ना"` and `"हेलो है तू"`-style hallucinations from VAD over-triggering on noise. Bypassed when Ritu just asked a question (patient may answer with a short legitimate reply like `"kal subah"`).

### 4.5 Backchannel filter
`isBackchannel(text)` — tokenizes the transcript, returns true if ≥80% of tokens are in `BACKCHANNEL_TOKENS` (Hinglish + Devanagari acknowledgments). Only ignores while `isSpeaking`. Catches `"haan ji bilkul"`, `"हाँ ठीक है"`.

### 4.6 Barge-in
Only fires while `isSpeaking`. Requires `trimmed.length >= BARGE_IN_MIN_CHARS` (4). Triggers the 5-step cancellation in §3.

**File refs:** [callHandler.js:_onTranscript](callHandler.js#L155-L230), constants at [top of file](callHandler.js#L8-L45).

**Hardened against:** Doubled "Aapka naam kya hai?" (call `call_md19y7txj`); ghost transcripts triggering false LLM turns; "haan" being interpreted as a barge-in interruption.

---

## 5. Debouncing + processing chain (Tier 1)

```js
// In _onTranscript (after all filters pass):
this._pendingTranscript = this._pendingTranscript
  ? `${this._pendingTranscript} ${trimmed}`
  : trimmed;

if (this._debounceTimer) clearTimeout(this._debounceTimer);
this._debounceTimer = setTimeout(() => {
  const combined = this._pendingTranscript;
  this._pendingTranscript = '';
  this._debounceTimer = null;
  this.conversationHistory.push({ role: 'user', content: combined });
  this._processingChain = this._processingChain
    .then(() => this.processIntent(combined))
    .catch((err) => this.handleCriticalError(err));
}, TRANSCRIPT_DEBOUNCE_MS); // 300ms
```

Two rapid STT fragments within 300ms (e.g. `"haan"` then `"main aa raha hu"`) are coalesced into one LLM turn. `_processingChain` is a Promise chain — turns process serially per call, never concurrently.

**Refactor invariant:** the new streaming path must hang off the same `_processingChain`. No parallel turn processing.

---

## 6. Generation ID + stale response discard (Tier 1)

```js
async processIntent(userText) {
  const myGen = this._generationId;
  const result = await getResponse(...);
  if (myGen !== this._generationId) {
    console.log(`Discarding stale LLM response (gen ${myGen} → ${this._generationId})`);
    return;
  }
  // ... state updates + speak ...
}
```

If the patient barges in while the LLM is thinking, `_generationId++` invalidates this turn's response. The LLM result is discarded before `speak()` is called, so the patient hears no audio for the abandoned turn.

**Streaming refactor requirement (Tier 3):** the per-sentence loop must check `myGen !== this._generationId` between sentences and abort the rest of the stream + close the TTS WS on mismatch. Otherwise barge-in only catches the *current* sentence, not the queue.

---

## 7. Empty response → silence (Tier 1)

When the LLM emits only sentinel lines (e.g. `PATIENT_NAME:Siddharth` with no conversational reply), `cleanResponse()` returns empty string. `processIntent()` detects this:

```js
if (!spokenText || !spokenText.trim()) {
  console.log('Empty LLM response — staying silent');
  return; // skip history push and speak
}
```

State extraction still runs (name/reason/booking effects happen). Just no audio. **The previous "Ji, aap continue karein" fallback was removed because it sounded worse than silence when it fired after a long Ritu turn.**

**Refactor invariant:** if a streamed turn produces no speakable sentences (only sentinels), `speakStream()` must not open the TTS WS at all, must not emit a mark, and must update state as today.

---

## 8. Cancellable TTS WebSocket (Tier 1)

`streamTTS(text, onAudioChunk)` returns a Promise with a `.abort()` method ([sarvam.js:134-265](sarvam.js#L134-L265)).

- `aborted` flag short-circuits the `'message'` handler so no more chunks reach `onAudioChunk` after abort.
- `ws.close()` is called inside `abort()`, triggering the `'close'` handler.
- The close handler resolves the Promise (does not reject) when `aborted` is true — barge-in is an *expected* termination, not an error.

`callHandler.speak()` stores the handle in `this._activeTTS` for the duration of the turn and clears it in a `finally` block.

**Refactor:** the streaming path needs the same cancellable property, plus the additional ability to *cancel between sentences* without closing a shared TTS WS that may have more text queued. Simplest model: per-sentence TTS calls; complex model: persistent TTS WS that can be cleanly interrupted mid-utterance. Decide during implementation.

**Hardened against:** Ritu continuing to send audio chunks after `_clearAudio()` told Exotel to flush — because the in-flight Sarvam WS kept generating chunks. Fixed in commit `bbd9155`.

---

## 9. STT configuration (Tier 1)

```
language-code=hi-IN
model=saaras:v3
mode=transcribe
input_audio_codec=pcm_s16le
sample_rate=8000
high_vad_sensitivity=false   ← intentional, reduces ghost transcripts
vad_signals=true
flush_signal=true
```

`language-code=hi-IN` handles Hinglish and most English code-switching on Indian phone lines. **Do not switch to `unknown`** — that caused Tamil "சरि" hallucinations on Hindi audio in real calls.

`high_vad_sensitivity=false` is intentional; the previous `true` setting was triggering speech events on background noise.

`stt.flush()` is called from `_onSpeechEnd()` to push buffered audio through faster.

**File refs:** [sarvam.js:316-340](sarvam.js#L316-L340).

---

## 10. Multilingual TTS (Tier 1)

`streamTTS()` and `textToSpeech()` both call `detectLanguageCode(text)` ([sarvam.js:28-68](sarvam.js#L28-L68)) which counts characters per Indic script and returns the Sarvam language code matching the dominant script. Latin-only text → `hi-IN` (handles Hinglish).

The configured speaker (`config.sarvam.speaker`) is passed unchanged for all languages; Sarvam either accepts or substitutes.

**Refactor invariant:** sentence-by-sentence TTS must run `detectLanguageCode()` per sentence (each sentence may be a different language) OR detect once on the buffered head of the response. Per-sentence is safer.

---

## 11. Booking flow (Tier 1 — Option B: stays non-streaming)

When `extractBookingIntent(fullText)` returns non-null:

```
1. JSON.parse the patientName / reason / dateTime
2. validate name via isValidName() (rejects fragments)
3. await checkAvailability(dateTime)        // calendar API, 5s timeout
4. if available: await bookAppointment(...) // calendar API, 6s timeout
5. if success: return spoken confirmation text + booked=true + eventId
6. if slot unavailable: getNextAvailableSlots(), return alternatives text
7. if API fails: return "Booking mein problem aayi" text
```

**This entire path runs in `brain.js getResponse()` and must continue to do so on booking turns.** The refactor detects booking intent by scanning the *accumulated stream* for the literal substring `BOOK_APPOINTMENT` — when seen, the streaming path aborts and a non-streaming completion is issued to finish the turn safely.

**File refs:** [brain.js:281-350](brain.js#L281-L350) (booking branch), [calendar.js:bookAppointment/checkAvailability/getNextAvailableSlots].

**Hardened against:** speaking "appointment confirm ho gayi" before Google Calendar actually persisted the event.

---

## 11A. Deterministic emergency keyword filter (Tier 1, added 2026-05-28)

A pattern-matched safety layer that runs in `_onTranscript` **before** barge-in, **before** debounce, **before** any LLM call. The single most safety-critical behavior in the system. It exists as a deterministic floor under the LLM-side `EMERGENCY_DETECTED` sentinel — that's the ceiling, this is the floor.

### Flow
```
_onTranscript(text)
  ├─ length filter
  ├─ emergency latch    ← if _emergencyTriggered → return (drop everything)
  ├─ echo blanking
  ├─ echo word-overlap
  ├─ ghost transcript filter
  ├─ backchannel filter
  ├─ deterministic emergency detector  ← detectEmergency(text)
  │     ↓ match
  │   handleEmergency(detection):
  │     1. _clearAudio()  →  Exotel flushes its buffer
  │     2. _activeTTS.abort()  →  Sarvam WS closes; no more chunks generate
  │     3. _generationId++  →  any in-flight LLM response gets discarded
  │     4. clearTimeout(_debounceTimer); _pendingTranscript = ''
  │     5. _clearSilenceTimers()
  │     6. emergencyDetected = true; bookingFailureReason = 'Emergency (deterministic: <type>)'
  │     7. shouldEndCall = true; conversationPhase = 'wrapup'
  │     8. transcript.push(...)  +  fire-and-forget n8n alert
  │     9. play EMERGENCY_AUDIO (cached at startup)  +  silence tail  +  ritu_done → ritu_end_call mark
  ├─ barge-in
  └─ debounce → processIntent
```

### Idempotency

`this._emergencyTriggered` latches at the start of `handleEmergency()`. Subsequent transcripts arriving during message playback (including echo of the emergency message itself) early-return at the top of `_onTranscript`. `processIntent` also early-returns if `_emergencyTriggered` is set — defense in depth against a stale LLM response speaking after the emergency message.

### Patterns

Ten categories defined in [emergencyDetector.js](emergencyDetector.js): cardiac, breathing, unconscious, bleeding, stroke, accident_trauma, severe_burn, seizure, choking, overdose_poison. ~45 patterns covering Hindi (Devanagari), Hinglish (Latin transliterated), and English. Phrase-anchored — single tokens like "dard" / "pain" / "chest" do not fire. Devanagari patterns deliberately drop `\b` since JavaScript's word boundary is ASCII-only.

### Cached message

```
"Yeh emergency lagti hai. Kripya ABHI 108 dial karein ya nazdiki hospital
jaayein. Main yeh call yahan rok rahi hoon taaki aap madad le sakein.
Dhyaan rakhiye."
```

Pre-rendered to PCM16 at server startup via `preloadEmergency()` (mirrors `preloadGreeting()`). If pre-cache fails, `handleEmergency()` falls back to live TTS — slower, but better than silence.

### Asymmetric error preference

- False positive: patient annoyed, re-calls. Cost: $0.
- False negative: liability event. Cost: catastrophic.

Patterns lean toward firing when in doubt. Documented in [emergencyDetector.js](emergencyDetector.js) header.

### Tests

`test-emergency-detector.js` — 49 positive cases (all 10 categories × Hindi/Hinglish/English variants) + 22 negative cases (routine clinic-call phrasings, non-emergency complaints, words that could collide with patterns like "dilraj" name or "saans le ke" without "nahi"). **71/71 passing as of commit `25b07a8`.**

### Streaming refactor invariant

The deterministic emergency layer must remain wired exactly as above when streaming LLM→TTS is enabled. Specifically:
- `_emergencyTriggered` latch still checked at top of `_onTranscript`
- `handleEmergency` still cancels the active streaming TTS (`_activeTTS.abort()`)
- The streaming sentence-iterator loop must check `_emergencyTriggered` between sentences and abort
- `processIntent` (now `processIntentStream`) still has the post-LLM `_emergencyTriggered` guard

### Hardened against

The Scout-vs-70B evaluation on 2026-05-27 (commit `5637518`) showed the LLM cannot be the sole emergency line of defense. Scout failed to emit `EMERGENCY_DETECTED:true` on an unambiguous chest-pain + saans-nahi prompt; it treated the input as a routine booking inquiry. With this layer in place, that same scenario fires the emergency response regardless of which LLM is primary.

---

## 12. LLM provider abstraction (Tier 1, recent)

`brain.js` calls `completeWithFailover(messages, options)` from [llm/index.js](llm/index.js). The wrapper:

- Tries the primary provider (env `LLM_PRIMARY_PROVIDER`, default `sambanova`)
- On retryable failure (timeout, 5xx, network, post-retry 429) retries on `LLM_FALLBACK_PROVIDER` (default `groq`)
- Does NOT failover on auth (401/403) or bad request (400)
- Returns `{ content, toolCalls, usage, latencyMs, provider, model, failover }`
- Per-process counter tracked in `llm/failover.js` (`getFailoverStats()`)

**Production config decision (commit `06179fd`):** `LLM_PRIMARY_PROVIDER=groq`, `LLM_FALLBACK_PROVIDER=deepinfra`. Groq is the fastest provider measured on Railway and stays primary until its 500K TPD free-tier ceiling is hit mid-day, at which point DeepInfra (unlimited paid quota) catches the rest of the day's traffic.

Railway test data (all from the same test endpoint, full Ritu prompt, 10 samples each):
- Groq:      P50 TTFT 293ms / P95 485ms / total median 412ms   (current primary)
- DeepInfra: P50 TTFT 423ms / P95 1101ms / total median 1456ms (current fallback)
- SambaNova: P50 TTFT 821ms / P95 3882ms / total median 930ms  (not in rotation; P95 unacceptable)

The streaming refactor on this branch primarily protects the *afternoon* — when Groq is throttled and traffic shifts to DeepInfra, sentence-by-sentence TTS masks most of DeepInfra's 1+ second slower total time. With the refactor, mid-day failover becomes nearly transparent (~1.2s TTFA vs ~2s without). With Groq primary all-morning, mornings stay near-optimal regardless.

**Refactor requirement (Tier 3):** add `streamWithFailover()` integration in the new path. Already implemented in `llm/failover.js`; the streaming refactor wires it into the new `getResponseStream()` and `speakStream()`.

---

## 13. System prompt content (Tier 1)

Defined in [brain.js:14-78](brain.js#L14-L78). Sections (DO NOT modify):

- Identity (Ritu, female receptionist, "ji" honorific, warm tone)
- Language (multilingual; no Indic-script mixing in one sentence)
- Response format (1-2 sentences, single question per turn, fillers)
- Conversation flow (6 steps: greeting → reason → schedule → book → wrap up → end)
- Special cases (slot unavailable, vague time, medical queries → defer, rude patients)
- Emergency keywords + response template
- Sentinel rules (every response MUST include spoken text alongside sentinels)

If the streaming refactor needs token-count reduction in the prompt (the "in parallel" work mentioned), that's a separate change reviewed against this section.

---

## 14. Critical bug fixes — the "why" behind the code

These are the bugs that drove the load-bearing logic in §2-§11. If a refactor reintroduces any of these, that's a regression:

| Bug | Symptom in call | Fix landed in commit | Code that catches it |
|---|---|---|---|
| TTS chunk jitter | crackling between Sarvam chunks | `6474dd4` | `_ttsTail` sub-frame buffer in `_sendStreamingAudio` |
| Full-duplex broken | barge-in impossible | `b602fa3` | removed `if isSpeaking return` from handleAudio |
| Phone number "Unknown" | callerPhone never captured | `b602fa3` | start.from extraction in index.js |
| Hardcoded DB password | secret in repo | `b602fa3` | removed fallback in config |
| Language drift to Punjabi | TTS garbled audio | `8a91493` (later refined `22a525d`) | detectLanguageCode + per-utterance target_language_code |
| Fragment names ("मेरा नाम") | LLM saved "my name" as the actual name | `96b458d` | NAME_FRAGMENTS + isValidFieldValue |
| Doubled "Aapka naam kya hai?" | Ritu re-asked 3× when patient unclear | `5028ff3` + `bbd9155` | tokenized backchannel, echo blanking, generation ID |
| Bare sentinels → wrong fallback | "Ji aap continue karein" fired after long turns | `bbd9155` | empty-response silence |
| Ghost transcripts ("तथा ना") | LLM responded to noise | `be69ceb` | ghost transcript filter (question gate) |
| STT misreads → Tamil "சरि" | wrong language transcribed | `5028ff3` | reverted STT to language-code=hi-IN |
| Barge-in not stopping TTS | "Ritu won't shut up" | `bbd9155` | cancellable TTS WS + abort() |
| VAD over-triggering | constant ghost transcripts | `bbd9155` | high_vad_sensitivity=false |
| LLM emergency miss (Scout) | model treated heart-attack call as routine booking | `25b07a8` | deterministic detectEmergency() + handleEmergency() — §11A |

---

## 15. Things the streaming refactor explicitly MAY change (Tier 2)

These behaviors can be reordered as long as the patient-facing outcome matches:

1. **When `cleanResponse()` is applied.** Today: once on the full text. Streaming: per-sentence on accumulated head. Both must produce identical final stripped text.
2. **When sentinels are extracted.** Today: from full text after LLM completes. Streaming: same — sentinels are at end-of-response so accumulate the whole thing before extraction. State updates fire at end-of-turn regardless.
3. **When TTS WS opens.** Today: once per `speak()`. Streaming: persistent across sentences within one turn (optional optimization).
4. **When `_lastRituText` is set.** Today: at `speak()` entry, set to the full text. Streaming: updated incrementally as sentences are spoken, finalized at end. Echo detection must work in both modes.
5. **When mark `ritu_done` is emitted.** Today: after silence tail + flush. Streaming: same — emitted once per turn after the LAST sentence's audio drains and the silence tail is sent. `onRituDone()` triggers exactly once per turn.

---

## 16. New surface area in this refactor (Tier 3)

The refactor introduces these new code paths, all behind `ENABLE_LLM_STREAMING=true`:

**As-built (commit on feature/llm-streaming):**

1. **`brain-streaming.js: getResponseStream(history, phone, opts)`** — async generator. Streams via `streamWithFailover`, accumulates the raw text, and:
   - Yields `{ kind: 'sentence', text }` for each completed sentence of the **spoken region** (text before the first sentinel line). Sentence boundaries are `।`, `॥`, `.`, `?`, `!`. Emits up to the *last* boundary in the buffer so short sentences flush together (no choppy 2-word TTS calls).
   - Defensive booking sniffer: if `BOOK_APPOINTMENT`/`UPDATE_APPOINTMENT` appears **before** anything was spoken → yields `{ kind: 'fallback-required' }` and stops. (Primary guard is phase-gating in the dispatch — see #5 — so this rarely fires.)
   - On completion → yields `{ kind: 'done', result }` with the non-booking subset of `getResponse()`'s shape (`text`, `patientName`, `reason`, `emergency`, `endCall`, `bookingIntentLeaked`, `provider`, `ttftMs`).
   - On stream error → yields `{ kind: 'fallback-required', reason }`.
2. **`brain-streaming.js: nextSentence(spokenText, fromIndex)`** — returns the next complete sentence (cleaned) + its raw length, or null if no boundary yet.
3. **`brain-streaming.js: scanForBookingIntent(accumulated)`** + **`spokenRegion(accumulated)`** — booking detection + spoken-vs-sentinel split. Unit-tested in `test-streaming-helpers.js` (12/12).
4. **`callHandler.js: speakStream(stream, myGen)`** — iterates the generator, speaks each sentence via `_speakSentence()` (per-sentence `streamTTS`, carrying `_ttsTail` across sentences for gapless audio), checks `myGen !== _generationId` (barge-in) and `_emergencyTriggered` between sentences, sets `_lastRituText` cumulatively, and emits the single `ritu_done`/`ritu_end_call` mark only after the last sentence + silence tail. Returns `{ result }` | `{ discarded }` | `{ fallback, reason }`. Orchestration unit-tested in `test-speakstream.js` (18/18).
5. **`callHandler.js: processIntent(userText, opts)` dispatch** — **phase-gated**: streams only when `config.llm.enableStreaming && !appointmentBooked && phase ∈ {greeting, reason}`. These are the phases where a booking sentinel cannot legitimately occur, so Option B (non-streaming bookings) holds *by construction*, not by mid-stream detection. `processIntentStream()` drives `speakStream`, applies the greeting/reason state subset, and re-runs non-streaming `processIntent(userText, {_noStream:true})` on a `fallback`.

Files added (new):

```
brain-streaming.js          # getResponseStream + nextSentence + scanForBookingIntent + spokenRegion
test-streaming-helpers.js   # 12 offline unit tests for the helpers
test-speakstream.js         # 18 orchestration tests (stubbed TTS, no LLM)
```

Existing files modified:

```
brain.js        # extracted buildMessages(); exported helpers for reuse (no behavior change)
callHandler.js  # processIntent dispatch + processIntentStream + speakStream + _speakSentence
config.js        # enableStreaming flag (DONE)
.env.example     # ENABLE_LLM_STREAMING var (DONE)
```

**Note on the as-built vs original plan:** the original §16 proposed mid-stream booking detection with a `callHandler-streaming.js`. As-built uses **phase-gating** as the primary Option-B guard instead — it's simpler and strictly safer (a booking turn never enters the streaming path, so an already-spoken confirmation can never precede the calendar write). The sniffer remains as a defensive backstop. speakStream lives in callHandler.js (not a separate file) since it needs the instance's audio plumbing.

**Automated validation status:** helper + orchestration tests pass (30/30), full prior suite still green (216/216), flag-OFF confirmed no-op, one real-Scout end-to-end turn drove the streaming path correctly. The §17 browser-harness suite below remains the gate before flipping `ENABLE_LLM_STREAMING=true` in production.

---

## 17. Harness validation suite (Tier 3, gate to flip flag)

Must pass with `ENABLE_LLM_STREAMING=true` before production flip:

| # | Scenario | Pass criterion |
|---|---|---|
| 1-5 | 5 happy-path conversations: greeting → name → reason → time → book → bye | Booking lands; transcript matches non-streaming version (no extra audio, no missed sentinels) |
| 6-8 | 3 reschedule: book → "change time" → confirm | UPDATE_APPOINTMENT fires; calendar updated |
| 9-11 | 3 emergency: trigger keyword (chest pain, saans nahi, behoshi) mid-conversation | Deterministic detector fires BEFORE any LLM call; cached emergency audio plays; `_emergencyTriggered` latched; ritu_end_call mark sent; no LLM turn runs after detection; if any LLM response was already in flight it's discarded |
| 12-14 | 3 barge-in: interrupt Ritu mid-sentence | Audio cuts within 200ms of barge-in transcript; no audio bleeds after `clear` |
| 15-17 | 3 backchannel: say "haan"/"achha" during speech | Ritu keeps speaking; no false barge-in |
| 18-19 | 2 language switch: Hinglish → Marathi → Hindi | TTS language code switches per sentence |
| 20 | Artificial Groq throttle: force failover mid-conversation | Mid-turn provider switch; patient does not hear a discontinuity |
| 21 | Ghost transcript stress: 30s of silence + background noise | Zero `Patient said:` lines in log |
| 22 | Long conversation: 12+ turns | Conversation history correctly trimmed; context preserved; booking still possible at end |
| 23 | Emergency interrupting Ritu mid-sentence ("chest pain ho raha hai" while she's speaking) | Audio cuts within 200ms; cached emergency audio plays; latch holds; subsequent echo of emergency message ignored |
| 24 | Emergency when both LLM providers are throttled / unreachable | Detector still fires (deterministic), cached audio still plays, call still ends — works without any LLM call succeeding |
| 25 | Negative — patient mentions historical "I had chest pain last year" calmly | Documented expected false-positive: detector WILL fire. Accepted trade-off. Verify the cached message plays cleanly and the call ends gracefully. |

Also required: **the same 22 tests pass with `ENABLE_LLM_STREAMING=false` (regression check on non-streaming path)** — refactor must not break the old code path either.

---

## 18. Rollback plan

If any test in §17 fails after the refactor lands on `main`:

1. Set `ENABLE_LLM_STREAMING=false` in Railway (immediate — no code change, no redeploy needed).
2. Voice path falls through to today's non-streaming code. Pilot continues uninterrupted.
3. Debug on the branch. Re-validate. Flip flag again when green.

If the refactor introduces a bug that affects the non-streaming path too (regression in shared code):

1. `git revert <merge-commit>` on main; push.
2. Railway redeploys main.
3. Tag `pre-streaming-stable` (`db1a2e8`) is the known-good if `git revert` fails for any reason: `git reset --hard pre-streaming-stable && git push -f origin main`.

---

## 19. Sign-off checklist (before merging `feature/llm-streaming` → `main`)

- [ ] All 22 harness scenarios pass with flag ON
- [ ] All 22 harness scenarios pass with flag OFF
- [ ] `git diff pre-streaming-stable feature/llm-streaming -- callHandler.js` reviewed line-by-line; every diff is justified by a Tier 2 entry or a new Tier 3 surface
- [ ] `git diff pre-streaming-stable feature/llm-streaming -- sarvam.js` reviewed same way
- [ ] `git diff pre-streaming-stable feature/llm-streaming -- brain.js` reviewed same way
- [ ] No changes to the system prompt content (§13)
- [ ] No changes to any of the §14 bug-fix code paths
- [ ] Sample real-call log (with patient) attached showing streaming-on + booking-turn + barge-in + backchannel all working correctly
