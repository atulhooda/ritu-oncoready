// ─── GEMINI PROVIDER ─────────────────────────────────────────────────────────
// OpenAI-compatible adapter for Google's Gemini API.
//
// Default model: gemini-3.1-flash-lite — fast (~0.7s reply), native tool-calling,
// excellent Devanagari (Hindi/Marathi), NO daily token cap, billable from India
// in INR. Chosen over 2.5-flash-lite because 2.5's OpenAI-compat shim returns an
// EMPTY assistant message after a tool result on tool_choice:'auto' (verified
// 6/6 empty); 3.1 returns a clean reply 6/6. Override via GEMINI_MODEL.
//
// Why include this provider: Groq's daily TPD (~500K/day on Scout ≈ ~15 calls)
// caps daily volume, and Groq paid is gated. Gemini Flash-Lite has no daily cap
// and is India-payable — the right OVERFLOW/fallback once Groq's free quota is
// spent (≈1.0s TTFT on our prompt vs Groq's ~0.5s, but far better than
// DeepInfra's 1.6-5.7s). Auth is a standard Bearer key on the OpenAI-compat
// endpoint (works with both AIza… and AQ.… key formats).

const OpenAI = require('openai');
const { BaseLLMProvider } = require('./baseProvider');
const { withRetry } = require('./retry');
const { llmHttpsAgent } = require('./httpAgent');
const { accumulateToolCallDeltas, finalizeToolCalls } = require('./toolCallAccumulator');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';

// ── Gemini-safe message flattening ───────────────────────────────────────────
// Gemini's OpenAI-compat shim is far stricter than OpenAI/Groq about tool
// rounds. During FAILOVER the message history carries an assistant message with
// tool_calls + tool-role results that were produced by ANOTHER provider
// (Scout/Groq) — foreign tool_call ids, and an empty-string assistant `content`
// that Gemini maps to an empty text "Part", which its native API rejects with a
// bare `400 (no body)`. That's the bug that spammed "माफ़ कीजिए, ज़रा दोबारा
// बताइए" 21× in one call once Groq was rate-limited.
//
// Fix: Gemini never needs to SEE tool_calls/tool messages to speak the reply —
// it only needs the tool RESULTS as context. So flatten every tool round into
// plain text (assistant tool-call → short note, tool result → user message) and
// merge consecutive same-role turns. No tool-format = nothing for Gemini to choke
// on. A fresh round with no tool history passes through unchanged.
function geminiSafeMessages(messages) {
  const flat = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      flat.push({ role: 'user', content: `[tool result${m.name ? ' · ' + m.name : ''}]: ${m.content ?? ''}` });
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const names = m.tool_calls.map((t) => t.function?.name).filter(Boolean).join(', ');
      flat.push({ role: 'assistant', content: (m.content && m.content.trim()) ? m.content : `(${names || 'tool'} chalaya)` });
    } else if (m.role === 'assistant' && (m.content == null || m.content === '')) {
      continue; // empty assistant turn → empty text Part → 400; drop it
    } else {
      flat.push(m);
    }
  }
  // Merge consecutive same-role turns (Gemini wants alternating user/model).
  const merged = [];
  for (const m of flat) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') {
      last.content += '\n' + m.content;
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

class GeminiProvider extends BaseLLMProvider {
  constructor({ apiKey, model = GEMINI_DEFAULT_MODEL, baseURL = GEMINI_BASE_URL, timeoutMs = 8000 } = {}) {
    super({
      name: 'gemini',
      model,
      baseURL,
      apiKey,
      timeoutMs
    });

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      timeout: this.timeoutMs,
      maxRetries: 0,
      httpAgent: llmHttpsAgent // shared keep-alive socket — see httpAgent.js
    });
  }

  // Build the request body, optionally overriding tool_choice.
  _body(messages, options, toolChoiceOverride, stream = false) {
    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 200
    };
    if (options.tools) body.tools = options.tools;
    const tc = toolChoiceOverride !== undefined ? toolChoiceOverride : options.toolChoice;
    if (tc) body.tool_choice = tc;
    if (options.stopSequences) body.stop = options.stopSequences;
    // ─── ASK FOR THE TOKEN COUNTS, OR THE STREAM RETURNS NONE ────────────────
    // The compat endpoint sends usage on a streamed request ONLY when
    // stream_options.include_usage is set. Without it every streamed turn
    // reports no prompt tokens, no completion tokens and no cached tokens —
    // and production runs the streaming path, so the [LLM] log line has been
    // silent about all three since the day it was written.
    //
    // That silence was read as evidence: the ABSENT cached= field was taken to
    // mean Gemini was not caching, and a plan was built on it. Measured
    // 2026-08-22, the compat endpoint caches fine — it was never asked to say so.
    // "Absent" and "zero" must not look the same.
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  // True when the last message is a tool result — i.e. this call should produce
  // the spoken reply. Gemini's OpenAI-compat returns an EMPTY assistant message
  // if tools are offered with tool_choice:'auto' on these rounds, so we force
  // 'none' (which reliably generates the text) and skip the wasted round-trip.
  _isReplyRound(messages, options) {
    return !!options.tools && messages.length > 0 && messages[messages.length - 1]?.role === 'tool';
  }

  async complete(messages, options = {}) {
    const startedAt = Date.now();
    const replyRound = this._isReplyRound(messages, options); // computed on ORIGINAL roles
    const safe = geminiSafeMessages(messages);                // flatten tool rounds for Gemini

    let res = await withRetry(
      () => this.client.chat.completions.create(this._body(safe, options, replyRound ? 'none' : undefined)),
      { label: 'gemini.complete' }
    );
    let choice = res.choices?.[0]?.message || {};

    // Backstop: if a NON-reply round still comes back empty, force text once.
    if (options.tools && !replyRound && !choice.content && !(choice.tool_calls && choice.tool_calls.length)) {
      console.warn(`[gemini] empty reply — retrying with tool_choice:none`);
      res = await withRetry(
        () => this.client.chat.completions.create(this._body(safe, options, 'none')),
        { label: 'gemini.complete.retry' }
      );
      choice = res.choices?.[0]?.message || {};
    }

    const usage = res.usage || {};
    return {
      content: choice.content || '',
      toolCalls: choice.tool_calls || null,
      usage: {
        prompt: usage.prompt_tokens ?? null,
        completion: usage.completion_tokens ?? null,
        total: usage.total_tokens ?? null,
        // CACHED INPUT TOKENS — and what this field actually told us.
        //
        // Our system prompt is ~2,650 tokens and is resent on EVERY turn; across
        // a 10-turn call that is ~38,000 input tokens against a few hundred
        // output, a 64:1 ratio. Google bills cached input roughly ten times
        // cheaper, so caching looked like most of the LLM bill.
        //
        // THE ORIGINAL HYPOTHESES HERE WERE BOTH WRONG. This comment used to
        // blame the OpenAI-compatibility endpoint. Measured 2026-08-22 against
        // the live API on gemini-3.1-flash-lite:
        //   · the compat endpoint DOES implicit-cache and DOES report
        //     cached_tokens — 8,167 of 11,512 tokens on 5 of 6 sequential calls.
        //     The endpoint was never the problem.
        //   · implicit caching has a SIZE FLOOR of roughly 5,800-7,200 prompt
        //     tokens. Prefixes of 1,102 / 2,183 / 3,623 / 4,343 / 5,063 / 5,783
        //     never cached across repeats. We send ~3,533 tokens per turn, so we
        //     are about 2x below the floor and no prompt REORDER can change that.
        //   · only explicit CachedContent works at our size, it is native-API
        //     only, and its storage is rented per token-hour — which at 150
        //     calls/month/clinic costs more than it saves. See docs/ROADMAP.md.
        //
        // And the reason the field looked like evidence at all: the streaming
        // body never set stream_options.include_usage, so streamed turns
        // reported NO usage of any kind. An absent cached= was read as "not
        // caching" when it meant "never asked". That is fixed in _body above.
        //
        // null = the provider said nothing. 0 = it said nothing was cached.
        // Those are different facts and must stay distinguishable.
        cached: usage.prompt_tokens_details?.cached_tokens ?? null
      },
      latencyMs: Date.now() - startedAt,
      provider: this.name,
      model: this.model
    };
  }

  async *stream(messages, options = {}) {
    const startedAt = Date.now();
    const replyRound = this._isReplyRound(messages, options); // computed on ORIGINAL roles
    const safe = geminiSafeMessages(messages);                // flatten tool rounds for Gemini
    const iter = await this.client.chat.completions.create(
      Object.assign(this._body(safe, options, replyRound ? 'none' : undefined, true), { stream: true })
    );
    let ttftMs = null;
    let anyContent = false;
    // The usage chunk arrives LAST and carries empty choices, so it must be
    // read outside the delta handling below or it is discarded silently.
    let usage = null;

    const toolAcc = [];
    for await (const chunk of iter) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content || '';
      if ((delta || choice?.delta?.tool_calls) && ttftMs === null) ttftMs = Date.now() - startedAt;
      if (delta) { anyContent = true; yield { content: delta, done: false, ttftMs }; }
      if (choice?.delta?.tool_calls) accumulateToolCallDeltas(toolAcc, choice.delta.tool_calls);
      if (chunk.usage) usage = {
        prompt: chunk.usage.prompt_tokens ?? null,
        completion: chunk.usage.completion_tokens ?? null,
        total: chunk.usage.total_tokens ?? null,
        // null when the provider said nothing; 0 when it said "nothing cached".
        cached: chunk.usage.prompt_tokens_details?.cached_tokens ?? null,
      };
    }
    const toolCalls = finalizeToolCalls(toolAcc);

    // Backstop: if a NON-reply round produced nothing, retry forcing text.
    if (options.tools && !replyRound && !anyContent && !toolCalls) {
      console.warn(`[gemini] empty streamed reply — retrying with tool_choice:none`);
      try {
        const retry = await this.client.chat.completions.create(Object.assign(this._body(safe, options, 'none'), { stream: false }));
        const txt = retry.choices?.[0]?.message?.content || '';
        if (txt) { if (ttftMs === null) ttftMs = Date.now() - startedAt; yield { content: txt, done: false, ttftMs }; }
      } catch (e) { console.warn(`[gemini] stream retry failed: ${e.message}`); }
    }

    yield { content: '', done: true, ttftMs, toolCalls, usage, latencyMs: Date.now() - startedAt, provider: this.name, model: this.model };
  }

  async healthCheck() {
    const startedAt = Date.now();
    try {
      await this.client.models.list();
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: err.message };
    }
  }
}

module.exports = { GeminiProvider, geminiSafeMessages };
