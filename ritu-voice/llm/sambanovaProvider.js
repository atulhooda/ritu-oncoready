// ─── SAMBANOVA PROVIDER ──────────────────────────────────────────────────────
// OpenAI-compatible adapter for SambaNova Cloud's chat completions API.
// Verified against https://docs.sambanova.ai/cloud/docs/get-started/api-keys-urls:
//   baseURL: https://api.sambanova.ai/v1
//   model:   Meta-Llama-3.3-70B-Instruct  (same Llama 3.3 70B as Groq, different stack)
//
// Quirks vs Groq:
//   - 4K context window (much smaller than Groq's 128K). We log a WARN at
//     >3500 prompt tokens and a CRITICAL at >3800 — at 3800 you're one short
//     reply away from a 400. The failover wrapper will catch the overflow
//     anyway, but the early signal lets us tighten history before it bites.
//   - 10-30 RPM on the free tier. Same in-place retry policy as Groq; the
//     failover wrapper takes over after 2 retries.

const OpenAI = require('openai');
const { BaseLLMProvider } = require('./baseProvider');
const { withRetry } = require('./retry');
const { llmHttpsAgent } = require('./httpAgent');
const { accumulateToolCallDeltas, finalizeToolCalls } = require('./toolCallAccumulator');

const SAMBANOVA_BASE_URL = 'https://api.sambanova.ai/v1';
const SAMBANOVA_DEFAULT_MODEL = 'Meta-Llama-3.3-70B-Instruct';

const CONTEXT_WARN_TOKENS = 3500;
const CONTEXT_CRITICAL_TOKENS = 3800;
const CONTEXT_LIMIT_TOKENS = 4096;

// Cheap heuristic for prompt token count when the response hasn't arrived yet.
// Average ~3.5 chars/token for English+Hindi mixed text on Llama tokenizers.
// Good enough for an early-warning log; not a substitute for real token counts
// that arrive in the response's `usage` block.
function estimateTokenCount(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) if (typeof part.text === 'string') chars += part.text.length;
    }
  }
  return Math.ceil(chars / 3.5);
}

class SambanovaProvider extends BaseLLMProvider {
  constructor({ apiKey, model = SAMBANOVA_DEFAULT_MODEL, timeoutMs = 8000 } = {}) {
    super({
      name: 'sambanova',
      model,
      baseURL: SAMBANOVA_BASE_URL,
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

  // Logs an early-warning when the prompt approaches SambaNova's 4K window.
  _warnIfNearContextLimit(messages) {
    const est = estimateTokenCount(messages);
    if (est >= CONTEXT_CRITICAL_TOKENS) {
      console.error(`[LLM] CRITICAL: estimated prompt ${est} tokens — within ${CONTEXT_LIMIT_TOKENS - est} of SambaNova 4K limit. Failover to Groq likely.`);
    } else if (est >= CONTEXT_WARN_TOKENS) {
      console.warn(`[LLM] WARN: estimated prompt ${est} tokens — approaching SambaNova 4K limit (warn at ${CONTEXT_WARN_TOKENS}).`);
    }
    return est;
  }

  async complete(messages, options = {}) {
    this._warnIfNearContextLimit(messages);
    const startedAt = Date.now();

    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 200
    };
    if (options.tools) body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;
    if (options.stopSequences) body.stop = options.stopSequences;

    const res = await withRetry(
      () => this.client.chat.completions.create(body),
      { label: 'sambanova.complete' }
    );

    const choice = res.choices?.[0]?.message || {};
    const usage = res.usage || {};
    return {
      content: choice.content || '',
      toolCalls: choice.tool_calls || null,
      usage: {
        prompt: usage.prompt_tokens ?? null,
        completion: usage.completion_tokens ?? null,
        total: usage.total_tokens ?? null
      },
      latencyMs: Date.now() - startedAt,
      provider: this.name,
      model: this.model
    };
  }

  async *stream(messages, options = {}) {
    this._warnIfNearContextLimit(messages);
    const startedAt = Date.now();

    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 200,
      stream: true
    };
    if (options.tools) body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;
    if (options.stopSequences) body.stop = options.stopSequences;

    const iter = await this.client.chat.completions.create(body);
    let ttftMs = null;

    const toolAcc = [];
    for await (const chunk of iter) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content || '';
      if ((delta || choice?.delta?.tool_calls) && ttftMs === null) ttftMs = Date.now() - startedAt;
      if (delta) yield { content: delta, done: false, ttftMs };
      if (choice?.delta?.tool_calls) accumulateToolCallDeltas(toolAcc, choice.delta.tool_calls);
    }
    yield { content: '', done: true, ttftMs, toolCalls: finalizeToolCalls(toolAcc), latencyMs: Date.now() - startedAt, provider: this.name, model: this.model };
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

module.exports = {
  SambanovaProvider,
  CONTEXT_WARN_TOKENS,
  CONTEXT_CRITICAL_TOKENS,
  CONTEXT_LIMIT_TOKENS,
  estimateTokenCount
};
