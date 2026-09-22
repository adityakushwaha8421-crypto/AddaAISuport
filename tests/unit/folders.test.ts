import bigInt from 'big-integer';
import { Api } from 'telegram';
import { describe, expect, it } from 'vitest';
import { findFolder, folderHas, folderList, folderTitle, folderWithChat, folderWithoutChat, nextFolderId, peerChatId } from '../../src/telegram/user/folders.js';

/** Real GramJS objects, no network: the folder rules are checked against what Telegram receives. */
const user = (id: string) => new Api.InputPeerUser({ userId: bigInt(id), accessHash: bigInt(42) });
const text = (t: string) => new Api.TextWithEntities({ text: t, entities: [] });
const ids = (peers: Api.TypeInputPeer[]) => peers.map(peerChatId);

function folder(over: Record<string, unknown> = {}): Api.DialogFilter {
  return new Api.DialogFilter({ id: 3, title: text('Match issues'), pinnedPeers: [], includePeers: [user('111')], excludePeers: [], ...over } as never);
}

describe('finding the folder', () => {
  it('matches the title ignoring case and spaces, and never edits a shared chatlist', () => {
    const shared = new Api.DialogFilterChatlist({ id: 2, title: text('Match issues'), pinnedPeers: [], includePeers: [user('9')] } as never);
    const mine = folder({ id: 4, title: text('  match ISSUES ') });
    const filters = [new Api.DialogFilterDefault(), shared, mine];
    expect(findFolder(filters, 'Match issues')?.id).toBe(4);
    expect(findFolder(filters, 'Payments')).toBeUndefined();
  });

  it('reads both response shapes and both title shapes', () => {
    const f = folder();
    expect(folderList([f])).toEqual([f]);
    expect(folderList(new Api.messages.DialogFilters({ filters: [f], tagsEnabled: false } as never))).toEqual([f]);
    expect(folderTitle(folder({ title: 'Match issues' }))).toBe('Match issues');
  });

  it('allocates the lowest free id, skipping the reserved 0 and 1', () => {
    expect(nextFolderId([])).toBe(2);
    expect(nextFolderId([folder({ id: 2 }), folder({ id: 3 }), folder({ id: 5 })])).toBe(4);
  });

  it('maps a private chat peer to the user id the rest of the system uses', () => {
    expect(peerChatId(user('7996741359'))).toBe('7996741359');
  });
});

describe('adding a chat', () => {
  it('creates the folder when the account has none', () => {
    const created = folderWithChat(undefined, [folder({ id: 2 })], 'Match issues', user('222'));
    expect(created.id).toBe(3);
    expect(folderTitle(created)).toBe('Match issues');
    expect(ids(created.includePeers)).toEqual(['222']);
  });

  it('keeps everything a human set up on the folder', () => {
    const existing = folder({ emoticon: '⚽', color: 3, excludeRead: true, pinnedPeers: [user('999')], excludePeers: [user('222'), user('333')] });
    const next = folderWithChat(existing, [existing], 'Match issues', user('222'));
    expect(next.id).toBe(3);
    expect([next.emoticon, next.color, next.excludeRead]).toEqual(['⚽', 3, true]);
    expect(ids(next.includePeers)).toEqual(['111', '222']);
    expect(ids(next.pinnedPeers)).toEqual(['999']);
    expect(ids(next.excludePeers)).toEqual(['333']); // can't be excluded and filed at once
  });

  it('is idempotent, including for pinned chats', () => {
    const existing = folder({ pinnedPeers: [user('999')] });
    expect(folderWithChat(existing, [existing], 'Match issues', user('111'))).toBe(existing);
    expect(folderHas(existing, '999')).toBe(true);
  });
});

describe('removing a chat', () => {
  it('keeps the other chats', () => {
    const next = folderWithoutChat(folder({ includePeers: [user('111'), user('222')] }), '111');
    expect(ids(next!.includePeers)).toEqual(['222']);
  });

  it('removes it from the pinned list too', () => {
    const next = folderWithoutChat(folder({ pinnedPeers: [user('111')], includePeers: [user('222')] }), '111');
    expect(ids(next!.pinnedPeers)).toEqual([]);
    expect(ids(next!.includePeers)).toEqual(['222']);
  });

  it('deletes the folder rather than leaving it empty, which Telegram rejects', () => {
    expect(folderWithoutChat(folder(), '111')).toBeUndefined();
  });

  it('keeps a folder that also includes chats by type', () => {
    const next = folderWithoutChat(folder({ contacts: true }), '111');
    expect(next?.contacts).toBe(true);
    expect(next?.includePeers).toEqual([]);
  });
});
