import type { Logger } from 'pino';
import { PENDING_STATUSES } from '../domain/cases.js';
import type { InboundMessage } from '../domain/messages.js';
import type { Metrics } from '../observability/metrics.js';
import type { OutboxSender } from '../pipeline/outbox.js';
import type { Store } from '../storage/types.js';
import type { ExportForwardEvent, Transport } from '../telegram/transport.js';
import type { KeyedMutex } from '../util/mutex.js';

/**
 * Evidence a HUMAN forwarded to the export bot.
 *
 * The bot's own export (exporter.ts) confirms to the customer once Telegram shows its forwards in
 * the export bot's chat. In production that path often never runs: staff work from the same account,
 * so the customer's messages are read (turn skipped: seen_by_human) or answered by a person (case
 * closed, bot paused) — and then the staff forward the four items to the export bot by hand. Those
 * forwards used to be invisible here, so the customer never heard that the documents were shared.
 *
 * This service watches the account's own forwards in the export bot's chat, works out which customer
 * each one came from, and once all four required items of one customer are there — and Telegram
 * confirms every one of them exists in that chat — sends the agreed confirmation, once.
 * The upload alone never earns it; neither does a partial set.
 */

export const REQUIRED_ITEMS = ['registration_number', 'payment_screenshot', 'payment_video', 'bank_statement'] as const;
export type ExportItem = (typeof REQUIRED_ITEMS)[number];

export const SHARED_TEXT = 'Your details and documents have been shared with our team successfully. They will review your issue and work on resolving it as soon as possible. ✅';

const MOBILE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/;
const isPdf = (ev: ExportForwardEvent) => ev.kind === 'document' && (/pdf/i.test(ev.mimeType ?? '') || /\.(pdf|uu)$/i.test(ev.fileName ?? ''));

/** Which required item a forwarded message is, if any. */
export function itemOf(ev: ExportForwardEvent): ExportItem | undefined {
  if (ev.kind === 'photo') return 'payment_screenshot';
  if (ev.kind === 'video') return 'payment_video';
  if (isPdf(ev)) return 'bank_statement';
  if (ev.kind === 'document' && /^image\//i.test(ev.mimeType ?? '')) return 'payment_screenshot'; // a screenshot sent "as file"
  if (ev.kind === 'document' && /^video\//i.test(ev.mimeType ?? '')) return 'payment_video';
  if (ev.kind === 'text' && MOBILE.test(ev.text ?? '')) return 'registration_number';
  return undefined;
}

interface Batch {
  /** item → id of the forward in the export bot's chat */
  items: Map<ExportItem, number>;
  startedAt: number;
}

export type ForwardOutcome = 'ignored' | 'unknown_customer' | 'collecting' | 'not_delivered' | 'confirmed' | 'duplicate';

export class ManualExports {
  private readonly batches = new Map<string, Batch>();
  /** Recent customer content → chat, to place a forward whose sender Telegram hides (privacy setting). */
  private readonly origin = new Map<string, string>();

  constructor(
    private readonly o: {
      store: Store; outbox: OutboxSender; transport: Pick<Transport, 'messagesExist'>; exportChatId: string; locks: KeyedMutex; log: Logger;
      metrics?: Metrics; clock?: () => Date; windowMinutes?: number; originLimit?: number;
    },
  ) {}

  private now() {
    return this.o.clock?.() ?? new Date();
  }

  /** Every customer message passes here, so a hidden-sender forward can be traced back by its file or text. */
  noteInbound(msg: InboundMessage): void {
    const keys = [...(msg.media ?? []).map((m) => m.fileUniqueId).filter((k): k is string => !!k).map((k) => `file:${k}`)];
    const text = (msg.text ?? '').trim();
    if (text && text.length <= 200 && MOBILE.test(text)) keys.push(`text:${text}`);
    for (const k of keys) {
      this.origin.delete(k); // re-insert: newest last
      this.origin.set(k, msg.chatId);
    }
    const limit = this.o.originLimit ?? 5000;
    while (this.origin.size > limit) this.origin.delete(this.origin.keys().next().value as string);
  }

  private customerOf(ev: ExportForwardEvent): string | undefined {
    if (ev.fromUserId) return ev.fromUserId;
    if (ev.fileUniqueId && this.origin.has(`file:${ev.fileUniqueId}`)) return this.origin.get(`file:${ev.fileUniqueId}`);
    const text = (ev.text ?? '').trim();
    if (text && this.origin.has(`text:${text}`)) return this.origin.get(`text:${text}`);
    return undefined;
  }

  async onForward(ev: ExportForwardEvent): Promise<ForwardOutcome> {
    const { log } = this.o;
    const item = itemOf(ev);
    if (!item) {
      log.info({ messageId: ev.messageId, kind: ev.kind }, 'manual forward to the export bot ignored (not one of the required items)');
      return 'ignored';
    }
    const chatId = this.customerOf(ev);
    if (!chatId) {
      log.warn({ messageId: ev.messageId, item, fromName: ev.fromName }, 'manual forward to the export bot: the customer hides their account on forwards and the file is not one we saw; no confirmation can be sent for it');
      return 'unknown_customer';
    }
    return this.o.locks.run(chatId, () => this.collect(chatId, item, ev.messageId));
  }

  private async collect(chatId: string, item: ExportItem, messageId: number): Promise<ForwardOutcome> {
    const { store, outbox, transport, exportChatId, log, metrics } = this.o;
    const now = this.now().getTime();
    const windowMs = (this.o.windowMinutes ?? 60) * 60_000;
    let batch = this.batches.get(chatId);
    if (!batch || now - batch.startedAt > windowMs) batch = { items: new Map(), startedAt: now };
    batch.items.set(item, messageId); // a re-sent item replaces the earlier one
    this.batches.set(chatId, batch);

    const missing = REQUIRED_ITEMS.filter((i) => !batch!.items.has(i));
    if (missing.length) {
      log.info({ chat: chatId, item, missing }, 'manual forward to the export bot noted; still waiting for the rest');
      return 'collecting';
    }

    // Trust Telegram, not the update stream: all four must exist in the export bot's chat.
    const ids = REQUIRED_ITEMS.map((i) => batch!.items.get(i)!);
    const found = new Set(await transport.messagesExist(exportChatId, ids));
    const lost = REQUIRED_ITEMS.filter((i) => !found.has(batch!.items.get(i)!));
    if (lost.length) {
      for (const i of lost) batch.items.delete(i); // deleted / never arrived: wait for it to be sent again
      log.warn({ chat: chatId, lost }, 'manual export not confirmed: Telegram does not show every item in the export bot chat');
      metrics?.exports.inc({ case: 'deposit', outcome: 'manual_unverified' });
      return 'not_delivered';
    }

    // The bot may have exported and confirmed this very case itself a moment ago: never twice.
    const cases = await store.cases.listActive(chatId);
    const recent = cases.find((c) => c.facts.export?.status === 'confirmed' && now - new Date(c.facts.export.at).getTime() < windowMs);
    this.batches.delete(chatId);
    if (recent) {
      log.info({ chat: chatId, case: recent.id }, 'manual export matches a case the bot already confirmed: no second confirmation');
      return 'duplicate';
    }

    const user = await store.users.get(chatId);
    const sent = await outbox.send({
      key: `export-confirmed:manual:${chatId}:${Math.min(...ids)}`, chatId, userId: user?.id ?? chatId, text: SHARED_TEXT,
      meta: { kind: 'reply', html: false, acts: ['export_confirmed'] },
    });
    if (sent.duplicate) return 'duplicate';

    // The case (when the bot still holds one) is with the team now, exactly as after its own export:
    // the export bot's later "PAYMENT CONFIRMED" finds it and tells the customer it is solved.
    const open = cases.find((c) => c.type === 'deposit' && PENDING_STATUSES.includes(c.status));
    if (open) {
      await store.cases.save({
        ...open, status: 'escalated',
        facts: { ...open.facts, lastAsked: [], export: { status: 'confirmed', at: new Date(now).toISOString(), attempts: 0, reason: open.facts.export?.reason, forwarded: open.facts.export?.forwarded ?? {} } },
      });
    }
    metrics?.exports.inc({ case: 'deposit', outcome: 'manual_confirmed' });
    log.info({ chat: chatId, forwards: ids, delivered: sent.sent }, 'manual export verified in the export bot chat: customer told their documents were shared');
    return 'confirmed';
  }
}
