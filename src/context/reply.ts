import type { CaseType } from '../domain/cases.js';
import type { EvidenceItem, WithdrawalCandidate } from '../domain/evidence.js';
import type { MediaRef, ReplySnapshot } from '../domain/messages.js';
import { scrubber } from '../security/scrubber.js';
import type { MessageMeta, Store } from '../storage/types.js';

/** Everything we know about the message a user swiped/replied to. */
export interface ResolvedReply {
  messageId: number;
  fromSelf: boolean;
  text?: string;
  caseId?: string;
  caseType?: CaseType;
  /** Rows the replied message showed (bot candidate list, or rows extracted from the user's screenshot). */
  candidates: WithdrawalCandidate[];
  refs?: MessageMeta['refs'];
  evidence: EvidenceItem[];
  /** Media on the replied message we have never processed (e.g. sent before the bot started). */
  unprocessedMedia: MediaRef[];
}

/**
 * Resolve reply_to_message against our own records first (they carry case links, extracted
 * evidence and what the bot listed), then fall back to the transport snapshot.
 */
export async function resolveReply(store: Store, chatId: string, userId: string, snap: ReplySnapshot): Promise<ResolvedReply> {
  const stored = await store.messages.find(chatId, snap.messageId);
  const evidence = await store.evidence.listByMessage(chatId, snap.messageId);
  const unprocessed: MediaRef[] = [];
  for (const m of snap.media) {
    const already = evidence.some((e) => e.fileUniqueId && e.fileUniqueId === m.fileUniqueId);
    if (already) continue;
    const byFile = m.fileUniqueId ? await store.evidence.findByFile(userId, m.fileUniqueId) : undefined;
    if (byFile) evidence.push(byFile);
    else unprocessed.push(m);
  }
  const fromEvidence = evidence.flatMap((e) => e.withdrawals ?? []);
  const candidates = stored?.meta.candidates?.length ? stored.meta.candidates : fromEvidence;
  const text = stored?.text ?? stored?.caption ?? snap.text ?? snap.caption;
  return {
    messageId: snap.messageId,
    fromSelf: stored ? stored.direction === 'out' : snap.fromSelf,
    text: text ? scrubber.scrub(text).slice(0, 1000) : undefined,
    caseId: stored?.caseId ?? stored?.meta.caseId ?? evidence.find((e) => e.caseId)?.caseId,
    caseType: stored?.meta.caseType,
    candidates,
    refs: stored?.meta.refs,
    evidence,
    unprocessedMedia: unprocessed,
  };
}
