import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { REPLIES } from '../../src/control/adminCommands.js';
import { BotSwitch } from '../../src/control/botSwitch.js';
import type { Interpreter } from '../../src/nlu/interpreter.js';
import { lexicalInterpret } from '../../src/nlu/lexical.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { Harness } from '../helpers/harness.js';
import { silentLogger } from '../../src/observability/logger.js';

/**
 * /botoff is a real global kill switch. The seven checks asked for, in order, plus what makes them
 * hold in production: the state survives a full process restart (state file, for the in-memory
 * store), a message from before the switch-on is never answered, and a stale message is ignored.
 */
const ADMIN = '500000001';
let h: Harness;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botstate-'));
  h = new Harness({ adminGateway: new DisabledAdminGateway(), adminIds: [ADMIN] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const noCustomerSends = (hh: Harness, except: string[] = [ADMIN]) => hh.transport.sent.filter((s) => !except.includes(s.chatId));

describe('/botoff kill switch', () => {
  it('Test 1: bot ON → user message → reply works', async () => {
    expect(await h.user('t1').say('deposit nahi hua')).toMatch(/deposit check karne ke liye/);
  });

  it('Test 2: admin /botoff → user message → ZERO reply', async () => {
    expect(await h.user(ADMIN).say('/botoff')).toBe(REPLIES.off);
    const u = h.user('t2');
    expect(await u.say('deposit nahi hua')).toBe('');
    await u.deliver(u.build({ text: 'hello?' }));
    await h.drain();
    expect(noCustomerSends(h)).toHaveLength(0);
    expect(await h.casesOf(u.id)).toHaveLength(0);
    expect(h.folderOf(u.id)).toBe('none');
  });

  it('Test 3: bot OFF → many users → ZERO replies', async () => {
    await h.user(ADMIN).say('/botoff');
    for (let i = 0; i < 12; i++) {
      const u = h.user(`t3-${i}`);
      expect(await u.say(['hi', 'deposit issue', 'withdrawal nahi aaya', 'match cancel points', 'kuch bhi'][i % 5]!)).toBe('');
      await u.deliver(u.build({ text: 'phir se' }));
    }
    expect(await h.drain()).toBe(0);
    expect(noCustomerSends(h)).toHaveLength(0);
  });

  it('Test 4: bot OFF → full restart → user message → ZERO reply (state file brings OFF back with the in-memory store)', async () => {
    const file = join(dir, 'bot-state.json');
    const boot = (store: MemoryStore) => new Harness({ store, adminGateway: new DisabledAdminGateway(), adminIds: [ADMIN], botStateFile: file });
    const first = boot(new MemoryStore());
    await first.app.botSwitch.restore();
    expect(await first.user(ADMIN).say('/botoff')).toBe(REPLIES.off);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ bot_enabled: false });
    // A brand-new process over a brand-new (empty) in-memory store: only the file knows.
    const second = boot(new MemoryStore());
    expect(await second.app.botSwitch.restore()).toBe(false);
    expect(await second.user('t4').say('deposit nahi hua')).toBe('');
    expect(noCustomerSends(second)).toHaveLength(0);
    // An in-process /restart carries the state too.
    const third = boot(new MemoryStore());
    expect(await third.app.botSwitch.restore(false)).toBe(false);
    expect(await third.user('t4b').say('hi')).toBe('');
    // Same over a persistent store: the store's own value wins.
    const shared = new MemoryStore();
    const a = boot(shared);
    await a.user(ADMIN).say('/botoff');
    const b = boot(shared);
    expect(await b.app.botSwitch.restore()).toBe(false);
  });

  it('Test 5: bot OFF → /boton → new user message → reply works', async () => {
    await h.user(ADMIN).say('/botoff');
    expect(await h.user('t5').say('deposit nahi hua')).toBe('');
    expect(await h.user(ADMIN).say('/boton')).toBe(REPLIES.on);
    h.advance(1); // a NEW message, after the switch-on
    expect(await h.user('t5b').say('withdrawal nahi aaya')).toMatch(/withdrawal check karne ke liye/);
  });

  it('Test 6: processing starts → /botoff while the AI runs → AI result arrives → ZERO reply', async () => {
    let flip = false;
    const interpreter: Interpreter = {
      async interpret(input) {
        const result = lexicalInterpret(input); // the "AI result"
        if (flip) {
          flip = false;
          await h.app.botSwitch.set(false); // /botoff lands while the model is still working
        }
        return result;
      },
    };
    h = new Harness({ adminGateway: new DisabledAdminGateway(), adminIds: [ADMIN], interpreter });
    flip = true;
    const u = h.user('t6');
    expect(await u.say('deposit nahi hua')).toBe('');
    expect(noCustomerSends(h)).toHaveLength(0);
    expect(await h.store.outbox.listPending(5)).toHaveLength(0); // nothing waiting to be flushed later
    await h.app.botSwitch.set(true);
    expect(await h.app.outbox.flushPending()).toBe(0);
    expect(noCustomerSends(h)).toHaveLength(0);
  });

  it('Test 7: message queued → /botoff → the queued message is never replied to', async () => {
    const u = h.user('t7');
    await u.deliver(u.build({ text: 'deposit nahi hua' })); // in the queue, not yet run
    expect(await h.user(ADMIN).say('/botoff')).toBe(REPLIES.off);
    expect(await h.drain()).toBe(0); // OFF: not claimed
    expect(noCustomerSends(h)).toHaveLength(0);
    h.advance(1);
    await h.user(ADMIN).say('/boton');
    await h.drain(); // the job now runs and finds a message from before the switch-on
    expect(noCustomerSends(h)).toHaveLength(0);
    expect(await h.casesOf(u.id)).toHaveLength(0);
    expect((await h.store.messages.recent(u.id, 5))[0]?.processedAt).toBeDefined();
  });

  it('a normal user cannot switch the bot on or off', async () => {
    const u = h.user('t8');
    expect(await u.say('/botoff')).toBe('');
    expect(await h.app.botSwitch.isOnNow()).toBe(true);
    await h.user(ADMIN).say('/botoff');
    expect(await u.say('/boton')).toBe('');
    expect(await h.app.botSwitch.isOnNow()).toBe(false);
  });

  it('a stale message (older than the cut-off when the bot gets to it) is never answered', async () => {
    h = new Harness({ adminGateway: new DisabledAdminGateway(), staleSeconds: 300 });
    const u = h.user('t9');
    const old = u.build({ text: 'deposit nahi hua' });
    old.date = new Date(h.clock().getTime() - 10 * 60_000); // sent 10 minutes ago (a restart, a reconnect catch-up)
    await u.deliver(old);
    expect(h.queue.all().filter((j) => j.type === 'turn')).toHaveLength(0);
    expect(await h.drain()).toBe(0);
    expect(u.replies).toHaveLength(0);
    expect(await u.say('deposit nahi hua')).toMatch(/deposit check karne ke liye/); // a fresh one is
  });

  it('the state file is written on every change and read back only when the store is empty', async () => {
    const file = join(dir, 'state.json');
    const store = new MemoryStore();
    const sw = new BotSwitch({ settings: store.settings, log: silentLogger, stateFile: file });
    await sw.set(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).bot_enabled).toBe(false);
    await sw.set(true);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.bot_enabled).toBe(true);
    expect(written.enabled_at).toBeDefined();
    const fresh = new BotSwitch({ settings: new MemoryStore().settings, log: silentLogger, stateFile: file });
    expect(await fresh.restore()).toBe(true);
    expect(await fresh.enabledAt()).toEqual(new Date(written.enabled_at));
  });
});
