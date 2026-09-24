import type { Logger } from 'pino';
import { REPLIES } from './adminCommands.js';
import type { UpdateResult } from './updater.js';

/** What one boot of the agent hands back to the supervisor. */
export interface Booted {
  /** Graceful stop: finish in-flight work, disconnect Telegram, close the store. */
  stop(): Promise<void>;
  /** Send a plain message (the restart confirmation, an update failure). */
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
  /** Handed to the admin commands: asks the supervisor for an update + restart. */
  requestRestart: (reply: { chatId: string }) => void;
}

export interface SupervisorOptions {
  boot: (ctx: BootContext) => Promise<Booted>;
  log: Logger;
  /** Re-read configuration (.env) before booting again (in-process restart only). */
  reloadEnv?: () => void;
  /** Pull the latest code from GitHub and build it. Failure keeps the current agent running. */
  update?: () => Promise<UpdateResult>;
  /**
   * Replace this process with a fresh one running the updated code (after the agent is stopped and
   * the instance lock released). `confirm` is what the new process must tell the admin. Never returns.
   * Without it, the restart happens in-process (same code, reloaded .env).
   */
  respawn?: (confirm: { chatId: string; text: string }) => void;
  releaseLock?: () => void;
  maxBootAttempts?: number;
  backoffMs?: (attempt: number) => number;
  exit?: (code: number) => void;
}

/**
 * Keeps exactly one booted agent alive in this process. `/restart` pulls the latest code from
 * GitHub, builds it, stops the running agent cleanly and replaces the process with one running the
 * new code; that new process tells the admin it worked once it is up. If the update fails, nothing
 * is restarted and the admin is told why. SIGINT/SIGTERM stop the agent for good.
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

  /** Update + restart; resolves when the admin has been told (success from the new process, failure from this one). */
  restart(reply: { chatId: string }): Promise<void> {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      const log = this.o.log;
      let update: UpdateResult | undefined;
      if (this.o.update) {
        log.info({ chat: reply.chatId }, 'restart: updating the code first');
        try {
          update = await this.o.update();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log.error({ err }, 'restart: update failed; the running agent is kept as it is');
          await this.current?.sendText(reply.chatId, `${REPLIES.updateFailed}\n${reason}\n${REPLIES.stillRunning}`).catch(() => undefined);
          return;
        }
        log.info({ before: update.before, after: update.after, files: update.files.length, installed: update.installed }, update.files.length ? 'restart: code updated' : 'restart: already up to date');
      }
      const confirm = update ? `${REPLIES.restarted}\nCode: ${update.after}${update.files.length ? ` (${update.files.length} files updated from ${update.before})` : ' (already up to date)'}` : REPLIES.restarted;
      log.info({ chat: reply.chatId }, 'restart: stopping the running agent');
      const old = this.current;
      const previous = await old?.carry().catch(() => undefined);
      await old?.stop().catch((err) => log.warn({ err }, 'restart: stop reported an error; continuing'));
      this.current = undefined;
      if (this.o.respawn) {
        this.o.releaseLock?.();
        log.info('restart: handing over to a new process with the updated code');
        this.o.respawn({ chatId: reply.chatId, text: confirm });
        return;
      }
      this.o.reloadEnv?.();
      this.current = await this.bootWithRetries(previous);
      await this.current.sendText(reply.chatId, confirm).catch((err) => log.warn({ err }, 'restart done, but the confirmation could not be sent'));
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
