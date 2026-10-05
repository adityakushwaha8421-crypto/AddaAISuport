/** Provider-agnostic LLM surface: what a message is about, and reading a withdrawal screenshot. */

/** One part of a user turn: text, or an image the model should look at. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: Buffer; detail?: 'low' | 'high' | 'auto' };

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmRequestBase {
  /** Short label for metrics/logging. */
  purpose: string;
  system: string;
  user: string | ContentPart[];
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
