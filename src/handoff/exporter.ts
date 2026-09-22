import type { Logger } from 'pino';
import { EXPORT_DONE, type CaseRecord, type ExportState, type HandoffReason, type Slot } from '../domain/cases.js';
import type { EvidenceItem } from '../domain/evidence.js';
import type { Metrics } from '../observability/metrics.js';
import type { Store, UserRecord } from '../storage/types.js';
import type { Transport } from '../telegram/transport.js';
import type { HandoffRequest } from '../workflows/types.js';

/**
 * Evidence export. Once the customer has sent everything the bot asked for in a case, the ORIGINAL
 * messages (real Telegram forwards, nothing else: no header, no summary) go to the export bot, and
 * Telegram is asked whether each of them exists in the bot's chat. Only that verified delivery
 * earns the customer the "shared with our team" confirmation; the upload alone never does.
 *
 * State lives on the case (`facts.export`): which customer message became which forward. A retry
 * sends only what is still missing, never a duplicate.
 */

/** Items a customer can send, and how the case shows that each one has arrived. */
const ITEM_PRESENT: Partial<Record<Slot, (c: CaseRecord) => boolean>> = {
  registration_number: (c) => !!c.registrationNumber,
  payment_proof: (c) => !!c.facts.paymentEvidenceId,
  payment_video: (c) => !!c.facts.paymentVideoEvidenceId,
  bank_statement: (c) => !!c.facts.statementEvidenceId && !c.facts.pendingPdf,
  withdrawal_ref: (c) => !!c.withdrawalId || !!c.facts.withdrawalEvidenceId,
  utr: (c) => !!c.utr,
};

/** Everything the bot asked for in this case that the customer has not sent yet. */
export function missingForExport(c: CaseRecord): Slot[] {
  return (Object.keys(ITEM_PRESENT) as Slot[]).filter((s) => (c.facts.asks[s] ?? 0) > 0 && !ITEM_PRESENT[s]!(c));
}

/**
 * Handoffs that go to the export bot: the evidence is what the team needs, so with items still
 * outstanding the bot keeps collecting. Every other reason means the customer stopped (declined,
 * asked for a human, limits reached): that case goes to the support group as a ticket instead.
 */
const WAITS_FOR_ITEMS = new Set<HandoffRequest['reason']>([
  'verification_unavailable', 'deposit_not_reflected', 'withdrawal_credit_missing', 'withdrawal_failed_dispute',
  'withdrawal_sla_breached', 'not_found_in_admin', 'unsupported_issue',
]);
export const waitsForItems = (req: HandoffRequest, c: CaseRecord) => !req.declined && !c.facts.claims.refusesDocuments && WAITS_FOR_ITEMS.has(req.reason);

const SCREEN_CATEGORIES = new Set(['technical_screenshot', 'account_screenshot', 'technical_recording']);

const FILE_NAME: Partial<Record<EvidenceItem['category'], string>> = { technical_screenshot: 'screenshot', account_screenshot: 'screenshot', technical_recording: 'screen recording' };

export interface ExportPlan {
  /** Customer messages to forward as they are, in the order they were sent. */
  messageIds: number[];
  /** What each of them is, for logs. */
  labels: string[];
}

/**
 * Only the items the bot asked for, never the conversation or a stray photo:
 *  - deposit: the message the number was typed in, payment screenshot, payment video, bank statement PDF
 *  - withdrawal: the message the Withdrawal ID was typed in OR the withdrawal-history screenshot, and the
 *    bank statement PDF — nothing else, even when the customer also typed a number or sent a payment shot
 */
export function exportPlan(c: CaseRecord, evidence: EvidenceItem[]): ExportPlan {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const items = new Map<number, string>();
  const typed = (src?: { source: string; messageId?: number }) => src?.messageId && (src.source === 'text' || src.source === 'reply') ? src.messageId : undefined;
  const withdrawal = c.type === 'withdrawal';
  // The message the customer typed the number in is evidence too (not when the number came from memory).
  const numberMsg = typed(c.facts.sources.registrationNumber);
  if (!withdrawal && c.registrationNumber && numberMsg) items.set(numberMsg, 'registration number');
  const widMsg = typed(c.facts.sources.withdrawalId);
  if (c.withdrawalId && widMsg && !items.has(widMsg)) items.set(widMsg, 'withdrawal ID');
  const roles: Array<[string | undefined, string]> = withdrawal
    ? [[c.facts.withdrawalEvidenceId, 'withdrawal history screenshot'], [c.facts.statementEvidenceId, 'bank statement PDF']]
    : [
      [c.facts.paymentEvidenceId, 'payment screenshot'], [c.facts.paymentVideoEvidenceId, 'payment video'],
      [c.facts.statementEvidenceId, 'bank statement PDF'], [c.facts.withdrawalEvidenceId, 'withdrawal history screenshot'],
    ];
  for (const [id, label] of roles) {
    const e = id ? byId.get(id) : undefined;
    if (!e || items.has(e.messageId)) continue;
    items.set(e.messageId, e.category === 'payment_recording' ? 'payment video' : label);
  }
  if (c.type !== 'deposit' && c.type !== 'withdrawal') {
    for (const e of evidence) if (SCREEN_CATEGORIES.has(e.category) && !items.has(e.messageId)) items.set(e.messageId, FILE_NAME[e.category] ?? e.mediaKind);
  }
  const ordered = [...items.entries()].sort((a, b) => a[0] - b[0]);
  return { messageIds: ordered.map(([id]) => id), labels: ordered.map(([, l]) => l) };
}

export type ExportResult = { ok: true; alreadySent: boolean } | { ok: false; error: string };

export class EvidenceExporter {
  constructor(
    private readonly deps: { store: Store; transport: Pick<Transport, 'forwardMessage' | 'messagesExist'>; exportChatId: string; log: Logger; metrics?: Metrics; clock?: () => Date },
  ) {}

  /**
   * Forward every requested message once (real forwards, nothing else), then ask Telegram whether
   * all of them exist in the bot's chat. Idempotent: a case already exported returns at once; a
   * retry sends only what a previous attempt did not get through.
   */
  async export(c: CaseRecord, user: UserRecord, reason: HandoffReason): Promise<ExportResult> {
    const { store, transport, exportChatId, log, metrics } = this.deps;
    void user;
    if (c.facts.export && EXPORT_DONE.includes(c.facts.export.status)) return { ok: true, alreadySent: true };
    const evidence = await store.evidence.listByIds(c.facts.evidenceIds);
    const plan = exportPlan(c, evidence);
    // FORWARDING from here; a crash leaves the case in this state with the forwards it recorded,
    // and the retry (worker or next message) carries on from there.
    const state: ExportState = { ...(c.facts.export ?? { forwarded: {}, attempts: 0 }), status: 'forwarding', reason, attempts: (c.facts.export?.attempts ?? 0) + 1, at: (this.deps.clock?.() ?? new Date()).toISOString() };
    c.facts.export = state;
    try {
      if (!plan.messageIds.length) throw new Error('nothing to forward');
      for (const mid of plan.messageIds) {
        if (state.forwarded[mid]) continue; // this file already reached the bot
        const r = await transport.forwardMessage(c.chatId, mid, exportChatId);
        if (!r?.messageId) throw new Error(`message ${mid} could not be forwarded`);
        state.forwarded[mid] = r.messageId;
      }
      // Trust Telegram, not our own send calls: every message must exist in the bot's chat.
      const expected = plan.messageIds.map((mid) => state.forwarded[mid]!);
      const found = new Set(await transport.messagesExist(exportChatId, expected));
      const lost = expected.filter((id) => !found.has(id));
      if (lost.length) {
        // Forget what did not arrive so the next attempt sends exactly that again.
        for (const [mid, dest] of Object.entries(state.forwarded)) if (lost.includes(dest)) delete state.forwarded[mid];
        throw new Error(`export bot did not receive ${lost.length} of ${expected.length} messages`);
      }
      state.status = 'verified';
      state.lastError = undefined;
      metrics?.exports.inc({ case: c.type, outcome: 'verified' });
      log.info({ case: c.id, files: plan.labels, attempts: state.attempts }, 'evidence forwarded to the export bot and verified');
      return { ok: true, alreadySent: false };
    } catch (err) {
      state.status = 'failed';
      state.lastError = (err as Error).message.slice(0, 300);
      metrics?.exports.inc({ case: c.type, outcome: 'failed' });
      log.warn({ err, case: c.id, attempts: state.attempts }, 'evidence export failed; the case stays pending and will be retried');
      return { ok: false, error: state.lastError };
    }
  }

  /** Files the customer sent after the export: forwarded to the same bot, no confirmation. */
  async forwardMore(c: CaseRecord, messageIds: number[]): Promise<boolean> {
    const state = c.facts.export;
    const fresh = messageIds.filter((mid) => !state?.forwarded[mid]);
    if (!state || !fresh.length) return false;
    try {
      for (const mid of fresh) {
        const r = await this.deps.transport.forwardMessage(c.chatId, mid, this.deps.exportChatId);
        if (r) state.forwarded[mid] = r.messageId;
      }
      return true;
    } catch (err) {
      this.deps.log.warn({ err, case: c.id }, 'follow-up export failed');
      return false;
    }
  }
}
