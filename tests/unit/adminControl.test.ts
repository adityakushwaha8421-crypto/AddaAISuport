import { describe, expect, it, vi } from 'vitest';
import { AdminCommands, parseAdminCommand, REPLIES } from '../../src/control/adminCommands.js';
import { BotSwitch } from '../../src/control/botSwitch.js';
import { Supervisor, type Booted } from '../../src/control/supervisor.js';
import { silentLogger } from '../../src/observability/logger.js';
import { MemoryStore } from '../../src/storage/memory.js';

const fakeTransport = () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  return { sent, sendText: async (chatId: string, text: string) => (sent.push({ chatId, text }), { messageId: sent.length }) };
};

describe('BotSwitch', () => {
  it('defaults to ON, persists changes, and shares them through the store', async () => {
    const store = new MemoryStore();
    const a = new BotSwitch({ settings: store.settings, log: silentLogger, ttlMs: 0 });
    const b = new BotSwitch({ settings: store.settings, log: silentLogger, ttlMs: 0 });
    expect(await a.isOn()).toBe(true);
    await a.set(false);
    expect(await b.isOn()).toBe(false); // another process over the same store sees it
    await b.set(true);
    expect(await a.isOn()).toBe(true);
  });

  it('caches reads briefly and keeps the last state when the store fails', async () => {
    let t = 0;
    const settings = { get: vi.fn(async () => false), set: vi.fn(async () => undefined) };
    const s = new BotSwitch({ settings, log: silentLogger, ttlMs: 1000, clock: () => new Date(t) });
    expect(await s.isOn()).toBe(false);
    expect(await s.isOn()).toBe(false);
    expect(settings.get).toHaveBeenCalledTimes(1);
    t = 2000;
    settings.get.mockRejectedValueOnce(new Error('db down'));
    expect(await s.isOn()).toBe(false); // last known state, not a crash and not a silent ON
  });

  it('seeds a carried-over state only when the store has none', async () => {
    const store = new MemoryStore();
    const s = new BotSwitch({ settings: store.settings, log: silentLogger, ttlMs: 0 });
    await s.seed(false);
    expect(await s.isOn()).toBe(false);
    await s.seed(true); // already stored: ignored
    expect(await s.isOn()).toBe(false);
  });
});

describe('AdminCommands', () => {
  it('parses the three commands, with or without a bot suffix, case-insensitively', () => {
    expect(parseAdminCommand('/boton')).toBe('boton');
    expect(parseAdminCommand(' /BotOff ')).toBe('botoff');
    expect(parseAdminCommand('/restart@fa_bot')).toBe('restart');
    expect(parseAdminCommand('/boton please')).toBeUndefined();
    expect(parseAdminCommand('boton')).toBeUndefined();
    expect(parseAdminCommand(undefined)).toBeUndefined();
  });

  it('only authorised ids (or the owner in Saved Messages) can switch the bot', async () => {
    const store = new MemoryStore();
    const botSwitch = new BotSwitch({ settings: store.settings, log: silentLogger, ttlMs: 0 });
    const t = fakeTransport();
    const restart = vi.fn();
    const admin = new AdminCommands({ admins: ['111', ' 222 '], botSwitch, transport: t, log: silentLogger, onRestart: restart });

    // a customer typing the command: not handled, nothing changes, nothing sent
    expect(await admin.handle({ chatId: '999', messageId: 1, fromUserId: '999', text: '/botoff' })).toBe(false);
    expect(await botSwitch.isOn()).toBe(true);
    expect(t.sent).toHaveLength(0);

    expect(await admin.handle({ chatId: '111', messageId: 2, fromUserId: '111', text: '/botoff' })).toBe(true);
    expect(await botSwitch.isOn()).toBe(false);
    expect(t.sent.at(-1)).toEqual({ chatId: '111', text: REPLIES.off });

    expect(await admin.handle({ chatId: '222', messageId: 3, fromUserId: '222', text: '/BOTON' })).toBe(true);
    expect(await botSwitch.isOn()).toBe(true);
    expect(t.sent.at(-1)).toEqual({ chatId: '222', text: REPLIES.on });

    // the owner in Saved Messages needs no listing
    expect(await admin.handle({ chatId: 'me', messageId: 4, fromUserId: 'me', text: '/restart', owner: true })).toBe(true);
    expect(restart).toHaveBeenCalledWith({ chatId: 'me' });
    expect(t.sent.at(-1)).toEqual({ chatId: 'me', text: REPLIES.updating }); // the success confirmation comes later, from the new process

    // ordinary text from an admin is not a command
    expect(await admin.handle({ chatId: '111', messageId: 5, fromUserId: '111', text: 'hello' })).toBe(false);
  });

  it('says so when a restart is not possible in this process', async () => {
    const store = new MemoryStore();
    const t = fakeTransport();
    const admin = new AdminCommands({ admins: ['1'], botSwitch: new BotSwitch({ settings: store.settings, log: silentLogger }), transport: t, log: silentLogger });
    await admin.handle({ chatId: '1', messageId: 1, fromUserId: '1', text: '/restart' });
    expect(t.sent.at(-1)?.text).toBe(REPLIES.restartUnavailable);
  });
});

describe('Supervisor: /restart', () => {
  const booted = (log: string[], name: string, botOn: boolean): Booted => ({
    stop: async () => void log.push(`${name}:stop`),
    sendText: async (chatId, text) => void log.push(`${name}:send:${chatId}:${text}`),
    carry: async () => ({ botOn }),
  });

  it('stops the old agent, reloads the environment, boots a new one with the carried state, then confirms', async () => {
    const log: string[] = [];
    let n = 0;
    const previous: unknown[] = [];
    const sup = new Supervisor({
      boot: async (ctx) => {
        n++;
        previous.push(ctx.previous);
        log.push(`boot${n}`);
        return booted(log, `a${n}`, n === 1 ? false : true);
      },
      log: silentLogger,
      reloadEnv: () => log.push('reload-env'),
    });
    await sup.start();
    await sup.restart({ chatId: 'admin' });
    expect(log).toEqual(['boot1', 'a1:stop', 'reload-env', 'boot2', 'a2:send:admin:✅ Bot restarted successfully.']);
    expect(previous).toEqual([undefined, { botOn: false }]); // the OFF state travelled into the new boot
  });

  it('a second /restart while one is running joins it; boot failures are retried', async () => {
    const log: string[] = [];
    let n = 0;
    const sup = new Supervisor({
      boot: async () => {
        n++;
        if (n === 2) throw new Error('telegram unreachable');
        return booted(log, `a${n}`, true);
      },
      log: silentLogger,
      backoffMs: () => 1,
    });
    await sup.start();
    await Promise.all([sup.restart({ chatId: 'x' }), sup.restart({ chatId: 'x' })]);
    expect(n).toBe(3); // first boot, one failed attempt, one good one
    expect(log.filter((l) => l.includes(':send:'))).toHaveLength(1);
  });

  it('with an updater and a respawn hook: update, stop, release the lock, hand over — the confirmation carries the commit', async () => {
    const log: string[] = [];
    const sup = new Supervisor({
      boot: async () => booted(log, 'a', true),
      log: silentLogger,
      update: async () => (log.push('update'), { before: 'abc1234', after: 'def5678', files: ['src/app.ts', 'README.md'], commits: ['def5678 Fix the thing', 'bcd2345 Add a test'], subject: 'Fix the thing', installed: false }),
      releaseLock: () => log.push('release-lock'),
      respawn: (c) => log.push(`respawn:${c.chatId}:${c.text.replace(/\n/g, ' | ')}`),
    });
    await sup.start();
    await sup.restart({ chatId: 'admin' });
    expect(log).toEqual([
      'update',
      'a:send:admin:📥 Pulled 2 commits (abc1234 → def5678):\n• def5678 Fix the thing\n• bcd2345 Add a test\n2 files changed in src/app.ts, README.md.\nBuilt. Restarting…',
      'a:stop', 'release-lock',
      'respawn:admin:✅ Bot restarted successfully. | Running def5678 — Fix the thing',
    ]);
    expect(sup.running).toBe(false);
  });

  it('when the update fails, nothing restarts: the running agent stays and the admin is told why', async () => {
    const log: string[] = [];
    const sup = new Supervisor({
      boot: async () => booted(log, 'a', true),
      log: silentLogger,
      update: async () => {
        throw new Error('git pull failed: fatal: unable to access origin');
      },
      respawn: () => log.push('respawn'),
    });
    await sup.start();
    await sup.restart({ chatId: 'admin' });
    expect(log).toEqual(['a:send:admin:⚠️ Update failed.\ngit pull failed: fatal: unable to access origin\nThe bot is still running on the previous code.']);
    expect(sup.running).toBe(true);
  });

  it('a restart signal from the machine is the same restart, confirmed in Saved Messages', async () => {
    const log: string[] = [];
    const sup = new Supervisor({
      boot: async () => ({ ...booted(log, 'a', true), ownChatId: 'self' }),
      log: silentLogger,
      update: async () => ({ before: 'a', after: 'a', files: [], commits: [], subject: 'Same code', installed: false }),
      respawn: (c) => log.push(`respawn:${c.chatId}:${c.text.split('\n')[0]}`),
    });
    await sup.start();
    await sup.restartFromSignal();
    expect(log).toEqual(['a:send:self:📥 Already up to date: a — Same code\nRebuilt. Restarting…', 'a:stop', 'respawn:self:✅ Bot restarted successfully.']);
  });

  it('shutdown stops the agent and exits once', async () => {
    const log: string[] = [];
    const exit = vi.fn();
    const sup = new Supervisor({ boot: async () => booted(log, 'a', true), log: silentLogger, exit });
    await sup.start();
    await sup.shutdown('SIGTERM');
    await sup.shutdown('SIGINT');
    expect(log).toEqual(['a:stop']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
