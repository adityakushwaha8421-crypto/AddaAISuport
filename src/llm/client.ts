/** Provider-agnostic LLM surface. Used for one thing today: telling deposit from withdrawal. */

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmRequestBase {
  /** Short label for metrics/logging. */
  purpose: string;
  system: string;
  user: string;
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
