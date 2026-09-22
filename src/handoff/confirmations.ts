import type { Logger } from 'pino';
import { EXPORT_DONE, PENDING_STATUSES, type CaseRecord } from '../domain/cases.js';
import { addressTerm, prefersBrief } from '../domain/memory.js';
import type { OutboxSender } from '../pipeline/outbox.js';
import type { ResponseComposer } from '../response/composer.js';
import { scrubber } from '../security/scrubber.js';
import type { Store } from '../storage/types.js';
import type { KeyedMutex } from '../util/mutex.js';

/**
 * The export bot answers an exported deposit with a "PAYMENT CONFIRMED" message. The customer it
 * is about is found, in this order, from: a `User ID: <telegram id>` in the text; the forwarded
 * message the bot replied to; the `Mobile: <number>` in the text, when exactly one pending
 * exported deposit case carries that registration number. No match → nothing is sent to anyone.
 */
export interface Confirmation {
  userId?: string;
  mobile?: string;
}

export function parseConfirmation(text: string): Confirmation | undefined {
  if (!/PAYMENT\s+CONFIRMED/i.test(text)) return undefined;
  const userId = /User\s*ID\s*[:=]?\s*(\d{5,20})\b/i.exec(text)?.[1];
  const mobile = /(?:Mobile|Phone|Number|Registered\s*(?:no|number))\s*[:=]?\s*(?:\+?91[\s-]?)?(\d{10})\b/i.exec(text)?.[1];
  return { userId, mobile };
}

export class ExportConfirmations {
  constructor(
    private readonly o: { store: Store; outbox: OutboxSender; composer: ResponseComposer; locks: KeyedMutex; log: Logger; botSwitch?: { isOn(): Promise<boolean> } },
  ) {}

  async onExportMessage(msg: { messageId: number; text?: string; replyToMessageId?: number }): Promise<'solved' | 'duplicate' | 'ignored'> {
    const { store, log } = this.o;
    const text = msg.text ?? '';
    const parsed = parseConfirmation(text);
    if (!parsed) {
      log.info({ messageId: msg.messageId, replyTo: msg.replyToMessageId, text: scrubber.scrub(text).slice(0, 300) }, 'export bot message ignored (not a PAYMENT CONFIRMED)');
      return 'ignored';
    }
    const target = await this.findCase(parsed, msg.replyToMessageId);
    if (!target) {
      log.warn({ messageId: msg.messageId, userId: parsed.userId, replyTo: msg.replyToMessageId, text: scrubber.scrub(text).slice(0, 400) }, 'PAYMENT CONFIRMED could not be matched to one pending deposit case; nothing sent');
      return 'ignored';
    }
    const user = await store.users.get(target.userId);
    if (!user) return 'ignored';
    return this.o.locks.run(user.chatId, async () => {
      const c = await store.cases.get(target.id);
      if (!c || !PENDING_STATUSES.includes(c.status)) {
        log.info({ case: target.id }, 'payment confirmed again for a case already solved: nothing sent');
        return 'duplicate';
      }
      const lang = user.preferredLanguage ?? 'hinglish';
      const botOn = !this.o.botSwitch || (await this.o.botSwitch.isOn());
      if (botOn) {
        const composed = await this.o.composer.compose({
          acts: [{ type: 'deposit_solved' }], language: lang, userText: '', history: [], address: addressTerm(user.memory), brief: prefersBrief(user.memory),
        });
        const sent = await this.o.outbox.send({
          key: `solved:${c.id}`, chatId: user.chatId, userId: user.id, text: composed.text,
          meta: { kind: 'reply', html: true, caseId: c.id, caseType: 'deposit', acts: ['deposit_solved'] },
        });
        if (!sent.sent) {
          log.warn({ case: c.id }, 'resolution message could not be sent; case left pending for retry');
          return 'ignored';
        }
      } else {
        // The bot is OFF: the team's confirmation still closes the case, but no automatic message goes out.
        log.info({ case: c.id }, 'bot is OFF: deposit marked solved, customer not messaged');
      }
      c.status = 'resolved';
      c.step = 'solved';
      c.facts.resolution = 'Payment confirmed by the team (export bot)';
      c.facts.lastAsked = [];
      c.missing = [];
      await store.cases.save(c);
      const ticket = await store.tickets.findOpenByCase(c.id);
      if (ticket) await store.tickets.update(ticket.id, { status: 'closed' });
      log.info({ case: c.id, userId: user.id, language: lang, matchedBy: parsed.userId ? 'user_id' : msg.replyToMessageId ? 'reply' : 'mobile' }, 'deposit solved: customer told');
      return 'solved';
    });
  }

  /** The one deposit case the confirmation is about (pending, or already solved → duplicate), or nothing. */
  private async findCase(parsed: Confirmation, replyTo: number | undefined): Promise<CaseRecord | undefined> {
    const { store } = this.o;
    const pending = (c: CaseRecord) => PENDING_STATUSES.includes(c.status);
    const deposit = (c: CaseRecord) => c.type === 'deposit' && (pending(c) || c.step === 'solved');
    const prefer = (list: CaseRecord[]) => list.find(pending) ?? list[0];
    if (parsed.userId) {
      const cases = (await store.cases.listByUser(parsed.userId)).filter(deposit);
      return cases.find((c) => pending(c) && c.facts.export && EXPORT_DONE.includes(c.facts.export.status)) ?? prefer(cases);
    }
    const exported = (await store.cases.listExported()).filter(deposit);
    if (replyTo) {
      const byReply = exported.filter((c) => Object.values(c.facts.export?.forwarded ?? {}).includes(replyTo));
      if (byReply.length) return prefer(byReply);
    }
    if (parsed.mobile) {
      const byMobile = exported.filter((c) => c.registrationNumber === parsed.mobile);
      const open = byMobile.filter(pending);
      if (open.length === 1) return open[0];
      if (open.length > 1) {
        this.o.log.warn({ mobile: parsed.mobile, cases: open.length }, 'PAYMENT CONFIRMED mobile matches several pending customers');
        return undefined;
      }
      return byMobile[0]; // solved already → reported as a duplicate, nothing sent
    }
    return undefined;
  }
}
