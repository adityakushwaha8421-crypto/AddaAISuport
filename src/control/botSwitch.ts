import type { Logger } from 'pino';
import type { SettingsRepo } from '../storage/types.js';

const KEY = 'bot.enabled';

/**
 * The agent's ON/OFF switch, persisted in the store so every process sees the same state and it
 * survives restarts. OFF means no automatic reply of any kind. Reads are cached briefly; a store
 * that cannot be read keeps the last known state (defaulting to ON) rather than failing a turn.
 */
export class BotSwitch {
  private cache?: { on: boolean; at: number };
  private readonly ttlMs: number;

  constructor(private readonly o: { settings: SettingsRepo; log: Logger; ttlMs?: number; clock?: () => Date }) {
    this.ttlMs = o.ttlMs ?? 2000;
  }

  private now() {
    return (this.o.clock?.() ?? new Date()).getTime();
  }

  /** Current state, from the store (no cache). Missing → ON. */
  async current(): Promise<boolean> {
    const v = await this.o.settings.get(KEY);
    return typeof v === 'boolean' ? v : true;
  }

  async isOn(): Promise<boolean> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.on;
    try {
      const on = await this.current();
      this.cache = { on, at: this.now() };
      return on;
    } catch (err) {
      this.o.log.warn({ err }, 'could not read the bot switch; keeping the last known state');
      return this.cache?.on ?? true;
    }
  }

  async set(on: boolean): Promise<void> {
    await this.o.settings.set(KEY, on);
    this.cache = { on, at: this.now() };
    this.o.log.info({ on }, on ? 'bot switched ON' : 'bot switched OFF: no automatic replies');
  }

  /** Persist a state carried over from a previous run when the store holds none yet (in-memory store across an in-process restart). */
  async seed(on: boolean): Promise<void> {
    if ((await this.o.settings.get(KEY)) === undefined) await this.set(on);
  }
}
