import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { SettingsRepo } from '../storage/types.js';

const KEY = 'bot.enabled';
const ENABLED_AT = 'bot.enabledAt';

interface StateFile {
  bot_enabled: boolean;
  changed_at: string;
  enabled_at?: string;
}

/**
 * The agent's global ON/OFF switch (`bot_enabled`), persisted in the store so every process sees
 * the same state and it survives restarts. OFF means no automatic reply of any kind.
 *
 * It is also mirrored to a small state file: with the in-memory store the settings table is gone
 * after a process restart, and the file is what brings OFF back. The store wins whenever it holds a
 * value (Postgres); the file only seeds an empty store. Reads used for decisions go to the store
 * (`isOnNow`); a store that cannot be read keeps the last known state rather than failing a turn.
 */
export class BotSwitch {
  private cache?: { on: boolean; at: number };
  private readonly ttlMs: number;

  constructor(private readonly o: { settings: SettingsRepo; log: Logger; ttlMs?: number; clock?: () => Date; stateFile?: string }) {
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
    return this.isOnNow();
  }

  /**
   * The state right now, read from the store (not the cache): for every check that decides whether
   * an action may happen (a turn, a send, a forward). A store that cannot be read falls back to the
   * cached state so a blip never silences or un-silences the agent on its own.
   */
  async isOnNow(): Promise<boolean> {
    try {
      const on = await this.current();
      this.cache = { on, at: this.now() };
      return on;
    } catch (err) {
      this.o.log.warn({ err }, 'could not read the bot switch; keeping the last known state');
      return this.cache?.on ?? true;
    }
  }

  /** When the agent was last switched ON (undefined: never switched, on since forever). Messages from before it are never answered. */
  async enabledAt(): Promise<Date | undefined> {
    try {
      const v = await this.o.settings.get(ENABLED_AT);
      return typeof v === 'string' ? new Date(v) : undefined;
    } catch {
      return undefined;
    }
  }

  async set(on: boolean): Promise<void> {
    const at = new Date(this.now()).toISOString();
    await this.o.settings.set(KEY, on);
    if (on) await this.o.settings.set(ENABLED_AT, at);
    this.cache = { on, at: this.now() };
    this.writeFile({ bot_enabled: on, changed_at: at, enabled_at: on ? at : this.readFile()?.enabled_at });
    this.o.log.info({ on }, on ? 'bot switched ON' : 'bot switched OFF: no automatic replies');
  }

  /**
   * At boot: the store's value stands; an empty store is seeded from the in-process carry-over
   * (a /restart) or else from the state file (a full restart with the in-memory store). Nothing
   * saved anywhere → ON.
   */
  async restore(carried?: boolean): Promise<boolean> {
    const stored = await this.o.settings.get(KEY);
    if (typeof stored === 'boolean') {
      this.writeFile({ bot_enabled: stored, changed_at: new Date(this.now()).toISOString(), enabled_at: await this.enabledAt().then((d) => d?.toISOString()) });
      return stored;
    }
    const file = this.readFile();
    const on = carried ?? file?.bot_enabled ?? true;
    await this.o.settings.set(KEY, on);
    if (file?.enabled_at && !(await this.o.settings.get(ENABLED_AT))) await this.o.settings.set(ENABLED_AT, file.enabled_at);
    this.cache = { on, at: this.now() };
    if (!on) this.o.log.warn({ from: carried !== undefined ? 'previous instance' : 'state file' }, 'bot is OFF (restored): no automatic replies until /boton');
    return on;
  }

  /** @deprecated use restore() */
  async seed(on: boolean): Promise<void> {
    await this.restore(on);
  }

  private readFile(): StateFile | undefined {
    if (!this.o.stateFile) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.o.stateFile, 'utf8')) as Partial<StateFile>;
      return typeof parsed.bot_enabled === 'boolean' ? { bot_enabled: parsed.bot_enabled, changed_at: String(parsed.changed_at ?? ''), enabled_at: parsed.enabled_at } : undefined;
    } catch {
      return undefined;
    }
  }

  private writeFile(state: StateFile) {
    if (!this.o.stateFile) return;
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      writeFileSync(this.o.stateFile, JSON.stringify(state, null, 2) + '\n');
    } catch (err) {
      this.o.log.warn({ err }, 'could not write the bot state file');
    }
  }
}
