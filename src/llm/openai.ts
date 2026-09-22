import OpenAI from 'openai';
import type { Logger } from 'pino';
import { Semaphore } from '../util/rateLimiter.js';
import type { Metrics } from '../observability/metrics.js';
import { scrubber } from '../security/scrubber.js';
import { LlmUnavailableError, type ContentPart, type JsonSchema, type LlmClient, type LlmRequestBase } from './client.js';

export interface OpenAiLlmOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  visionModel: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  timeoutMs: number;
  log: Logger;
  metrics?: Metrics;
  /** Concurrent API calls per process (default 8). */
  maxConcurrency?: number;
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toContent(user: string | ContentPart[]): OpenAI.Chat.Completions.ChatCompletionContentPart[] | string {
  if (typeof user === 'string') return user;
  return user.map((p) =>
    p.type === 'text'
      ? { type: 'text' as const, text: p.text }
      : { type: 'image_url' as const, image_url: { url: `data:${p.mimeType};base64,${p.data.toString('base64')}`, detail: p.detail ?? 'high' } },
  );
}

/** OpenAI Chat Completions with strict JSON-schema structured outputs. */
export class OpenAiLlm implements LlmClient {
  readonly available = true;
  private readonly client: OpenAI;
  private readonly slots: Semaphore;

  constructor(private readonly opts: OpenAiLlmOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs, maxRetries: 2 });
    this.slots = new Semaphore(opts.maxConcurrency ?? 8);
  }

  /** Bounded: a traffic spike queues here instead of opening hundreds of API calls at once. */
  private call(req: LlmRequestBase, responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format']) {
    return this.slots.run(() => this.callNow(req, responseFormat));
  }

  private async callNow(req: LlmRequestBase, responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format']) {
    const model = req.model === 'vision' ? this.opts.visionModel : this.opts.model;
    const messages: Msg[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: toContent(req.user) as never },
    ];
    const started = Date.now();
    try {
      const res = await this.client.chat.completions.create({
        model,
        messages,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
        max_completion_tokens: req.maxTokens ?? 2000,
      });
      this.opts.metrics?.llmCalls.inc({ purpose: req.purpose, outcome: 'ok' });
      const choice = res.choices[0];
      if (choice?.message?.refusal) throw new Error(`Model refused: ${choice.message.refusal}`);
      const content = choice?.message?.content;
      if (!content) throw new Error(`Empty completion (finish_reason=${choice?.finish_reason})`);
      return content;
    } catch (err) {
      this.opts.metrics?.llmCalls.inc({ purpose: req.purpose, outcome: 'error' });
      const status = (err as { status?: number }).status;
      this.opts.log.warn({ purpose: req.purpose, status, err: scrubber.scrub(String((err as Error).message)) }, 'llm call failed');
      if (status === 401 || status === 403 || status === 429 || status === undefined || status >= 500) {
        throw new LlmUnavailableError((err as Error).message);
      }
      throw err;
    } finally {
      this.opts.metrics?.llmLatency.observe(Date.now() - started, { purpose: req.purpose });
    }
  }

  async json<T>(req: LlmRequestBase & { schema: JsonSchema }): Promise<T> {
    const content = await this.call(req, {
      type: 'json_schema',
      json_schema: { name: req.schema.name, schema: req.schema.schema, strict: true },
    });
    return JSON.parse(content) as T;
  }

  async text(req: LlmRequestBase): Promise<string> {
    return (await this.call(req)).trim();
  }
}
