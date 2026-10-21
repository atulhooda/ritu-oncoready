// ─── DEEPINFRA PROVIDER ──────────────────────────────────────────────────────
// OpenAI-compatible adapter for DeepInfra's chat completions API.
//
// Default model: meta-llama/Llama-3.3-70B-Instruct-Turbo (FP8 quantized — the
// fast variant). Override via DEEPINFRA_MODEL env if you want the standard
// FP16 version. Both run the same Llama 3.3 70B weights as Groq/SambaNova.
//
// Why include this provider: Groq dev-tier signups are gated, SambaNova free
// tier is rate-limited at 10-30 RPM. DeepInfra has unlimited paid quota at
// ~$0.35/M tokens for the Turbo variant — predictable cost, no daily ceiling.

const OpenAI = require('openai');
const { BaseLLMProvider } = require('./baseProvider');
const { withRetry } = require('./retry');
const { llmHttpsAgent } = require('./httpAgent');
const { accumulateToolCallDeltas, finalizeToolCalls } = require('./toolCallAccumulator');

const DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';
const DEEPINFRA_DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

class DeepinfraProvider extends BaseLLMProvider {
  constructor({ apiKey, model = DEEPINFRA_DEFAULT_MODEL, baseURL = DEEPINFRA_BASE_URL, timeoutMs = 8000 } = {}) {
    super({
      name: 'deepinfra',
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

  async complete(messages, options = {}) {
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
      { label: 'deepinfra.complete' }
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

module.exports = { DeepinfraProvider };
