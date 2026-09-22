import { LlmUnavailableError, type JsonSchema, type LlmClient, type LlmRequestBase } from './client.js';

type Handler = (req: LlmRequestBase & { schema?: JsonSchema }) => unknown | Promise<unknown>;

/**
 * Deterministic LLM for tests and offline development. Register a handler per `purpose`;
 * unregistered purposes throw LlmUnavailableError so callers exercise their fallback paths.
 */
export class ScriptedLlm implements LlmClient {
  readonly available = true;
  readonly calls: Array<{ purpose: string; req: LlmRequestBase }> = [];
  private readonly handlers = new Map<string, Handler>();

  on(purpose: string, handler: Handler): this {
    this.handlers.set(purpose, handler);
    return this;
  }

  private async run(req: LlmRequestBase & { schema?: JsonSchema }) {
    this.calls.push({ purpose: req.purpose, req });
    const h = this.handlers.get(req.purpose);
    if (!h) throw new LlmUnavailableError(`No scripted handler for ${req.purpose}`);
    return h(req);
  }

  async json<T>(req: LlmRequestBase & { schema: JsonSchema }): Promise<T> {
    return (await this.run(req)) as T;
  }

  async text(req: LlmRequestBase): Promise<string> {
    return String(await this.run(req));
  }
}
