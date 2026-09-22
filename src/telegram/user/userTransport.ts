import bigInt from 'big-integer';
import { Api, Logger as GramLogger, TelegramClient, sessions, utils } from 'telegram';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import type { Logger } from 'pino';
import type { InboundMessage, MediaKind, MediaRef, ReplySnapshot } from '../../domain/messages.js';
import { MediaTooLargeError, TELEGRAM_TEXT_LIMIT, type ChatFolderApi, type ReadStateApi, type SendOptions, type ExportForwardEvent, type Transport, type TransportHandlers } from '../transport.js';
import { findFolder, folderHas, folderList, folderWithChat, folderWithoutChat, peerChatId } from './folders.js';
import { KeyedBuckets, TokenBucket } from '../../util/rateLimiter.js';
import { ReadTracker } from './readState.js';
import type { SessionStore } from './sessionStore.js';

export class SessionMissingError extends Error {}
export class SessionRevokedError extends Error {}

const REVOKED_ERRORS = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/;
const MAX_DOWNLOAD = 50 * 1024 * 1024;
/** Telegram's own service account (login codes, security notices). Never auto-reply to it. */
const TELEGRAM_SERVICE_ID = '777000';

/** Who the AI may answer. A personal account also talks to friends, family and Telegram itself. */
export interface SenderFilter {
  /** When set, only these user ids / lower-cased "@usernames" get replies. */
  allowed?: Set<string>;
  ignoreContacts: boolean;
}

export function parseAllowedUsers(raw: string | undefined): Set<string> | undefined {
  const items = (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? new Set(items.map((s) => (/^\d+$/.test(s) || s.startsWith('@') ? s : `@${s}`))) : undefined;
}

export function screenSender(sender: Api.User | undefined, filter: SenderFilter): { ok: boolean; reason?: string } {
  if (!sender) return { ok: false, reason: 'unknown sender' };
  const id = sender.id.toString();
  if (id === TELEGRAM_SERVICE_ID || sender.support) return { ok: false, reason: 'Telegram service account' };
  if (sender.self) return { ok: false, reason: 'own account' };
  if (sender.bot) return { ok: false, reason: 'bot' };
  if (filter.allowed) {
    const byName = sender.username ? filter.allowed.has(`@${sender.username.toLowerCase()}`) : false;
    if (!filter.allowed.has(id) && !byName) return { ok: false, reason: 'not in TELEGRAM_ALLOWED_USERS' };
    return { ok: true }; // explicitly allowed test users are answered even if they are contacts
  }
  if (filter.ignoreContacts && sender.contact) return { ok: false, reason: 'saved contact (TELEGRAM_IGNORE_CONTACTS=true)' };
  return { ok: true };
}

export interface UserTransportOptions {
  apiId: number;
  apiHash: string;
  sessions: SessionStore;
  supportChatId?: string;
  /** Telegram user id of the export bot the account sends case files to. */
  exportChatId?: string;
  filter?: SenderFilter;
  log: Logger;
  /** How often to verify the session is still authorised. */
  authCheckIntervalMs?: number;
  /** Outbound messages per second, account-wide and per chat (Telegram throttles beyond ~30/s). */
  sendRate?: number;
  chatSendRate?: number;
}

const FLOOD_WAIT = /FLOOD_WAIT_(\d+)/;
/** A FLOOD_WAIT up to this long is waited out in place; longer ones fail and are retried later. */
const MAX_FLOOD_WAIT_S = 30;

type GMessage = Api.Message;

export function mediaFromUserMessage(m: GMessage, chatId: string): MediaRef[] {
  const fileRef = `${chatId}:${m.id}`;
  if (m.photo && m.photo instanceof Api.Photo) {
    return [{ kind: 'photo', fileRef, fileUniqueId: `photo:${m.photo.id.toString()}`, mimeType: 'image/jpeg' }];
  }
  const doc = m.document;
  if (!doc) return [];
  let kind: MediaKind = 'document';
  let fileName: string | undefined;
  let durationSec: number | undefined;
  for (const a of doc.attributes) {
    if (a instanceof Api.DocumentAttributeFilename) fileName = a.fileName;
    else if (a instanceof Api.DocumentAttributeSticker) kind = 'sticker';
    else if (a instanceof Api.DocumentAttributeAnimated) kind = 'animation';
    else if (a instanceof Api.DocumentAttributeVideo) {
      kind = a.roundMessage ? 'video_note' : kind === 'animation' ? 'animation' : 'video';
      durationSec = a.duration;
    } else if (a instanceof Api.DocumentAttributeAudio) {
      kind = a.voice ? 'voice' : 'audio';
      durationSec = a.duration;
    }
  }
  // Images sent "as file" stay documents; the evidence layer inspects the mime type.
  return [{ kind, fileRef, fileUniqueId: `doc:${doc.id.toString()}`, mimeType: doc.mimeType, fileName, fileSize: Number(doc.size), durationSec }];
}

/** A forward the account made into the export bot's chat, in transport-agnostic terms. Pure. */
export function exportForwardOf(m: GMessage): ExportForwardEvent {
  const from = m.fwdFrom?.fromId;
  const [media] = mediaFromUserMessage(m, 'export');
  const kind: ExportForwardEvent['kind'] = !media ? (m.message ? 'text' : 'other')
    : media.kind === 'photo' ? 'photo' : media.kind === 'video' || media.kind === 'video_note' ? 'video' : media.kind === 'document' ? 'document' : 'other';
  return {
    messageId: m.id,
    fromUserId: from instanceof Api.PeerUser ? from.userId.toString() : undefined,
    fromName: m.fwdFrom?.fromName ?? undefined,
    kind, text: m.message || undefined, mimeType: media?.mimeType, fileName: media?.fileName, fileUniqueId: media?.fileUniqueId,
  };
}

/**
 * Map an incoming MTProto message (plus the message it swipe-replies to, when Telegram returned
 * it) to the transport-agnostic model. Pure, so reply/media mapping is unit-testable.
 */
export function buildInbound(m: GMessage, chatId: string, sender: Api.User, replied: GMessage | undefined, selfId: string): InboundMessage {
  const media = mediaFromUserMessage(m, chatId);
  let replyTo: ReplySnapshot | undefined;
  if (replied) {
    const rMedia = mediaFromUserMessage(replied, chatId);
    replyTo = {
      messageId: replied.id,
      text: rMedia.length ? undefined : replied.message || undefined,
      caption: rMedia.length ? replied.message || undefined : undefined,
      media: rMedia,
      fromSelf: Boolean(replied.out) || replied.senderId?.toString() === selfId,
    };
  } else if (m.replyToMsgId) {
    // Replied-to message not retrievable (deleted/too old): keep the pointer; the DB may know it.
    replyTo = { messageId: m.replyToMsgId, media: [], fromSelf: false };
  }
  return {
    chatId,
    userId: sender.id.toString(),
    messageId: m.id,
    date: new Date(m.date * 1000),
    text: media.length ? undefined : m.message || undefined,
    caption: media.length ? m.message || undefined : undefined,
    media,
    mediaGroupId: m.groupedId?.toString(),
    replyTo,
    sender: { username: sender.username, firstName: sender.firstName, lastName: sender.lastName, languageCode: sender.langCode },
  };
}

/**
 * Telegram account (MTProto) transport. Isolated behind `Transport` so the account/session
 * mechanism can be replaced without touching the rest of the system.
 */
export class UserTransport implements Transport, ChatFolderApi, ReadStateApi {
  private client?: TelegramClient;
  private selfId = '';
  /** Support chat as Telegram reports it on incoming messages ("marked" id, e.g. -5207771735). */
  private supportMarkedId?: string;
  private supportPeer?: Api.TypeInputPeer;
  private exportPeer?: Api.TypeInputPeer;
  /** Forwards this process made into the export bot's chat (the exporter's), so a human's can be told apart. */
  private readonly forwardedByUs = new Set<number>();
  private readonly forwardsInFlight = new Set<Promise<unknown>>();
  private running = false;
  private authTimer?: NodeJS.Timeout;
  /** Message ids we sent programmatically, per chat — to tell bot messages from a human's. */
  private readonly sentByUs = new Map<string, Set<number>>();
  /** Sends still awaiting Telegram's answer, per chat: their ids are not in `sentByUs` yet. */
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>();
  /** Which customer messages a human already read on this account. */
  private readonly reads = new ReadTracker();
  private readonly sendBucket: TokenBucket;
  private readonly chatBuckets: KeyedBuckets;

  constructor(private readonly opts: UserTransportOptions) {
    this.sendBucket = new TokenBucket(opts.sendRate ?? 20, Math.max(5, Math.round((opts.sendRate ?? 20) / 2)));
    this.chatBuckets = new KeyedBuckets(opts.chatSendRate ?? 1, 3);
  }

  /** Take a send slot, then run; a short FLOOD_WAIT is honoured once before giving up. */
  private async throttled<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    await this.chatBuckets.take(chatId);
    await this.sendBucket.take();
    try {
      return await fn();
    } catch (err) {
      const m = FLOOD_WAIT.exec((err as Error).message ?? '');
      const seconds = m ? Number(m[1]) : 0;
      if (!seconds || seconds > MAX_FLOOD_WAIT_S) throw err;
      this.opts.log.warn({ chat: chatId, seconds }, 'telegram FLOOD_WAIT: pausing sends');
      await new Promise((r) => setTimeout(r, (seconds + 1) * 1000));
      return fn();
    }
  }

  async start(handlers: TransportHandlers): Promise<void> {
    const saved = await this.opts.sessions.load();
    if (!saved) throw new SessionMissingError('No Telegram session found. Run `npm run telegram:login` first.');

    const client = new TelegramClient(new sessions.StringSession(saved), this.opts.apiId, this.opts.apiHash, {
      connectionRetries: 10,
      autoReconnect: true,
      baseLogger: new GramLogger(LogLevel.ERROR),
    });
    this.client = client;

    await client.connect();
    if (!(await client.checkAuthorization())) {
      throw new SessionRevokedError('Telegram session is no longer authorised. Run `npm run telegram:login` again.');
    }
    const me = (await client.getMe()) as Api.User;
    this.selfId = me.id.toString();
    // Warm the entity cache so replies/forwards to known chats and the support group resolve by id.
    await client.getDialogs({ limit: 100 }).catch((err) => this.opts.log.warn({ err }, 'could not preload dialogs'));
    await this.resolveSupportChat(client);
    await this.resolveExportBot(client);

    // Persist the session if the library rotated it (e.g. DC migration). Never logged.
    const current = client.session.save() as unknown as string;
    if (current && current !== saved) await this.opts.sessions.save(current);

    client.addEventHandler((ev: NewMessageEvent) => {
      this.onEvent(ev, handlers).catch((err) => this.handleClientError(err, 'event handler failed'));
    }, new NewMessage({}));

    // Someone read a private chat on this account (phone, desktop): remember how far.
    client.addEventHandler((update: Api.TypeUpdate) => {
      if (!(update instanceof Api.UpdateReadHistoryInbox) || !(update.peer instanceof Api.PeerUser)) return;
      const chat = update.peer.userId.toString();
      const by = this.reads.read(chat, update.maxId);
      this.opts.log.debug({ chat, upTo: update.maxId, by }, 'chat read');
    }, new Raw({ types: [Api.UpdateReadHistoryInbox] }));

    this.authTimer = setInterval(() => {
      client.checkAuthorization().then(
        (ok) => {
          if (!ok) this.markRevoked();
        },
        (err) => this.handleClientError(err, 'authorization check failed'),
      );
    }, this.opts.authCheckIntervalMs ?? 5 * 60_000);
    this.authTimer.unref();

    this.running = true;
    this.opts.log.info(
      { account: me.username ? `@${me.username}` : me.firstName, allowList: this.opts.filter?.allowed?.size ?? 0, ignoreContacts: this.opts.filter?.ignoreContacts ?? false },
      'telegram account connected; listening for private messages',
    );
  }

  /** Accept the support chat id in either raw (5207771735) or marked (-5207771735 / -100…) form. */
  private async resolveSupportChat(client: TelegramClient): Promise<void> {
    const configured = this.opts.supportChatId;
    if (!configured) return;
    try {
      const entity = await client.getEntity(bigInt(configured));
      this.supportMarkedId = utils.getPeerId(entity);
      this.supportPeer = await client.getInputEntity(entity);
      const title = entity instanceof Api.User ? entity.firstName : (entity as Api.Chat | Api.Channel).title;
      this.opts.log.info({ supportChat: title, id: this.supportMarkedId }, 'support chat resolved');
    } catch (err) {
      this.supportMarkedId = configured;
      this.opts.log.error({ err, supportChatId: configured }, 'support chat not found: is this account a member? Handoffs will fail');
    }
  }

  /** The export bot must already have a chat with this account (open it and press Start once). */
  private async resolveExportBot(client: TelegramClient): Promise<void> {
    const id = this.opts.exportChatId;
    if (!id) return;
    try {
      const entity = await client.getEntity(bigInt(id));
      this.exportPeer = await client.getInputEntity(entity);
      const name = entity instanceof Api.User ? (entity.username ? `@${entity.username}` : entity.firstName) : id;
      this.opts.log.info({ exportBot: name }, 'export bot resolved');
    } catch (err) {
      this.opts.log.error({ err, exportBotId: id }, 'export bot not found: open the bot on this account and press Start once. Exports will fail until then');
    }
  }

  private markRevoked() {
    this.running = false;
    this.opts.log.fatal('telegram user session revoked or expired; re-run `npm run telegram:login`');
  }

  private handleClientError(err: unknown, msg: string) {
    const text = err instanceof Error ? err.message : String(err);
    if (REVOKED_ERRORS.test(text)) this.markRevoked();
    else this.opts.log.error({ err }, msg);
  }

  private async onEvent(ev: NewMessageEvent, handlers: TransportHandlers) {
    const m = ev.message;
    const chatId = m.chatId?.toString();
    if (!chatId) return;

    if (this.opts.supportChatId && (chatId === this.supportMarkedId || chatId === this.opts.supportChatId)) {
      if (!m.out && handlers.onSupportMessage) {
        await handlers.onSupportMessage({
          chatId: this.opts.supportChatId, // the id the rest of the system knows (tickets store it)
          messageId: m.id,
          fromUserId: m.senderId?.toString() ?? '',
          text: m.message,
          replyToMessageId: m.replyToMsgId,
        });
      }
      return;
    }
    if (this.opts.exportChatId && chatId === this.opts.exportChatId) {
      // What comes back is the bot's confirmation.
      if (!m.out && handlers.onExportMessage) await handlers.onExportMessage({ messageId: m.id, text: m.message, replyToMessageId: m.replyToMsgId });
      // What goes out is either the bot's own export (tracked by the exporter) or a HUMAN forwarding a
      // customer's evidence by hand. The second kind must be reported, or the customer is never told.
      if (m.out && m.fwdFrom && handlers.onExportForward) {
        const flying = [...this.forwardsInFlight];
        if (flying.length) await Promise.race([Promise.allSettled(flying), new Promise((r) => setTimeout(r, 15_000))]);
        else await new Promise((r) => setTimeout(r, 1500));
        if (this.forwardedByUs.has(m.id)) return;
        await handlers.onExportForward(exportForwardOf(m));
      }
      return;
    }
    if (!ev.isPrivate) return;

    if (m.out) {
      // Our own account wrote in this chat. If we didn't send it, a human took over.
      if (!handlers.onOwnOutgoing) return;
      // The update can arrive before our own sendMessage() call has returned the id: wait for
      // every send in flight to this chat (bounded), then decide.
      const pending = [...(this.inFlight.get(chatId) ?? [])];
      if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 15_000))]);
      else await new Promise((r) => setTimeout(r, 1500));
      if (this.sentByUs.get(chatId)?.has(m.id)) return;
      this.opts.log.info({ chat: chatId, messageId: m.id }, 'a human wrote in this chat from the account (not a bot message)');
      await handlers.onOwnOutgoing({ chatId, messageId: m.id, text: m.message });
      return;
    }

    this.reads.incoming(chatId, m.id);
    const inbound = await this.toInbound(m, chatId);
    if (inbound) await handlers.onMessage(inbound);
  }

  private async toInbound(m: GMessage, chatId: string): Promise<InboundMessage | undefined> {
    const sender = (await m.getSender()) as Api.User | undefined;
    const verdict = screenSender(sender, this.opts.filter ?? { ignoreContacts: false });
    if (!verdict.ok) {
      this.opts.log.info({ chat: chatId, reason: verdict.reason }, 'message ignored');
      return undefined;
    }
    if (!sender) return undefined;
    const replied = m.replyToMsgId ? await m.getReplyMessage().catch(() => undefined) : undefined;
    return buildInbound(m, chatId, sender, replied, this.selfId);
  }

  private requireClient(): TelegramClient {
    if (!this.client) throw new Error('UserTransport not started');
    return this.client;
  }

  private peer(chatId: string) {
    if (this.supportPeer && chatId === this.opts.supportChatId) return this.supportPeer;
    if (this.exportPeer && chatId === this.opts.exportChatId) return this.exportPeer;
    return bigInt(chatId);
  }

  private async withEntityRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // After a restart the entity cache is empty; warm it from dialogs once and retry.
      if (/Could not find the input entity|PEER_ID_INVALID/i.test((err as Error).message)) {
        await this.requireClient().getDialogs({ limit: 200 });
        return fn();
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.authTimer) clearInterval(this.authTimer);
    await this.client?.disconnect();
  }

  healthy(): boolean {
    return this.running;
  }

  async sendText(chatId: string, text: string, opts: SendOptions = {}): Promise<{ messageId: number }> {
    const client = this.requireClient();
    // Telegram may mark the chat read when we send: that read is ours, not a human's.
    const send = this.throttled(chatId, () => this.withEntityRetry(() =>
      client.sendMessage(this.peer(chatId), { message: text.slice(0, TELEGRAM_TEXT_LIMIT), replyTo: opts.replyToMessageId, linkPreview: false, parseMode: opts.html ? 'html' : undefined }),
    )).finally(this.reads.sending(chatId));
    // Register the id as part of the tracked promise, so whoever awaits it sees it in `sentByUs`.
    const tracked = send.then((sent) => {
      const set = this.sentByUs.get(chatId) ?? new Set<number>();
      set.add(sent.id);
      if (set.size > 500) set.delete(set.values().next().value as number);
      this.sentByUs.set(chatId, set);
      return sent;
    });
    const flying = this.inFlight.get(chatId) ?? new Set<Promise<unknown>>();
    flying.add(tracked);
    this.inFlight.set(chatId, flying);
    try {
      const sent = await tracked;
      return { messageId: sent.id };
    } finally {
      flying.delete(tracked);
      if (!flying.size) this.inFlight.delete(chatId);
    }
  }

  async forwardMessage(fromChatId: string, messageId: number, toChatId: string) {
    const client = this.requireClient();
    // A real Telegram forward, author kept: the export bot and the team see which customer the
    // file came from. (Never dropAuthor: that would turn it into an anonymous copy.)
    const toExport = !!this.opts.exportChatId && toChatId === this.opts.exportChatId;
    const call = this.throttled(toChatId, () => this.withEntityRetry(() =>
      client.forwardMessages(this.peer(toChatId), { messages: [messageId], fromPeer: this.peer(fromChatId), dropAuthor: false }),
    ));
    if (toExport) {
      this.forwardsInFlight.add(call);
      void call.finally(() => this.forwardsInFlight.delete(call)).catch(() => undefined);
    }
    const res = await call;
    const remember = (id: number) => {
      if (!toExport) return;
      this.forwardedByUs.add(id);
      if (this.forwardedByUs.size > 5000) this.forwardedByUs.delete(this.forwardedByUs.values().next().value as number);
    };
    // GramJS returns one array per chunk (an array of arrays), with holes when it could not map a
    // result back to a message.
    const first = (res ?? []).flat().find((m): m is Api.Message => m instanceof Api.Message);
    if (first?.id) {
      remember(first.id);
      return { messageId: first.id };
    }
    // Telegram did the forward but GramJS lost the id: the newest message in the chat is it if it
    // is ours, a forward, and seconds old. Otherwise report failure (the caller may retry).
    const [latest] = await client.getMessages(this.peer(toChatId), { limit: 1 });
    if (latest instanceof Api.Message && latest.out && latest.fwdFrom && Date.now() / 1000 - latest.date < 30) {
      remember(latest.id);
      return { messageId: latest.id };
    }
    this.opts.log.warn({ from: fromChatId, messageId, to: toChatId }, 'forward result could not be mapped to a message id');
    return undefined;
  }

  async messagesExist(chatId: string, messageIds: number[]): Promise<number[]> {
    if (!messageIds.length) return [];
    const client = this.requireClient();
    const msgs = await this.withEntityRetry(() => client.getMessages(this.peer(chatId), { ids: messageIds }));
    // Telegram returns an empty slot for an id that does not exist in the chat.
    return msgs.filter((m): m is Api.Message => m instanceof Api.Message).map((m) => m.id);
  }

  async downloadMedia(ref: MediaRef): Promise<Buffer> {
    if (ref.fileSize && ref.fileSize > MAX_DOWNLOAD) throw new MediaTooLargeError('File too large');
    const [chatId, msgId] = ref.fileRef.split(':');
    if (!chatId || !msgId) throw new Error('Malformed user-transport file reference');
    const client = this.requireClient();
    const [msg] = await this.withEntityRetry(() => client.getMessages(this.peer(chatId), { ids: [Number(msgId)] }));
    if (!msg) throw new Error('Message with media no longer exists');
    const data = await client.downloadMedia(msg, {});
    if (!data || typeof data === 'string') throw new Error('Media download returned no data');
    return data;
  }

  async sendTyping(chatId: string): Promise<void> {
    const client = this.requireClient();
    await client
      .invoke(new Api.messages.SetTyping({ peer: this.peer(chatId), action: new Api.SendMessageTypingAction() }))
      .catch(() => undefined);
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    const client = this.requireClient();
    await client.deleteMessages(this.peer(chatId), [messageId], { revoke: true });
  }

  async seenByHuman(chatId: string, messageId: number): Promise<boolean> {
    const known = this.reads.seen(chatId, messageId);
    if (known !== undefined) return known;
    // Received before this process was listening (recovered after a restart): ask Telegram.
    const client = this.requireClient();
    const peer = await this.withEntityRetry(() => client.getInputEntity(this.peer(chatId)));
    const res = await client.invoke(new Api.messages.GetPeerDialogs({ peers: [new Api.InputDialogPeer({ peer })] }));
    const dialog = res.dialogs.find((d): d is Api.Dialog => d instanceof Api.Dialog);
    return !!dialog && dialog.readInboxMaxId >= messageId;
  }

  // ── Chat folders ───────────────────────────────────────────────────────────

  private async readFolders(): Promise<Api.TypeDialogFilter[]> {
    return folderList(await this.requireClient().invoke(new Api.messages.GetDialogFilters()));
  }

  async folderChats(title: string): Promise<string[]> {
    const folder = findFolder(await this.readFolders(), title);
    if (!folder) return [];
    return [...folder.pinnedPeers, ...folder.includePeers].map(peerChatId).filter((id): id is string => !!id);
  }

  async addChatToFolder(title: string, chatId: string): Promise<void> {
    const client = this.requireClient();
    const filters = await this.readFolders();
    const folder = findFolder(filters, title);
    if (folder && folderHas(folder, chatId)) return;
    const peer = await this.withEntityRetry(() => client.getInputEntity(this.peer(chatId)));
    const next = folderWithChat(folder, filters, title, peer);
    await client.invoke(new Api.messages.UpdateDialogFilter({ id: next.id, filter: next }));
  }

  async removeChatFromFolder(title: string, chatId: string): Promise<void> {
    const client = this.requireClient();
    const folder = findFolder(await this.readFolders(), title);
    if (!folder || !folderHas(folder, chatId)) return;
    const next = folderWithoutChat(folder, chatId);
    // No filter = delete: Telegram does not allow a folder with no chats in it.
    await client.invoke(new Api.messages.UpdateDialogFilter(next ? { id: folder.id, filter: next } : { id: folder.id }));
  }
}
