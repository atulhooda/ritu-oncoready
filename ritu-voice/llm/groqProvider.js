// ─── GROQ PROVIDER ───────────────────────────────────────────────────────────
// OpenAI-compatible adapter for Groq's chat completions API.
// Same Llama 3.3 70B weights as SambaNova — different inference stack.
// Acts as the fallback in our two-provider setup (SambaNova primary).

const OpenAI = require('openai');
const { BaseLLMProvider } = require('./baseProvider');
const { withRetry } = require('./retry');
const { accumulateToolCallDeltas, finalizeToolCalls } = require('./toolCallAccumulator');
const { llmHttpsAgent } = require('./httpAgent');

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// Qwen3 models on Groq are reasoning models — they emit a <think>...</think>
// chain-of-thought block before the final answer by default. For voice agent
// use we want the conversational reply only:
//   1. Inject /no_think into the system message (Qwen documented directive)
//      to disable visible reasoning. Reduces completion tokens dramatically
//      (125 → 6 in our smoke test).
//   2. Even with /no_think, Qwen still emits an empty <think></think> block.
//      Strip it from the response so brain.js / TTS never sees it.
const QWEN_THINK_BLOCK = /<think\b[^>]*>[\s\S]*?<\/think>\s*/gi;
function isQwenModel(model) {
  return typeof model === 'string' && model.toLowerCase().startsWith('qwen/');
}
function prepareMessagesForQwen(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const copy = messages.map(m => ({ ...m }));
  const sysIdx = copy.findIndex(m => m.role === 'system');
  if (sysIdx >= 0) {
    // Append directive to existing system message.
    if (!/\/no_think/i.test(copy[sysIdx].content || '')) {
      copy[sysIdx] = { ...copy[sysIdx], content: `${copy[sysIdx].content}\n/no_think` };
    }
  } else {
    // Prepend a minimal system message.
    copy.unshift({ role: 'system', content: '/no_think' });
  }
  return copy;
}
function stripQwenThink(text) {
  if (typeof text !== 'string') return text;
  return text.replace(QWEN_THINK_BLOCK, '').trim();
}

class GroqProvider extends BaseLLMProvider {
  constructor({ apiKey, model = GROQ_DEFAULT_MODEL, timeoutMs = 8000, name = 'groq' } = {}) {
    super({
      name,
      model,
      baseURL: GROQ_BASE_URL,
      apiKey,
      timeoutMs
    });

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      timeout: this.timeoutMs,
      maxRetries: 0, // we handle retry/failover ourselves; don't let the SDK double-dip
      httpAgent: llmHttpsAgent // shared keep-alive socket — see httpAgent.js
    });

    this._isQwen = isQwenModel(this.model);
  }

  // Non-streaming completion. Returns the canonical response shape so brain.js
  // never has to know which provider produced it.
  async complete(messages, options = {}) {
    const startedAt = Date.now();
    const preparedMessages = this._isQwen ? prepareMessagesForQwen(messages) : messages;
    const body = {
      model: this.model,
      messages: preparedMessages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 200
    };
    if (options.tools) body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;
    if (options.stopSequences) body.stop = options.stopSequences;

    const res = await withRetry(
      () => this.client.chat.completions.create(body),
      { label: 'groq.complete' }
    );

    const choice = res.choices?.[0]?.message || {};
    const usage = res.usage || {};
    const rawContent = choice.content || '';
    return {
      content: this._isQwen ? stripQwenThink(rawContent) : rawContent,
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

  // Streaming completion. Yields { content, done } chunks; first chunk
  // carries ttftMs. Token usage isn't reliably returned by Groq's stream,
  // so usage may be null in the final chunk.
  async *stream(messages, options = {}) {
    const startedAt = Date.now();
    const preparedMessages = this._isQwen ? prepareMessagesForQwen(messages) : messages;
    const body = {
      model: this.model,
      messages: preparedMessages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 200,
      stream: true
    };
    if (options.tools) body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;
    if (options.stopSequences) body.stop = options.stopSequences;

    const iter = await this.client.chat.completions.create(body);
    let ttftMs = null;

    // For Qwen we accumulate the entire reply before yielding so we can
    // strip the <think></think> block cleanly — otherwise the open/close
    // tags would arrive in separate chunks and partially leak to the caller.
    // For other models we stream chunks straight through (lower TTFT).
    if (this._isQwen) {
      let buffer = '';
      for await (const chunk of iter) {
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta && ttftMs === null) ttftMs = Date.now() - startedAt;
        if (delta) buffer += delta;
      }
      const stripped = stripQwenThink(buffer);
      if (stripped) yield { content: stripped, done: false, ttftMs };
      yield { content: '', done: true, ttftMs, latencyMs: Date.now() - startedAt, provider: this.name, model: this.model };
      return;
    }

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

  // Tiny no-cost probe — list models (one HEAD-ish call, no inference).
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

module.exports = { GroqProvider };
