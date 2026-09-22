import type { CaseRecord, HandoffReason } from '../domain/cases.js';
import { describeMemory } from '../domain/memory.js';
import type { EvidenceItem } from '../domain/evidence.js';
import { maskAccount, maskName } from '../security/masking.js';
import { scrubber } from '../security/scrubber.js';
import type { StoredMessage, UserRecord } from '../storage/types.js';
import { inr } from '../response/templates.js';

const REASON_TEXT: Record<HandoffReason, string> = {
  insufficient_evidence: 'Insufficient evidence to resolve automatically',
  conflicting_evidence: 'Conflicting evidence',
  ambiguous_transaction: 'Ambiguous transaction',
  verification_unavailable: 'Admin verification unavailable',
  user_declined_more_info: 'Customer cannot provide more documents',
  user_requested_human: 'Customer asked for a human',
  max_asks_reached: 'Required information not provided after repeated requests',
  deposit_not_reflected: 'Deposit not reflected',
  withdrawal_credit_missing: 'Withdrawal marked SUCCESS but credit missing',
  withdrawal_failed_dispute: 'Customer disputes failed withdrawal',
  withdrawal_sla_breached: 'Withdrawal processing beyond SLA',
  not_found_in_admin: 'Transaction not found in admin panel',
  pdf_unreadable: 'Statement PDF unreadable / password failed',
  unsupported_issue: 'Issue type needs manual handling',
  business_rule: 'Business rule requires human review',
};

export interface HandoffSummary {
  caseId: string;
  shortId: string;
  issueType: string;
  reason: HandoffReason;
  reasonText: string;
  note?: string;
  user: { id: string; username?: string; name?: string };
  registrationNumber?: string;
  withdrawalId?: string;
  orderId?: string;
  amount?: number;
  status?: string;
  utr?: string;
  bank?: { name?: string; account?: string; ifsc?: string; beneficiary?: string };
  deposit?: { matchedOrderId?: string; quality?: string; recentOrders: Array<{ orderId: string; amount?: number; status: string; createdAt?: string }> };
  statement?: { account: string; ifsc: string; bank: string; transaction: string; coversPayoutDate: boolean | null };
  evidence: Array<{ kind: string; category: string; status: string; messageId: number; fields?: string }>;
  evidenceMessageIds: number[];
  missing: string[];
  claims: string[];
  conversation: string[];
  /** Returning-customer context from memory. */
  history?: string;
  aiSummary?: string;
}

function evidenceFields(e: EvidenceItem): string | undefined {
  const parts: string[] = [];
  if (e.payment?.amount) parts.push(`amount ${inr(e.payment.amount.value)}`);
  if (e.payment?.utr) parts.push(`UTR ${e.payment.utr.value}${e.payment.utr.origin === 'vision' ? ' (unconfirmed)' : ''}`);
  if (e.payment?.date) parts.push(`date ${e.payment.date.value}${e.payment.time ? ` ${e.payment.time.value}` : ''}`);
  if (e.payment?.status) parts.push(`status ${e.payment.status.value}`);
  if (e.withdrawals?.length) parts.push(`${e.withdrawals.length} rows: ${e.withdrawals.slice(0, 4).map((w) => `${w.position}) ${w.withdrawalId ?? '?'} ${inr(w.amount)} ${w.status ?? ''}`.trim()).join('; ')}`);
  if (e.statement) parts.push(`statement a/c ${e.statement.accountNumbers.map((a) => maskAccount(a)).join(', ') || '?'} ${e.statement.ifsc ?? ''} ${e.statement.periodFrom ?? ''}→${e.statement.periodTo ?? ''}`.trim());
  if (e.technical?.errorText) parts.push(`error "${e.technical.errorText.slice(0, 120)}"`);
  return parts.length ? parts.join(', ') : undefined;
}

export function buildHandoffSummary(input: {
  c: CaseRecord;
  reason: HandoffReason;
  note?: string;
  user: UserRecord;
  evidence: EvidenceItem[];
  history: StoredMessage[];
  aiSummary?: string;
}): HandoffSummary {
  const { c, user } = input;
  const p = c.facts.payout;
  const claims = Object.entries(c.facts.claims).filter(([, v]) => v).map(([k]) => k);
  const conversation = input.history
    .filter((m) => m.direction === 'in' && (m.text || m.caption))
    .slice(-6)
    .map((m) => scrubber.scrub((m.text ?? m.caption ?? '').replace(/\s+/g, ' ')).slice(0, 200));
  return {
    caseId: c.id,
    shortId: c.id.slice(0, 8).toUpperCase(),
    issueType: c.type.toUpperCase(),
    reason: input.reason,
    reasonText: REASON_TEXT[input.reason],
    note: input.note ? scrubber.scrub(input.note).slice(0, 500) : undefined,
    user: { id: user.id, username: user.username, name: user.firstName },
    registrationNumber: c.registrationNumber,
    withdrawalId: c.withdrawalId,
    orderId: c.orderId,
    amount: c.amount,
    status: p?.status ?? c.facts.deposit?.orders.find((o) => o.orderId === c.orderId)?.status,
    utr: c.utr,
    bank: p ? { name: p.bankName, account: maskAccount(p.accountNumber), ifsc: p.ifsc, beneficiary: maskName(p.beneficiaryName) } : undefined,
    deposit: c.facts.deposit
      ? {
          matchedOrderId: c.facts.deposit.matchedOrderId,
          quality: c.facts.deposit.quality,
          recentOrders: c.facts.deposit.orders.slice(0, 5).map((o) => ({ orderId: o.orderId, amount: o.amount, status: o.status, createdAt: o.createdAt })),
        }
      : undefined,
    statement: c.facts.statementCheck
      ? {
          account: c.facts.statementCheck.account,
          ifsc: c.facts.statementCheck.ifsc,
          bank: c.facts.statementCheck.bank,
          transaction: c.facts.statementCheck.transaction.found ? `found (${c.facts.statementCheck.transaction.quality})` : `not found${c.facts.statementCheck.transaction.quality === 'amount_only' ? ' (same amount on another date)' : ''}`,
          coversPayoutDate: c.facts.statementCheck.coversPayoutDate,
        }
      : undefined,
    evidence: input.evidence.map((e) => ({ kind: e.mediaKind, category: e.category, status: e.status, messageId: e.messageId, fields: evidenceFields(e) })),
    // Forward everything the customer sent as evidence (videos/voice notes too: humans can watch them); skip stickers/memes.
    evidenceMessageIds: [...new Set(input.evidence.filter((e) => e.category !== 'unrelated').map((e) => e.messageId))].slice(0, 6),
    missing: c.missing,
    claims,
    conversation,
    history: describeMemory(input.user.memory),
    aiSummary: input.aiSummary ? scrubber.scrub(input.aiSummary).slice(0, 400) : undefined,
  };
}

/** Plain-text rendering for the support group (no parse mode → no escaping surprises). */
export function renderSupportMessage(s: HandoffSummary): string {
  const line = (label: string, v?: string | number | null) => (v === undefined || v === null || v === '' ? undefined : `${label}: ${v}`);
  const who = [s.user.name, s.user.username ? `@${s.user.username}` : undefined, `id ${s.user.id}`].filter(Boolean).join(' · ');
  const lines = [
    `🆘 ${s.issueType}`,
    `Reason: ${s.reasonText}`,
    line('Note', s.note),
    `User: ${who}`,
    line('Registration no', s.registrationNumber),
    line('Withdrawal ID', s.withdrawalId),
    line('Order ID', s.orderId),
    line('Amount', s.amount !== undefined ? inr(s.amount) : undefined),
    line('Status (admin)', s.status),
    line('UTR/Ref', s.utr),
    s.bank ? `Bank: ${[s.bank.name, s.bank.account, s.bank.ifsc, s.bank.beneficiary].filter(Boolean).join(' · ')}` : undefined,
    s.deposit ? `Deposit match: ${s.deposit.quality ?? '-'}${s.deposit.matchedOrderId ? ` → ${s.deposit.matchedOrderId}` : ''}; recent: ${s.deposit.recentOrders.map((o) => `${o.orderId} ${inr(o.amount)} ${o.status}`).join(', ') || 'none'}` : undefined,
    s.statement ? `Statement check: account ${s.statement.account}, IFSC ${s.statement.ifsc}, bank ${s.statement.bank}, credit ${s.statement.transaction}${s.statement.coversPayoutDate === false ? ', statement ends before payout date' : ''}` : undefined,
    s.evidence.length ? `Evidence:\n${s.evidence.map((e) => `  • ${e.category} (${e.kind}, ${e.status}, msg ${e.messageId})${e.fields ? ` — ${e.fields}` : ''}`).join('\n')}` : 'Evidence: none',
    s.missing.length ? `Missing: ${s.missing.join(', ')}` : undefined,
    s.claims.length ? `Customer says: ${s.claims.join(', ')}` : undefined,
    s.history ? `Customer history: ${s.history}` : undefined,
    s.aiSummary ? `Summary (AI, unverified): ${s.aiSummary}` : undefined,
    s.conversation.length ? `Recent messages:\n${s.conversation.map((m) => `  › ${m}`).join('\n')}` : undefined,
    `Reply to this message to answer the customer.`,
  ];
  return lines.filter(Boolean).join('\n').slice(0, 3900);
}
