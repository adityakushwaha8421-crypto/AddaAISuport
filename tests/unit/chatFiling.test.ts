import bigInt from 'big-integer';
import { Api } from 'telegram';
import { describe, expect, it, vi } from 'vitest';
import { assemble, type App } from '../../src/app.js';
import { ScriptedLlm } from '../../src/llm/fake.js';
import { silentLogger } from '../../src/observability/logger.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { folderTitle, peerChatId } from '../../src/telegram/user/folders.js';
import { MemorySessionStore } from '../../src/telegram/user/sessionStore.js';
import { UserTransport } from '../../src/telegram/user/userTransport.js';
import { folderFor } from '../../src/workflows/chatFiling.js';
import { ADMIN, EXPORT_BOT, FakeTransport, NOW, SUPPORT, customerSends } from '../helpers/fakeTransport.js';

/**
 * Every classified customer message files the chat where the team will look: match matters
 * (including "football add karo") into Match issues, deposit/withdrawal cases and every other
 * support matter into Support, small talk nowhere. Filing never sends anything to the customer,
 * and a human's reply takes the chat out again.
 */
const FOLDERS = { support: 'Support', match: 'Match issues' };
let store: MemoryStore;
let t: FakeTransport;
let app: App;
const llm = () => {
  const l = new ScriptedLlm();
  l.on('issue_type', (req) => {
    const text = String(req.user).toLowerCase();
    if (/football|kabaddi|cricket/.test(text)) return { issue: 'match' };
    if (/thanks|thank you|^ok\b/.test(text)) return { issue: 'chitchat' };
    return { issue: 'other' };
  });
  return l;
};
const build = (opts: { folders?: typeof FOLDERS; llm?: ScriptedLlm } = { folders: FOLDERS, llm: llm() }) => {
  store = new MemoryStore();
  t = new FakeTransport();
  app = assemble({ store, transport: t, log: silentLogger, clock: () => NOW, llm: opts.llm, readState: t }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, chatFolders: opts.folders, humanReplyFolders: ['Support', 'Match issues'] });
};
const say = (userId: string, text: string) => app.onMessage(t.inbound(userId, text, [], NOW));
const where = (chatId: string) => [...t.folders.entries()].filter(([, chats]) => chats.has(chatId)).map(([title]) => title);

describe('what goes where', () => {
  it('match → Match issues; deposit, withdrawal, other, unclear → Support; chitchat → nowhere', () => {
    expect(folderFor('match')).toBe('match');
    for (const c of ['deposit', 'withdrawal', 'other', 'unclear'] as const) expect(folderFor(c)).toBe('support');
    expect(folderFor('chitchat')).toBe('none');
  });
});

describe('filing customer chats', () => {
  it('"Mai football add karne ka baat kr rha hu": no evidence request, the chat goes to Match issues', async () => {
    build();
    expect(await say('f1', 'Mai football add karne ka baat kr rha hu')).toBe('not_an_issue');
    expect(customerSends(t)).toHaveLength(0);
    expect(where('f1')).toEqual(['Match issues']);
    expect(await say('f2', 'football add karo')).toBe('not_an_issue');
    expect(await say('f3', 'Sir app mein Kabaddi to add karo')).toBe('not_an_issue');
    expect([where('f2'), where('f3')]).toEqual([['Match issues'], ['Match issues']]);
    expect(app.filing.filed).toBe(3);
  });

  it('a settlement or points problem goes to Match issues without the model', async () => {
    build({ folders: FOLDERS });
    expect(await say('m1', 'match khatam ho gaya winning nahi mili')).toBe('not_an_issue');
    expect(await say('m2', 'points kam mile')).toBe('not_an_issue');
    expect([where('m1'), where('m2')]).toEqual([['Match issues'], ['Match issues']]);
    expect(customerSends(t)).toHaveLength(0);
  });

  it('a deposit case: the one request goes out AND the chat is filed under Support; a withdrawal too', async () => {
    build();
    expect(await say('d1', 'deposit nahi hua')).toBe('requested');
    expect(where('d1')).toEqual(['Support']);
    expect(await say('w1', 'withdrawal nahi aaya')).toBe('requested');
    expect(where('w1')).toEqual(['Support']);
    expect(customerSends(t).map((s) => s.chatId)).toEqual(['d1', 'w1']);
    // Inside the case nothing is classified, so nothing is re-filed (one folder edit per case).
    expect(await say('d1', 'hello?')).toBe('already_requested');
    expect(t.filedCalls.filter((c) => c.chatId === 'd1')).toHaveLength(1);
  });

  it('another support matter (login, KYC) is filed under Support; small talk and greetings are not filed', async () => {
    build();
    expect(await say('o1', 'login nahi ho raha')).toBe('not_an_issue');
    expect(where('o1')).toEqual(['Support']);
    expect(await say('o2', 'thanks sir')).toBe('not_an_issue');
    expect(where('o2')).toEqual([]);
    expect(await say('o4', 'ok')).toBe('not_an_issue'); // one word, never sent to the model: nothing to file
    expect(where('o4')).toEqual([]);
    expect(await say('o3', 'Hi')).toBe('greeted'); // answered by the greeting rule, never classified
    expect(where('o3')).toEqual([]);
  });

  it('a human reply takes the filed chat out again', async () => {
    build();
    await say('h1', 'football add karo');
    expect(where('h1')).toEqual(['Match issues']);
    await app.onOwnOutgoing({ chatId: 'h1', messageId: t.nextId('h1'), text: 'Sir, next season me aayega' });
    expect(where('h1')).toEqual([]);
  });

  it('off while the bot is OFF (nothing is classified), off when no folders are configured, and a failed edit is only logged', async () => {
    build();
    await say(ADMIN, '/botoff');
    expect(await say('x1', 'football add karo')).toBe('bot_off');
    expect(t.filedCalls).toHaveLength(0);
    build({ folders: undefined, llm: llm() });
    expect(await say('x2', 'football add karo')).toBe('not_an_issue');
    expect(t.filedCalls).toHaveLength(0);
    expect(app.filing.enabled).toBe(false);
    build();
    t.failFolderEdits = 1;
    expect(await say('x3', 'deposit nahi hua')).toBe('requested'); // the request still goes out
    expect(where('x3')).toEqual([]);
    expect(await app.filing.file('x3', 'deposit')).toBe('support'); // the next attempt works
  });

  it('/status reports it', async () => {
    build();
    await say('s1', 'football add karo');
    await app.onMessage(t.inbound(ADMIN, '/status', [], NOW));
    expect(t.sent.at(-1)?.text).toMatch(/Folders: 1 chat filed into Support \/ Match issues since start/);
  });
});

describe('UserTransport.addChatToFolder', () => {
  const user = (id: string) => new Api.InputPeerUser({ userId: bigInt(id), accessHash: bigInt(42) });
  const text = (s: string) => new Api.TextWithEntities({ text: s, entities: [] });
  const folder = (over: Record<string, unknown> = {}): Api.DialogFilter =>
    new Api.DialogFilter({ id: 3, title: text('Support'), pinnedPeers: [], includePeers: [user('111')], excludePeers: [], ...over } as never);
  const transportWith = (filters: Api.TypeDialogFilter[]) => {
    const t = new UserTransport({ apiId: 1, apiHash: 'x', sessions: new MemorySessionStore(), log: silentLogger });
    const invoke = vi.fn(async (req: unknown) => (req instanceof Api.messages.GetDialogFilters ? new Api.messages.DialogFilters({ filters, tagsEnabled: false } as never) : true));
    (t as unknown as { client: unknown }).client = { invoke, getInputEntity: async (id: { toString(): string }) => user(id.toString()) };
    return { t, invoke };
  };
  const updates = (invoke: ReturnType<typeof vi.fn>) => invoke.mock.calls.map((c) => c[0]).filter((r): r is Api.messages.UpdateDialogFilter => r instanceof Api.messages.UpdateDialogFilter);

  it('adds the chat to the existing folder, keeping its other chats and settings; a chat already there costs no edit', async () => {
    const { t, invoke } = transportWith([new Api.DialogFilterDefault(), folder({ emoticon: '🛠', excludePeers: [user('222')] })]);
    await t.addChatToFolder('Support', '222');
    const [u] = updates(invoke);
    const f = u!.filter as Api.DialogFilter;
    expect([u!.id, f.emoticon, f.includePeers.map(peerChatId), f.excludePeers.map(peerChatId)]).toEqual([3, '🛠', ['111', '222'], []]);
    await t.addChatToFolder('Support', '111');
    expect(updates(invoke)).toHaveLength(1);
  });

  it('creates the folder with the lowest free id when the account has none with that title', async () => {
    const { t, invoke } = transportWith([folder({ id: 2 }), folder({ id: 3, title: text('Friends') })]);
    await t.addChatToFolder('Match issues', '555');
    const [u] = updates(invoke);
    const f = u!.filter as Api.DialogFilter;
    expect([u!.id, folderTitle(f), f.includePeers.map(peerChatId)]).toEqual([4, 'Match issues', ['555']]);
  });
});
