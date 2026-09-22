import type { Logger } from 'pino';
import { REPLIES } from './adminCommands.js';

/** What one boot of the agent hands back to the supervisor. */
export interface Booted {
  /** Graceful stop: finish in-flight work, disconnect Telegram, close the store. */
  stop(): Promise<void>;
  /** Send a plain message (the restart confirmation). */
  sendText(chatId: string, text: string): Promise<unknown>;
  /** State to carry into the next boot (the ON/OFF switch when the store is in-memory). */
  carry(): Promise<CarriedState>;
}

export interface CarriedState {
  botOn?: boolean;
}

export interface BootContext {
  /** Nth boot of this process (1 = the first). */
  attempt: number;
  previous?: CarriedState;
  /** Handed to the admin commands: asks the supervisor for a safe restart. */
  requestRestart: (reply: { chatId: string }) => void;
}

export interface SupervisorOptions {
  boot: (ctx: BootContext) => Promise<Booted>;
  log: Logger;
  /** Re-read configuration (.env) before booting again. */
  reloadEnv?: () => void;
  maxBootAttempts?: number;
  backoffMs?: (attempt: number) => number;
  exit?: (code: number) => void;
}

/**
 * Keeps exactly one booted agent alive in this process. `/restart` stops it cleanly, reloads the
 * configuration and boots a fresh one — same process, same instance lock, ON/OFF state preserved —
 * and only then tells the admin it worked. SIGINT/SIGTERM stop it for good.
 */
export class Supervisor {
  private current?: Booted;
  private restarting?: Promise<void>;
  private stopping = false;
  private boots = 0;

  constructor(private readonly o: SupervisorOptions) {}

  async start(): Promise<void> {
    this.current = await this.bootWithRetries(undefined);
  }

  /** Safe restart; resolves when the new agent is up and the admin has been told. */
  restart(reply: { chatId: string }): Promise<void> {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      const log = this.o.log;
      log.info({ chat: reply.chatId }, 'restart: stopping the running agent');
      const old = this.current;
      const previous = await old?.carry().catch(() => undefined);
      await old?.stop().catch((err) => log.warn({ err }, 'restart: stop reported an error; continuing'));
      this.current = undefined;
      this.o.reloadEnv?.();
      this.current = await this.bootWithRetries(previous);
      await this.current.sendText(reply.chatId, REPLIES.restarted).catch((err) => log.warn({ err }, 'restart done, but the confirmation could not be sent'));
      log.info('restart complete');
    })().finally(() => {
      this.restarting = undefined;
    });
    return this.restarting;
  }

  async shutdown(signal: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.o.log.info({ signal }, 'shutting down');
    await this.restarting?.catch(() => undefined);
    await this.current?.stop().catch((err) => this.o.log.warn({ err }, 'stop failed during shutdown'));
    (this.o.exit ?? ((c: number) => process.exit(c)))(0);
  }

  get running(): boolean {
    return !!this.current;
  }

  private async bootWithRetries(previous: CarriedState | undefined): Promise<Booted> {
    const max = this.o.maxBootAttempts ?? 5;
    let lastErr: unknown;
    for (let i = 1; i <= max; i++) {
      this.boots++;
      try {
        return await this.o.boot({ attempt: this.boots, previous, requestRestart: (r) => void this.restart(r).catch((err) => this.o.log.error({ err }, 'restart failed')) });
      } catch (err) {
        lastErr = err;
        const wait = (this.o.backoffMs ?? ((n) => Math.min(30_000, 1000 * 2 ** (n - 1))))(i);
        this.o.log.error({ err, attempt: i, retryInMs: i < max ? wait : undefined }, 'agent failed to start');
        if (i < max) await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
