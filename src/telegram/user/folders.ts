import { Api, utils } from 'telegram';

/**
 * Pure helpers over Telegram's chat-folder objects (dialog filters), kept free of the client so the
 * rules are testable offline:
 *  - only ordinary folders are edited; shared "chatlist" folders are left alone
 *  - editing a folder keeps everything a human set up on it (icon, colour, pins, type flags…)
 *  - a folder must never be left empty (Telegram rejects it), so it is deleted instead
 */

const TYPE_FLAGS = ['contacts', 'nonContacts', 'groups', 'broadcasts', 'bots'] as const;

export function folderList(res: Api.messages.TypeDialogFilters | Api.TypeDialogFilter[]): Api.TypeDialogFilter[] {
  return Array.isArray(res) ? res : res.filters;
}

export function folderTitle(f: Api.DialogFilter | Api.DialogFilterChatlist): string {
  const t = f.title as Api.TypeTextWithEntities | string;
  return (typeof t === 'string' ? t : t.text).trim();
}

const sameTitle = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** The editable folder with this title, if the account has one. */
export function findFolder(filters: Api.TypeDialogFilter[], title: string): Api.DialogFilter | undefined {
  return filters.find((f): f is Api.DialogFilter => f instanceof Api.DialogFilter && sameTitle(folderTitle(f), title));
}

/** Lowest free folder id. 0 and 1 are reserved by Telegram. */
export function nextFolderId(filters: Api.TypeDialogFilter[]): number {
  const used = new Set(filters.flatMap((f) => (f instanceof Api.DialogFilter || f instanceof Api.DialogFilterChatlist ? [f.id] : [])));
  let id = 2;
  while (used.has(id)) id++;
  return id;
}

/** Chat id as the rest of the system knows it (a private chat's id is the user's id). */
export function peerChatId(p: Api.TypeInputPeer): string | undefined {
  try {
    return utils.getPeerId(p);
  } catch {
    return undefined;
  }
}

const matches = (chatId: string) => (p: Api.TypeInputPeer) => peerChatId(p) === chatId;

/** Pinned chats are shown in a folder without being listed in `includePeers`. */
export const folderHas = (f: Api.DialogFilter, chatId: string): boolean =>
  f.includePeers.some(matches(chatId)) || f.pinnedPeers.some(matches(chatId));

function rebuild(f: Api.DialogFilter, peers: Pick<Api.DialogFilter, 'includePeers' | 'pinnedPeers' | 'excludePeers'>): Api.DialogFilter {
  return new Api.DialogFilter({
    contacts: f.contacts, nonContacts: f.nonContacts, groups: f.groups, broadcasts: f.broadcasts, bots: f.bots,
    excludeMuted: f.excludeMuted, excludeRead: f.excludeRead, excludeArchived: f.excludeArchived, titleNoanimate: f.titleNoanimate,
    id: f.id, title: f.title, emoticon: f.emoticon, color: f.color,
    ...peers,
  });
}

/** The folder with the chat added; a brand-new folder when the account has none with this title. */
export function folderWithChat(existing: Api.DialogFilter | undefined, filters: Api.TypeDialogFilter[], title: string, peer: Api.TypeInputPeer): Api.DialogFilter {
  if (!existing) {
    return new Api.DialogFilter({
      id: nextFolderId(filters),
      title: new Api.TextWithEntities({ text: title, entities: [] }),
      pinnedPeers: [],
      includePeers: [peer],
      excludePeers: [],
    });
  }
  const chatId = peerChatId(peer);
  if (chatId && folderHas(existing, chatId)) return existing;
  return rebuild(existing, {
    includePeers: [...existing.includePeers, peer],
    pinnedPeers: existing.pinnedPeers,
    // A chat can't be excluded and included at once; being filed wins.
    excludePeers: chatId ? existing.excludePeers.filter((p) => !matches(chatId)(p)) : existing.excludePeers,
  });
}

/** The folder without the chat, or `undefined` when nothing would be left (delete the folder). */
export function folderWithoutChat(f: Api.DialogFilter, chatId: string): Api.DialogFilter | undefined {
  const keep = (p: Api.TypeInputPeer) => !matches(chatId)(p);
  const includePeers = f.includePeers.filter(keep);
  const pinnedPeers = f.pinnedPeers.filter(keep);
  const byType = TYPE_FLAGS.some((k) => f[k]);
  if (!includePeers.length && !pinnedPeers.length && !byType) return undefined;
  return rebuild(f, { includePeers, pinnedPeers, excludePeers: f.excludePeers });
}
