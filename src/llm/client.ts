/** Provider-agnostic LLM surface used by the interpreter, vision extractor and composer. */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: Buffer; detail?: 'low' | 'high' | 'auto' };

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmRequestBase {
  /** Short label for metrics/logging: interpret, vision, compose, summary… */
  purpose: string;
  system: string;
  user: string | ContentPart[];
  model?: 'default' | 'vision';
  maxTokens?: number;
}

export interface LlmClient {
  readonly available: boolean;
  json<T>(req: LlmRequestBase & { schema: JsonSchema }): Promise<T>;
  text(req: LlmRequestBase): Promise<string>;
}

export class LlmUnavailableError extends Error {}

/** Used when no API key is configured: callers fall back to deterministic paths. */
export class DisabledLlm implements LlmClient {
  readonly available = false;
  async json<T>(): Promise<T> {
    throw new LlmUnavailableError('LLM disabled');
  }
  async text(): Promise<string> {
    throw new LlmUnavailableError('LLM disabled');
  }
}
