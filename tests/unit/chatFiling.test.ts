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
const FOLDERS = { support: 'Support', match: 'Match issues', deposit: 'Support', withdrawal: 'Support' };
let store: MemoryStore;
let t: FakeTransport;
let app: App;
let now: Date;
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
const build = (opts: { folders?: typeof FOLDERS; llm?: ScriptedLlm | null; staleSeconds?: number } = {}) => {
  store = new MemoryStore();
  t = new FakeTransport();
  now = NOW;
  app = assemble(
    { store, transport: t, log: silentLogger, clock: () => now, llm: opts.llm === null ? undefined : (opts.llm ?? llm()), readState: t },
    { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, chatFolders: opts.folders === undefined && !('folders' in opts) ? FOLDERS : opts.folders, staleSeconds: opts.staleSeconds ?? 0, reopenHours: 48, takeoverHours: 24 },
  );
};
const say = (userId: string, text: string) => app.onMessage(t.inbound(userId, text, [], now));
const humanReplies = (chatId: string, text = 'Sir, dekh raha hoon') => app.onOwnOutgoing({ chatId, messageId: t.nextId(chatId), text });
const where = (chatId: string) => [...t.folders.entries()].filter(([, chats]) => chats.has(chatId)).map(([title]) => title);
const advance = (minutes: number) => (now = new Date(now.getTime() + minutes * 60_000));

describe('1. what a chat is about decides its folder', () => {
  it('match → Match issues; deposit and withdrawal → their folders (Support by default); other and unclear → Support; chitchat → nowhere', () => {
    expect(folderFor('match')).toBe('match');
    expect(folderFor('deposit')).toBe('deposit');
    expect(folderFor('withdrawal')).toBe('withdrawal');
    for (const c of ['other', 'unclear'] as const) expect(folderFor(c)).toBe('support');
    expect(folderFor('chitchat')).toBe('none');
  });

  it('deposit and withdrawal can have folders of their own', async () => {
    build({ folders: { support: 'Support', match: 'Match issues', deposit: 'Deposits', withdrawal: 'Withdrawals' } });
    expect(await say('d1', 'deposit nahi hua')).toBe('requested');
    expect(await say('w1', 'withdrawal nahi aaya')).toBe('requested');
    expect(await say('o1', 'login nahi ho raha')).toBe('not_an_issue');
    expect([where('d1'), where('w1'), where('o1')]).toEqual([['Deposits'], ['Withdrawals'], ['Support']]);
    expect(app.filing.folders.sort()).toEqual(['Deposits', 'Match issues', 'Support', 'Withdrawals']);
    // and a human reply clears whichever folder the chat is in
    await humanReplies('d1');
    expect(where('d1')).toEqual([]);
  });
});

describe('2. new and active issues are in the right folder', () => {
  it('a new deposit case: the request goes out and the chat is under Support; a withdrawal, a match problem, a sports request, a login problem likewise', async () => {
    build();
    expect(await say('d1', 'deposit nahi hua')).toBe('requested');
    expect(await say('w1', 'withdrawal nahi aaya')).toBe('requested');
    expect(await say('m1', 'points kam mile')).toBe('not_an_issue');
    expect(await say('f1', 'Mai football add karne ka baat kr rha hu')).toBe('not_an_issue');
    expect(await say('o1', 'login nahi ho raha')).toBe('not_an_issue');
    expect([where('d1'), where('w1'), where('m1'), where('f1'), where('o1')]).toEqual([['Support'], ['Support'], ['Match issues'], ['Match issues'], ['Support']]);
    expect(customerSends(t).map((s) => s.chatId)).toEqual(['d1', 'w1']);
  });

  it('every message inside an open case keeps the chat filed, with one folder edit, not one per message', async () => {
    build();
    await say('d1', 'deposit nahi hua');
    await say('d1', '9810822372');
    await say('d1', 'ye lo screenshot');
    await app.onMessage({ ...t.inbound('d1', undefined, [], now), media: [{ kind: 'photo', fileRef: 'd1:p', mimeType: 'image/jpeg' }] });
    expect(where('d1')).toEqual(['Support']);
    expect(t.filedCalls.filter((c) => c.chatId === 'd1')).toHaveLength(1);
    expect(customerSends(t)).toHaveLength(1);
  });

  it('greetings, thanks and one-word replies are not filed', async () => {
    build();
    expect(await say('g1', 'Hi')).toBe('greeted');
    expect(await say('g2', 'thanks sir')).toBe('not_an_issue');
    expect(await say('g3', 'ok')).toBe('not_an_issue');
    expect(t.filedCalls).toHaveLength(0);
  });
});

describe('3. a human reply takes the chat out and hands the case over', () => {
  it('after the human replies the chat is in no folder and the case is theirs', async () => {
    build();
    await say('d1', 'deposit nahi hua');
    expect(where('d1')).toEqual(['Support']);
    await humanReplies('d1');
    expect(where('d1')).toEqual([]);
    expect(await store.requests.listOpen('d1')).toHaveLength(0);
    // while the human is in the conversation (24 h) the customer's replies file nothing
    expect(await say('d1', 'ok sir ye lo 9810822372')).toBe('human');
    expect(await say('d1', 'deposit abhi tak nahi hua')).toBe('human');
    expect(where('d1')).toEqual([]);
    expect(customerSends(t)).toHaveLength(1);
  });
});

describe('4. the same customer later raises an issue again: filed again', () => {
  it('after the human takeover has passed, a new issue is a new case: request again, folder again', async () => {
    build();
    await say('d1', 'deposit nahi hua');
    await humanReplies('d1');
    advance(25 * 60);
    expect(await say('d1', 'sir deposit phir se nahi hua 300 ka')).toBe('requested');
    expect(where('d1')).toEqual(['Support']);
    expect(customerSends(t).map((s) => s.chatId)).toEqual(['d1', 'd1']);
    // and a different kind of issue goes to its own folder
    await humanReplies('d1');
    advance(25 * 60);
    expect(await say('d1', 'match cancel ho gaya points nahi mile')).toBe('not_an_issue');
    expect(where('d1')).toEqual(['Match issues']);
  });

  it('a case the human never touched stays filed for its 48 hours and leaves the folder only through a human reply', async () => {
    build();
    await say('d2', 'deposit nahi hua');
    advance(47 * 60);
    expect(await say('d2', 'koi hai?')).toBe('already_requested');
    expect(where('d2')).toEqual(['Support']);
  });
});

describe('5. existing conversations are not mixed with new incoming cases', () => {
  it('a chat where a human wrote recently (before the agent saw it) is the human\'s: not filed, not answered', async () => {
    build();
    t.humanWroteEarlier('e1', new Date(now.getTime() - 60 * 60_000));
    expect(await say('e1', 'deposit nahi hua')).toBe('existing_conversation');
    expect(where('e1')).toEqual([]);
    expect(await say('e1', 'bhai kuch to bolo')).toBe('human');
    expect(where('e1')).toEqual([]);
    // the same chat, once the human has been quiet for a day, is a new incoming case
    advance(25 * 60);
    expect(await say('e1', 'deposit nahi hua')).toBe('requested');
    expect(where('e1')).toEqual(['Support']);
  });

  it('a human reply from weeks ago does not make the chat an existing conversation', async () => {
    build();
    t.humanWroteEarlier('e2', new Date(now.getTime() - 20 * 24 * 60 * 60_000));
    expect(await say('e2', 'withdrawal nahi aaya')).toBe('requested');
    expect(where('e2')).toEqual(['Support']);
  });

  it('old messages replayed after a restart (stale) and messages while the bot is OFF file nothing', async () => {
    build({ staleSeconds: 300 });
    expect(await app.onMessage(t.inbound('s1', 'deposit nahi hua', [], new Date(now.getTime() - 10 * 60_000)))).toBe('stale');
    await app.onMessage(t.inbound(ADMIN, '/botoff', [], now));
    expect(await say('s2', 'deposit nahi hua')).toBe('bot_off');
    expect(t.filedCalls).toHaveLength(0);
  });

  it('a chat the history check could not verify is left alone this time', async () => {
    build();
    t.failHistoryChecks = 1;
    expect(await say('u1', 'deposit nahi hua')).toBe('conversation_unverified');
    expect(t.filedCalls).toHaveLength(0);
  });
});

describe('6. the folder edits themselves', () => {
  it('off when no folders are configured; a failed edit is only logged and the next message files the chat', async () => {
    build({ folders: undefined });
    expect(await say('x2', 'football add karo')).toBe('not_an_issue');
    expect(t.filedCalls).toHaveLength(0);
    expect(app.filing.enabled).toBe(false);
    build();
    t.failFolderEdits = 1;
    expect(await say('x3', 'deposit nahi hua')).toBe('requested'); // the request still goes out
    expect(where('x3')).toEqual([]);
    expect(await say('x3', 'ye lo 9810822372')).toBe('already_requested'); // inside the case: filed now
    expect(where('x3')).toEqual(['Support']);
  });

  it('/status reports it', async () => {
    build();
    await say('s1', 'football add karo');
    await humanReplies('s1');
    await app.onMessage(t.inbound(ADMIN, '/status', [], now));
    expect(t.sent.at(-1)?.text).toMatch(/Folders: 1 chat filed into Support \/ Match issues since start/);
    expect(t.sent.at(-1)?.text).toMatch(/Folders: 1 chat taken out of Support \/ Match issues after a human reply/);
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
