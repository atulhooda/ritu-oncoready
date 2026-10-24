// ─── BASE LLM PROVIDER ───────────────────────────────────────────────────────
// Abstract contract for all LLM providers. Concrete providers (Groq, SambaNova,
// future Fireworks/DeepInfra/Together/Cerebras) implement complete(), stream(),
// and healthCheck() while sharing the same response shape so brain.js doesn't
// know or care which one is hitting the wire.

class BaseLLMProvider {
  constructor(config) {
    if (!config || !config.name) throw new Error('LLM provider config.name required');
    if (!config.model) throw new Error('LLM provider config.model required');
    if (!config.baseURL) throw new Error('LLM provider config.baseURL required');
    if (!config.apiKey) throw new Error(`LLM provider ${config.name} requires apiKey`);

    this.name = config.name;
    this.model = config.model;
    this.baseURL = config.baseURL;
    this.apiKey = config.apiKey;
    // Subclasses set this — used by failover wrapper to bound the wait.
    this.timeoutMs = config.timeoutMs || 8000;
  }

  // Non-streaming chat completion.
  //
  // messages: OpenAI-shape array  [{ role, content }, ...]
  // options:  { temperature, maxTokens, tools, toolChoice, stopSequences }
  //
  // Returns: {
  //   content:   string,            // assistant text reply
  //   toolCalls: Array | null,      // OpenAI-shape tool_calls (pass-through)
  //   usage:     { prompt, completion, total },  // token counts
  //   latencyMs: number,            // total wall-clock
  //   provider:  string,            // this.name
  //   model:     string             // this.model
  // }
  async complete(/* messages, options */) {
    throw new Error(`${this.constructor.name} must implement complete()`);
  }

  // Streaming chat completion. Yields incremental chunks.
  //
  // Yields: { content: string, done: boolean, ttftMs?: number, usage?: object }
  //   - First yielded chunk includes ttftMs (time to first token).
  //   - Last chunk has done: true. usage may be present if the provider
  //     returns it on the final chunk.
  async *stream(/* messages, options */) {
    throw new Error(`${this.constructor.name} must implement stream()`);
    // eslint-disable-next-line no-unreachable
    yield;
  }

  // Lightweight liveness probe. Should be cheap (no real inference).
  // Returns: { ok: boolean, latencyMs: number, error?: string }
  async healthCheck() {
    throw new Error(`${this.constructor.name} must implement healthCheck()`);
  }
}

module.exports = { BaseLLMProvider };
