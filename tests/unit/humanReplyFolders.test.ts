import bigInt from 'big-integer';
import { Api } from 'telegram';
import { describe, expect, it, vi } from 'vitest';
import { assemble } from '../../src/app.js';
import { silentLogger } from '../../src/observability/logger.js';
import { MemoryStore } from '../../src/storage/memory.js';
import { findFolder, folderHas, folderList, folderTitle, folderWithoutChat, peerChatId } from '../../src/telegram/user/folders.js';
import { MemorySessionStore } from '../../src/telegram/user/sessionStore.js';
import { UserTransport } from '../../src/telegram/user/userTransport.js';
import { HumanReplyFolders } from '../../src/workflows/humanReplyFolders.js';
import { ADMIN, EXPORT_BOT, FakeTransport, NOW, SUPPORT } from '../helpers/fakeTransport.js';

/**
 * Once a human has replied in a customer chat from the account, that chat leaves the team's
 * "Support" and "Match issues" folders automatically. The customer is never told; nothing else
 * changes; a failed folder edit is logged and swallowed.
 */
const TITLES = ['Support', 'Match issues'];

function build(titles = TITLES) {
  const store = new MemoryStore();
  const t = new FakeTransport();
  const app = assemble({ store, transport: t, log: silentLogger, clock: () => NOW }, { adminIds: [ADMIN], supportChatId: SUPPORT, exportChatId: EXPORT_BOT, humanReplyFolders: titles, version: 'v1' });
  return { store, t, app };
}
const humanReplies = (t: FakeTransport, app: ReturnType<typeof build>['app'], chatId: string, text = 'Sir, checking') => app.onOwnOutgoing({ chatId, messageId: t.nextId(chatId), text });

describe('a human reply takes the chat out of the folders', () => {
  it('a chat in Support leaves it; one in Match issues leaves that; one in both leaves both', async () => {
    const { t, app } = build();
    t.fileChat('Support', '111');
    t.fileChat('Match issues', '222');
    t.fileChat('Support', '333');
    t.fileChat('Match issues', '333');
    t.fileChat('Support', '444'); // untouched
    await humanReplies(t, app, '111');
    await humanReplies(t, app, '222');
    await humanReplies(t, app, '333');
    expect([...(t.folders.get('Support') ?? [])]).toEqual(['444']);
    expect(t.folders.has('Match issues')).toBe(false); // emptied: deleted, as Telegram requires
    expect(app.folders.removed).toBe(3);
    expect(t.sent).toHaveLength(0); // nothing is said to anyone
  });

  it('a chat in no folder: nothing to do; the human takeover still applies', async () => {
    const { store, t, app } = build();
    t.fileChat('Support', '999');
    expect(await app.folders.onHumanReply('111')).toBe('unchanged');
    await humanReplies(t, app, '111');
    expect((await store.users.get('111'))?.humanTakeoverUntil).toBeDefined();
    expect([...(t.folders.get('Support') ?? [])]).toEqual(['999']);
  });

  it("the agent's own messages are not human replies: the transport never reports them (only a human's reach onOwnOutgoing)", async () => {
    const { t, app } = build();
    t.fileChat('Support', 'c1');
    expect(await app.onMessage(t.inbound('c1', 'deposit nahi hua', [], NOW))).toBe('requested');
    expect(t.folderCalls).toHaveLength(0);
    expect(t.folders.get('Support')?.has('c1')).toBe(true);
  });

  it('works while the bot is OFF: it is account housekeeping, not a message', async () => {
    const { t, app } = build();
    t.fileChat('Support', 'c2');
    await app.onMessage(t.inbound(ADMIN, '/botoff', [], NOW));
    await humanReplies(t, app, 'c2');
    expect(t.folders.has('Support')).toBe(false);
  });

  it('a failed edit is logged and swallowed; the next reply tries again; edits run one at a time', async () => {
    const { t, app } = build();
    t.fileChat('Support', 'c3');
    t.failFolderEdits = 1;
    expect(await app.folders.onHumanReply('c3')).toBe('failed');
    expect(t.folders.get('Support')?.has('c3')).toBe(true);
    const results = await Promise.all([app.folders.onHumanReply('c3'), app.folders.onHumanReply('c3')]);
    expect(results).toEqual(['removed', 'unchanged']);
  });

  it('off when no folder titles are configured or the transport cannot edit folders', async () => {
    const { t, app } = build([]);
    t.fileChat('Support', 'c4');
    expect(await app.folders.onHumanReply('c4')).toBe('disabled');
    expect(t.folderCalls).toHaveLength(0);
    const noApi = new HumanReplyFolders({ transport: {}, titles: TITLES, log: silentLogger });
    expect(noApi.enabled).toBe(false);
    expect(await noApi.onHumanReply('c4')).toBe('disabled');
  });

  it('/status reports it', async () => {
    const { t, app } = build();
    t.fileChat('Match issues', 'c5');
    await humanReplies(t, app, 'c5');
    await app.onMessage(t.inbound(ADMIN, '/status', [], NOW));
    expect(t.sent.at(-1)?.text).toMatch(/Folders: 1 chat taken out of Support \/ Match issues after a human reply/);
  });
});

// ── Telegram folder objects ────────────────────────────────────────────────

const user = (id: string) => new Api.InputPeerUser({ userId: bigInt(id), accessHash: bigInt(42) });
const text = (s: string) => new Api.TextWithEntities({ text: s, entities: [] });
const ids = (peers: Api.TypeInputPeer[]) => peers.map(peerChatId);
const folder = (over: Record<string, unknown> = {}): Api.DialogFilter =>
  new Api.DialogFilter({ id: 3, title: text('Support'), pinnedPeers: [], includePeers: [user('111')], excludePeers: [], ...over } as never);

describe('folder helpers (real GramJS objects, no network)', () => {
  it('finds the folder by title ignoring case and spaces, and never edits a shared chatlist', () => {
    const shared = new Api.DialogFilterChatlist({ id: 2, title: text('Support'), pinnedPeers: [], includePeers: [user('9')] } as never);
    const mine = folder({ id: 4, title: text('  SUPPORT ') });
    const filters = [new Api.DialogFilterDefault(), shared, mine];
    expect(findFolder(filters, 'Support')?.id).toBe(4);
    expect(findFolder(filters, 'Payments')).toBeUndefined();
    expect(folderList(new Api.messages.DialogFilters({ filters, tagsEnabled: false } as never))).toEqual(filters);
    expect(folderTitle(folder({ title: 'Match issues' }))).toBe('Match issues');
    expect(peerChatId(user('7996741359'))).toBe('7996741359');
  });

  it('removing keeps the other chats, the pins and everything a human set up on the folder', () => {
    const f = folder({ emoticon: '⚽', color: 3, excludeRead: true, pinnedPeers: [user('111'), user('999')], includePeers: [user('111'), user('222')], excludePeers: [user('333')] });
    expect(folderHas(f, '111')).toBe(true);
    expect(folderHas(f, '999')).toBe(true); // pinned counts
    const next = folderWithoutChat(f, '111')!;
    expect([next.id, next.emoticon, next.color, next.excludeRead]).toEqual([3, '⚽', 3, true]);
    expect(ids(next.includePeers)).toEqual(['222']);
    expect(ids(next.pinnedPeers)).toEqual(['999']);
    expect(ids(next.excludePeers)).toEqual(['333']);
  });

  it('the last chat out deletes the folder (Telegram keeps no empty folder), unless it also lists chats by type', () => {
    expect(folderWithoutChat(folder(), '111')).toBeUndefined();
    expect(folderWithoutChat(folder({ contacts: true }), '111')?.contacts).toBe(true);
  });
});

describe('UserTransport.removeChatFromFolders', () => {
  const transportWith = (filters: Api.TypeDialogFilter[]) => {
    const t = new UserTransport({ apiId: 1, apiHash: 'x', sessions: new MemorySessionStore(), log: silentLogger });
    const invoke = vi.fn(async (req: unknown) => (req instanceof Api.messages.GetDialogFilters ? new Api.messages.DialogFilters({ filters, tagsEnabled: false } as never) : true));
    (t as unknown as { client: unknown }).client = { invoke };
    return { t, invoke };
  };

  it('reads the folders once, rewrites each listed folder the chat is in, deletes one it empties', async () => {
    const support = folder({ id: 3, title: text('Support'), includePeers: [user('111'), user('222')] });
    const match = folder({ id: 5, title: text('Match issues'), includePeers: [user('111')] });
    const other = folder({ id: 6, title: text('Friends'), includePeers: [user('111')] });
    const { t, invoke } = transportWith([new Api.DialogFilterDefault(), support, match, other]);
    expect(await t.removeChatFromFolders('111', TITLES)).toEqual(['Support', 'Match issues']);
    const updates = invoke.mock.calls.map((c) => c[0]).filter((r): r is Api.messages.UpdateDialogFilter => r instanceof Api.messages.UpdateDialogFilter);
    expect(updates.map((u) => [u.id, u.filter ? ids((u.filter as Api.DialogFilter).includePeers) : 'deleted'])).toEqual([[3, ['222']], [5, 'deleted']]);
    expect(invoke.mock.calls.filter((c) => c[0] instanceof Api.messages.GetDialogFilters)).toHaveLength(1);
    // "Friends" is not one of the listed folders: untouched.
  });

  it('a chat in none of the folders costs no edit', async () => {
    const { t, invoke } = transportWith([folder({ includePeers: [user('222')] })]);
    expect(await t.removeChatFromFolders('111', TITLES)).toEqual([]);
    expect(invoke.mock.calls.filter((c) => c[0] instanceof Api.messages.UpdateDialogFilter)).toHaveLength(0);
  });
});
