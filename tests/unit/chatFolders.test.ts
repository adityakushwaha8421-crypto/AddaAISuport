import { describe, expect, it } from 'vitest';
import { ChatFolders, placementFor } from '../../src/monitoring/chatFolders.js';
import type { Intent, TopicRelation } from '../../src/nlu/types.js';
import { silentLogger } from '../../src/observability/logger.js';
import { Metrics } from '../../src/observability/metrics.js';
import type { ChatFolderApi } from '../../src/telegram/transport.js';
import { FakeFolders, MATCH_FOLDER, SUPPORT_FOLDER } from '../helpers/harness.js';

const TITLES = { match: MATCH_FOLDER, support: SUPPORT_FOLDER };

function setup(api: ChatFolderApi = new FakeFolders()) {
  let now = 0;
  const metrics = new Metrics();
  const f = new ChatFolders({ folders: api, titles: TITLES, log: silentLogger, metrics, clock: () => new Date(now), cacheTtlMs: 60_000 });
  return { f, api: api as FakeFolders, metrics, advance: (ms: number) => (now += ms) };
}

const where = (api: FakeFolders, chat: string) => {
  const m = api.has(MATCH_FOLDER, chat);
  const s = api.has(SUPPORT_FOLDER, chat);
  return m && s ? 'both' : m ? 'match' : s ? 'support' : 'none';
};

const tick = () => new Promise((r) => setTimeout(r, 2));

/** Telegram folder edits are read-modify-write of the whole folder; this fake exposes the race. */
class SlowFolders implements ChatFolderApi {
  readonly folders = new Map<string, string[]>();
  async folderChats(t: string) {
    return [...(this.folders.get(t) ?? [])];
  }
  async addChatToFolder(t: string, chatId: string) {
    const read = [...(this.folders.get(t) ?? [])];
    await tick();
    if (!read.includes(chatId)) read.push(chatId);
    this.folders.set(t, read);
  }
  async removeChatFromFolder(t: string, chatId: string) {
    const read = (this.folders.get(t) ?? []).filter((c) => c !== chatId);
    await tick();
    this.folders.set(t, read);
  }
}

describe('placementFor: only the latest message decides', () => {
  const p = (intent: Intent, over: { relation?: TopicRelation; match?: boolean; focused?: boolean } = {}) =>
    placementFor({ intent, relation: over.relation ?? 'none', matchIssue: over.match ? { category: 'wrong_points' } : undefined }, over.focused ? { id: 'c1' } : undefined);

  it('a match problem goes to Match issues, even next to another issue', () => {
    expect(p('match_issue', { match: true })).toBe('match');
    expect(p('deposit_issue', { relation: 'new_issue', match: true })).toBe('match');
  });

  it.each<Intent>(['deposit_issue', 'withdrawal_issue', 'payment_issue_unclear', 'account_issue', 'technical_issue', 'provide_info', 'general_query', 'human_request'])(
    '%s → Support',
    (intent) => expect(p(intent)).toBe('support'),
  );

  it.each<Intent>(['greeting', 'thanks', 'acknowledgement', 'unclear'])('%s with no case behind it → neither folder', (intent) => {
    expect(p(intent)).toBe('none');
  });

  it('an ok or an unreadable message inside an ongoing support case keeps it in Support', () => {
    expect(p('acknowledgement', { relation: 'continue', focused: true })).toBe('support');
    expect(p('unclear', { relation: 'continue', focused: true })).toBe('support');
    expect(p('greeting', { relation: 'none', focused: true })).toBe('none');
  });
});

describe('ChatFolders', () => {
  it('keeps a chat in exactly one folder and moves it whenever the topic changes', async () => {
    const { f, api, metrics } = setup();
    expect(await f.place('1', 'support')).toEqual({ support: 'added' });
    expect(where(api, '1')).toBe('support');
    expect(await f.place('1', 'match', 'lineup')).toEqual({ match: 'added', support: 'removed' });
    expect(where(api, '1')).toBe('match');
    expect(api.folders.has(SUPPORT_FOLDER)).toBe(false); // Telegram can't keep an empty folder
    expect(await f.place('1', 'support')).toEqual({ support: 'added', match: 'removed' });
    expect(where(api, '1')).toBe('support');
    expect(metrics.chatFolders.get({ folder: 'match', action: 'add', category: 'lineup', outcome: 'added' })).toBe(1);
    expect(metrics.chatFolders.get({ folder: 'match', action: 'remove', reason: 'moved_to_support', outcome: 'removed' })).toBe(1);
  });

  it('small talk takes the chat out of both folders', async () => {
    const { f, api } = setup();
    await f.place('1', 'match', 'wrong_points');
    expect(await f.place('1', 'none')).toEqual({ match: 'removed' });
    expect(where(api, '1')).toBe('none');
  });

  it('staying in the same folder costs no edits', async () => {
    const { f, api } = setup();
    await f.place('1', 'support');
    const edits = api.calls.filter((c) => c.op !== 'list').length;
    for (let i = 0; i < 5; i++) expect(await f.place('1', 'support')).toEqual({});
    expect(api.calls.filter((c) => c.op !== 'list')).toHaveLength(edits);
  });

  it('reads each folder once per cache window, however many messages arrive', async () => {
    const { f, api, advance } = setup();
    for (const chat of ['a', 'b', 'c', 'd']) await f.place(chat, 'none');
    expect(api.calls.filter((c) => c.op === 'list')).toHaveLength(2);
    advance(61_000);
    await f.place('a', 'none');
    expect(api.calls.filter((c) => c.op === 'list')).toHaveLength(4);
  });

  it('a human reply takes a chat out of whichever folder it is in', async () => {
    const { f, api } = setup();
    await f.place('s', 'support');
    await f.place('m', 'match', 'match_result');
    expect(await f.humanReplied('s')).toBe('removed');
    expect(await f.humanReplied('m')).toBe('removed');
    expect(await f.humanReplied('nobody')).toBe('unchanged');
    expect([where(api, 's'), where(api, 'm')]).toEqual(['none', 'none']);
  });

  it('moves a chat a human filed by hand, once the cache window passes', async () => {
    const { f, api, advance } = setup();
    await f.place('x', 'none');
    api.folders.set(SUPPORT_FOLDER, ['5']);
    advance(61_000);
    await f.place('5', 'match', 'wrong_points');
    expect(where(api, '5')).toBe('match');
  });

  it('never leaves a chat in no folder when a move fails, and completes it next time', async () => {
    const { f, api } = setup();
    await f.place('1', 'support');
    await f.place('2', 'match', 'lineup');
    api.failNext = 1;
    expect(await f.place('1', 'match', 'wrong_points')).toEqual({ match: 'failed' });
    expect(where(api, '1')).toBe('support');
    expect(await f.place('1', 'match', 'wrong_points')).toEqual({ match: 'added', support: 'removed' });
    expect(where(api, '1')).toBe('match');
  });

  it('runs edits one at a time, so concurrent turns never overwrite each other', async () => {
    const slow = new SlowFolders();
    const { f } = setup(slow);
    await Promise.all([f.place('1', 'match', 'lineup'), f.place('2', 'support'), f.place('3', 'match', 'wrong_points'), f.place('4', 'support')]);
    expect(slow.folders.get(MATCH_FOLDER)?.sort()).toEqual(['1', '3']);
    expect(slow.folders.get(SUPPORT_FOLDER)?.sort()).toEqual(['2', '4']);
    await Promise.all([f.place('1', 'support'), f.place('4', 'match', 'player_missing'), f.place('2', 'none')]);
    expect(slow.folders.get(MATCH_FOLDER)?.sort()).toEqual(['3', '4']);
    expect(slow.folders.get(SUPPORT_FOLDER)?.sort()).toEqual(['1']);
  });

  it('refresh reports how many chats each folder holds', async () => {
    const { f, api } = setup();
    api.folders.set(MATCH_FOLDER, ['1']);
    api.folders.set(SUPPORT_FOLDER, ['2', '3']);
    expect(await f.refresh()).toEqual({ match: 1, support: 2 });
    api.failNext = 1;
    expect(await f.refresh()).toEqual({ match: undefined, support: 2 });
  });

  it('refuses two folders with the same title', () => {
    expect(() => new ChatFolders({ folders: new FakeFolders(), titles: { match: 'Support', support: ' support ' }, log: silentLogger })).toThrow(/different titles/);
  });
});
