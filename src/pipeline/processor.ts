import { DeferJobError } from '../queue/runner.js';
import type { Logger } from 'pino';
import type { CaseService } from '../cases/service.js';
import { routeTurn } from '../cases/router.js';
import { resolveReply, type ResolvedReply } from '../context/reply.js';
import type { AdminGateway } from '../domain/admin.js';
import { EXPORT_DONE, PENDING_STATUSES, type CaseRecord, type CaseType } from '../domain/cases.js';
import { addressTerm, describeMemory, learnStyle, noteVisit, prefersBrief, rememberCase } from '../domain/memory.js';
import { messageBody, type InboundMessage } from '../domain/messages.js';
import type { EvidenceService, IngestResult, UnlockResult } from '../evidence/service.js';
import { missingForExport, waitsForItems, type EvidenceExporter } from '../handoff/exporter.js';
import type { HandoffService } from '../handoff/service.js';
import { summariseCase, type InterpreterInput } from '../nlu/context.js';
import type { EntityPatterns } from '../nlu/entities.js';
import type { Interpreter } from '../nlu/interpreter.js';
import { extractPassword } from '../nlu/password.js';
import { computeSignals } from '../nlu/signals.js';
import type { Intent, Interpretation, Language, Signals } from '../nlu/types.js';
import { placementFor, type Placement, type ChatFolders } from '../monitoring/chatFolders.js';
import type { Metrics } from '../observability/metrics.js';
import { scrubber } from '../security/scrubber.js';
import type { Act } from '../response/acts.js';
import type { ResponseComposer } from '../response/composer.js';
import type { KnowledgeBase } from '../response/knowledge.js';
import type { UserMemory } from '../domain/memory.js';
import type { MessageMeta, Store, StoredMessage, UserRecord } from '../storage/types.js';
import type { ReadStateApi, Transport } from '../telegram/transport.js';
import type { KeyedMutex } from '../util/mutex.js';
import type { Workflow, WorkflowConfig, WorkflowOutput } from '../workflows/types.js';
import type { OutboxSender } from './outbox.js';

export interface ProcessorConfig {
  historyMessages: number;
  /** Customers' IANA timezone; a greeting goes out only on a customer's first message of their day. */
  customerTimezone?: string;
  /** request_only: one evidence request per deposit/withdrawal case, then silence; conversational: the full dialogue. */
  caseReplies?: 'request_only' | 'conversational';
  reopenWindowHours: number;
  workflow: WorkflowConfig;
}

export interface ProcessorDeps {
  store: Store;
  transport: Pick<Transport, 'downloadMedia' | 'sendTyping'>;
  evidence: EvidenceService;
  interpreter: Interpreter;
  cases: CaseService;
  workflows: Record<CaseType, Workflow>;
  admin: AdminGateway;
  handoff: HandoffService;
  composer: ResponseComposer;
  outbox: OutboxSender;
  knowledge: KnowledgeBase;
  locks: KeyedMutex;
  patterns: EntityPatterns;
  cfg: ProcessorConfig;
  /** Files each chat into the "Match issues" or "Support" folder, by its latest message. */
  folders?: Pick<ChatFolders, 'place' | 'leave'>;
  /** Telegram read state: a message a human has already read gets no reply. */
  readState?: ReadStateApi;
  /** Forwards each case's requested items to the export bot once they are all in. */
  exporter?: EvidenceExporter;
  /** The agent's ON/OFF switch (/boton, /botoff): OFF means no reply, no request, nothing. */
  /** The ON/OFF switch; `isOnNow` reads the shared store fresh (the last check before a reply). */
  botSwitch?: { isOn(): Promise<boolean>; isOnNow(): Promise<boolean> };
  log: Logger;
  metrics?: Metrics;
  clock?: () => Date;
}

export interface TurnOutcome {
  turnId: string;
  replied: boolean;
  text?: string;
  caseId?: string;
  acts: string[];
}

/**
 * Structural facts are certainty in themselves: an uploaded document, an identifier, a pointer at
 * a listed row, a password, or a claim the customer made. Without any of those, a low-confidence
 * reading (or an "unclear" one) means we do not know what they want — so we say nothing.
 */
function hasStructure(interp: Interpretation, signals: Signals, ingested: IngestResult[]): boolean {
  const hasEvidence = ingested.some((r) => r.evidence.status === 'processed' || r.evidence.status === 'needs_password');
  const hasEntity = Object.entries(signals.entities).some(([k, v]) => k !== 'dates' && (v as unknown[]).length > 0);
  const hasClaim = Object.values(interp.claims).some(Boolean);
  return hasEvidence || hasEntity || hasClaim || !!signals.reference || signals.passwordCandidates.length > 0 || signals.skipPassword;
}

function isUncertain(interp: Interpretation, signals: Signals, ingested: IngestResult[]): boolean {
  if (hasStructure(interp, signals, ingested)) return false;
  // 'unclear' is the interpreter saying it could not read the message. With nothing structural to
  // act on either, there is nothing to answer — not even a nudge on an open case.
  return interp.intent === 'unclear';
}

/** Hello, ok, thanks: nothing a pending case can act on. */
const SMALL_TALK = new Set<Intent>(['greeting', 'thanks', 'acknowledgement']);
/** A non-match support problem in its own right. */
const ISSUE_INTENTS = new Set<Intent>(['deposit_issue', 'withdrawal_issue', 'payment_issue_unclear', 'account_issue', 'technical_issue']);
/** Replies that may legitimately be sent again word for word (an answer the customer asked for again, a result). */
const REPEATABLE_ACTS = new Set<Act['type']>(['general_answer', 'export_confirmed', 'deposit_solved', 'deposit_success', 'withdrawal_success', 'statement_credit_found']);
/** Text without markup or spacing differences, for comparing what was said. */
const plain = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Words customers use whatever their language ("ok thanks", "hello sir"): they carry no language signal. */
const NEUTRAL_WORDS = /\b(ok+|okay|thanks?|thank\s*you|thx|ty|hi+|hello|hey|sir|bhai|ji|please|pls|plz|yes|no|done|sorry|welcome)\b/gi;

const toHistory = (msgs: StoredMessage[]) =>
  msgs
    .filter((m) => m.text || m.caption || m.media.length)
    .map((m) => ({
      role: m.direction === 'in' ? ('user' as const) : ('bot' as const),
      text: (m.text ?? m.caption ?? '') + (m.media.length ? ` [${m.media.map((x) => x.kind).join(', ')}]` : ''),
    }));

/**
 * One turn = one logical reply. Stages: context → evidence → signals → interpretation → routing →
 * workflow (verification) → handoff → composition → outbox. All per-chat work runs under a lock.
 */
export class TurnProcessor {
  constructor(private readonly deps: ProcessorDeps) {}

  private now() {
    return this.deps.clock?.() ?? new Date();
  }

  /**
   * Receiver + idempotency. Persists the inbound message (secrets already redacted) and returns
   * false for duplicates (Telegram redelivery, double events).
   */
  async receive(msg: InboundMessage): Promise<boolean> {
    const { store, metrics } = this.deps;
    metrics?.inboundMessages.inc();
    const active = await store.cases.listActive(msg.userId);
    const awaitingPassword = active.some((c) => c.facts.pendingPdf);
    const redact = (s?: string) => (s ? scrubber.scrub(extractPassword(s, { awaitingPassword }).redactedText) : undefined);
    const { inserted } = await store.messages.insert({
      chatId: msg.chatId,
      userId: msg.userId,
      telegramMessageId: msg.messageId,
      direction: 'in',
      text: redact(msg.text),
      caption: redact(msg.caption),
      media: msg.media,
      replyToMessageId: msg.replyTo?.messageId,
      meta: {},
      createdAt: msg.date,
    });
    if (!inserted) metrics?.duplicateMessages.inc();
    return inserted;
  }

  async process(chatId: string, raw: InboundMessage[], ctx: { jobId?: string; log?: Logger } = {}): Promise<TurnOutcome | undefined> {
    if (!raw.length) return undefined;
    return this.deps.locks.run(chatId, () => this.processLocked(chatId, raw, ctx));
  }

  private async processLocked(chatId: string, raw: InboundMessage[], ctx: { jobId?: string; log?: Logger }): Promise<TurnOutcome | undefined> {
    const { store, metrics } = this.deps;
    const started = Date.now();
    const now = this.now();
    const last = raw[raw.length - 1]!;
    const latestId = Math.max(...raw.map((m) => m.messageId));
    const user = await store.users.upsert({
      id: last.userId, chatId, username: last.sender.username, firstName: last.sender.firstName, languageCode: last.sender.languageCode,
    });
    const turn = await store.turns.create({ chatId, userId: user.id, messageIds: raw.map((m) => m.messageId) });
    // Every line of this turn carries who, which messages, and which job — never any content.
    let tlog = (ctx.log ?? this.deps.log).child({ turn: turn.id, chat: chatId, user: user.id, messages: raw.map((m) => m.messageId), ...(ctx.jobId ? { job: ctx.jobId } : {}) });
    const trace: Record<string, unknown> = { messages: raw.length };
    let filed = false; // the chat folders already reflect this turn
    let requestedNow = false; // this turn is a case's one evidence request (request-only mode)

    // Switched OFF by an admin: nothing is done now — not read, not interpreted, not answered; the
    // turn waits in the queue for /boton. Read fresh from the store: every process sees the same state.
    if (this.deps.botSwitch && !(await this.deps.botSwitch.isOnNow())) {
      await store.turns.update(turn.id, { status: 'skipped', trace: scrubber.scrubDeep({ ...trace, reason: 'bot_off_deferred' }), completedAt: new Date() });
      tlog.info('bot is OFF: turn deferred until it is switched on');
      throw new DeferJobError('bot is off');
    }

    try {
      // While a human handles the chat the bot never replies, but every message is still read: the
      // latest message decides the chat's folder, however recently it moved. The same holds for a
      // message a human already read on Telegram — whatever it says, it is theirs to answer.
      const takenOver = !!(user.humanTakeoverUntil && user.humanTakeoverUntil > now);
      let seen = await this.seenByHuman(chatId, latestId, tlog);
      const memoryBefore = JSON.stringify(user.memory);

      const { cases, focused } = await this.deps.cases.load(user);
      // No "typing…" either in a case that has had its one request: the bot is out of that conversation.
      if (!takenOver && !seen && !(focused && this.silentCase(focused))) void this.deps.transport.sendTyping(chatId).catch(() => undefined);
      const signals = computeSignals(raw.map(messageBody), {
        awaitingPassword: cases.some((c) => c.facts.pendingPdf),
        patterns: this.deps.patterns,
        now,
        hasMedia: raw.some((m) => m.media.length > 0),
      });

      // Learn how this customer writes (address, brevity) from their own words.
      user.memory = learnStyle(user.memory, signals.text);
      // Their first message of the day (their calendar day) is the only one the bot may greet on.
      const visit = noteVisit(user.memory, now, this.deps.cfg.customerTimezone ?? 'Asia/Kolkata');
      user.memory = visit.memory;
      trace.firstOfDay = visit.firstOfDay;

      const replyMsg = [...raw].reverse().find((m) => m.replyTo);
      const reply = replyMsg?.replyTo ? await resolveReply(store, chatId, user.id, replyMsg.replyTo) : undefined;

      const ingested = await this.ingestEvidence(raw, user, focused, reply);
      const history = (await store.messages.recent(chatId, this.deps.cfg.historyMessages + raw.length)).filter(
        (m) => !(m.direction === 'in' && raw.some((r) => r.messageId === m.telegramMessageId)),
      );

      const interp = await this.deps.interpreter.interpret(this.interpreterInput(signals, cases, focused, history, reply, ingested, now, user.memory, visit.firstOfDay));
      trace.interp = { intent: interp.intent, caseType: interp.caseType, relation: interp.relation, source: interp.source, confidence: interp.confidence, claims: interp.claims, reference: interp.reference };

      // Match issues are for the team only: anything match-related (even next to another problem)
      // is filed in "Match issues" and gets no reply, no request, no greeting, no case. The chat
      // then stays there, and the bot stays out of it, until a human answers — or the customer
      // raises a different support problem, which the bot handles and files under "Support".
      const matchTurn = interp.intent === 'match_issue' || !!interp.matchIssue;
      const reviewPending = !!user.memory.matchReviewPending && !matchTurn && !takenOver;
      const breaksReview = ISSUE_INTENTS.has(interp.intent) || interp.intent === 'human_request' || ingested.length > 0
        || (interp.intent === 'provide_info' && !!focused && PENDING_STATUSES.includes(focused.status));
      const heldForReview = reviewPending && !breaksReview;

      // Folders for the human team, decided by this message alone: a match problem → "Match issues",
      // any other support matter → "Support", small talk → neither. The customer is never told.
      filed = true;
      const placement: Placement | undefined = matchTurn ? 'match' : heldForReview ? undefined : placementFor(interp, focused);
      const folder = placement ? await this.deps.folders?.place(chatId, placement, interp.matchIssue?.category) : undefined;
      trace.folder = { placement: placement ?? 'kept_for_review', changes: folder };
      if (interp.matchIssue) trace.matchIssue = interp.matchIssue.category;
      if (matchTurn) user.memory = { ...user.memory, matchReviewPending: now.toISOString() };
      else if (placement === 'support' && user.memory.matchReviewPending) {
        const { matchReviewPending: _done, ...rest } = user.memory;
        user.memory = rest;
      }
      // Checked again: the human may have opened the chat while the message was being read.
      if (!seen) seen = await this.seenByHuman(chatId, latestId, tlog);
      // A human has this chat (they replied, or read the message): the bot says nothing, asks for
      // nothing and starts nothing — whatever the message says — until the human hands it back.
      if (seen || takenOver) {
        const reason = seen ? 'seen_by_human' : 'human_takeover';
        await store.messages.markProcessed(chatId, raw.map((m) => m.messageId), { turnId: turn.id });
        await store.turns.update(turn.id, { status: 'skipped', trace: scrubber.scrubDeep({ ...trace, reason }), completedAt: new Date() });
        metrics?.turns.inc({ outcome: reason, intent: interp.intent, interpreter: interp.source });
        tlog.info({ reason, intent: interp.intent, folder }, 'turn skipped: no reply');
        if (JSON.stringify(user.memory) !== memoryBefore) await store.users.saveMemory(user.id, user.memory);
        return { turnId: turn.id, replied: false, acts: [] };
      }
      if (matchTurn || heldForReview) {
        const reason = matchTurn ? 'match_issue' : 'match_review_pending';
        await store.messages.markProcessed(chatId, raw.map((m) => m.messageId), { turnId: turn.id });
        await store.turns.update(turn.id, { status: 'skipped', trace: scrubber.scrubDeep({ ...trace, reason }), completedAt: new Date() });
        metrics?.turns.inc({ outcome: reason, intent: interp.intent, interpreter: interp.source });
        tlog.info({ category: interp.matchIssue?.category, intent: interp.intent, folder }, matchTurn ? 'match issue: chat filed for manual review, no reply' : 'match issue awaiting the team: no reply');
        if (JSON.stringify(user.memory) !== memoryBefore) await store.users.saveMemory(user.id, user.memory);
        return { turnId: turn.id, replied: false, acts: [] };
      }

      // Uncertain turns end here: no case work, no reply. Humans see them in the transcript.
      if (isUncertain(interp, signals, ingested)) {
        await store.messages.markProcessed(chatId, raw.map((m) => m.messageId), { turnId: turn.id });
        await store.turns.update(turn.id, { status: 'skipped', trace: scrubber.scrubDeep({ ...trace, reason: 'uncertain' }), completedAt: new Date() });
        metrics?.turns.inc({ outcome: 'uncertain', intent: interp.intent, interpreter: interp.source });
        tlog.info({ intent: interp.intent, confidence: interp.confidence }, 'turn skipped: message not understood, staying silent');
        if (JSON.stringify(user.memory) !== memoryBefore) await store.users.saveMemory(user.id, user.memory);
        return { turnId: turn.id, replied: false, acts: [] };
      }

      // A request is out (or humans have the case): a hello, ok or thanks answers nothing. Wait in
      // silence and leave every case exactly as it is; details, a new issue or a document move on.
      if (SMALL_TALK.has(interp.intent) && !hasStructure(interp, signals, ingested) && cases.some((k) => PENDING_STATUSES.includes(k.status))) {
        await store.messages.markProcessed(chatId, raw.map((m) => m.messageId), { turnId: turn.id });
        await store.turns.update(turn.id, { status: 'skipped', trace: scrubber.scrubDeep({ ...trace, reason: 'awaiting_details' }), completedAt: new Date() });
        metrics?.turns.inc({ outcome: 'awaiting_details', intent: interp.intent, interpreter: interp.source });
        tlog.info({ intent: interp.intent }, 'turn skipped: waiting for the requested details');
        if (JSON.stringify(user.memory) !== memoryBefore) await store.users.saveMemory(user.id, user.memory);
        return { turnId: turn.id, replied: false, acts: [] };
      }

      const decision = routeTurn({
        cases, focused, interp, signals, turnEvidence: ingested.map((r) => r.evidence), reply, now, reopenWindowHours: this.deps.cfg.reopenWindowHours,
      });
      trace.route = { kind: decision.kind, why: decision.why };
      const applied = await this.deps.cases.apply(user, focused, decision, now);
      if (applied.case) tlog = tlog.child({ case: applied.case.id, caseType: applied.case.type });

      let out: WorkflowOutput;
      let c: CaseRecord | undefined = applied.case;
      if (c) {
        const res = await this.runCase(c, applied, interp, signals, ingested, reply, raw, user, history, now, trace);
        out = res.out;
        c = res.c;
        // Request-only mode: a deposit/withdrawal case gets exactly one message — the evidence request —
        // and after that the bot says nothing in it (no acks, reminders, choices, status, confirmations).
        // The work still happens (facts absorbed, files exported, tickets filed); the team talks to the customer.
        if (this.deps.cfg.caseReplies !== 'conversational' && (c.type === 'deposit' || c.type === 'withdrawal')) {
          const request = out.acts.find((a): a is Extract<Act, { type: 'ask' }> => a.type === 'ask' && a.mode === 'initial' && !a.slots.includes('pdf_password') && !a.slots.includes('withdrawal_choice'));
          if (c.facts.requestSentAt) {
            trace.requestOnly = 'silent';
            out.acts = [];
          } else if (request) {
            trace.requestOnly = 'request';
            out.acts = [request];
            c.facts.requestSentAt = now.toISOString();
            c = await store.cases.save(c);
            requestedNow = true;
          } else {
            trace.requestOnly = 'nothing_to_request';
            out.acts = [];
          }
        }
      } else {
        out = this.general(interp, signals, ingested, visit.firstOfDay);
      }

      // Numbers, IDs, "ok" or a bare password say nothing about language: keep the user's.
      const words = signals.text.replace(/\[[A-Z_]+\]/g, ' ').replace(/\b(pdf\s*)?password\b|\bpwd\b/gi, ' ').replace(NEUTRAL_WORDS, ' ');
      const wordy = (words.match(/[A-Za-zऀ-ॿ]{2,}/g) ?? []).length >= 2;
      const detected = !wordy ? undefined : interp.source === 'llm' ? interp.language : signals.language;
      const lang: Language = detected ?? user.preferredLanguage ?? 'hinglish';
      if (lang !== user.preferredLanguage) await store.users.setPreferredLanguage(user.id, lang);

      trace.acts = out.acts.map((a) => a.type);
      // Last looks before composing: a human who read the message meanwhile answers it, not the bot;
      // and an admin who switched the bot OFF meanwhile wants nothing sent, not even a prepared reply.
      const readMeanwhile = out.acts.length > 0 && (await this.seenByHuman(chatId, latestId, tlog));
      if (readMeanwhile) {
        trace.reason = 'seen_by_human';
        tlog.info({ intent: interp.intent }, 'reply dropped: a human read the message while it was being prepared');
      }
      let switchedOff = out.acts.length > 0 && !readMeanwhile && !!this.deps.botSwitch && !(await this.deps.botSwitch.isOnNow());
      let text: string | undefined;
      if (out.acts.length && !readMeanwhile && !switchedOff) {
        const composed = await this.deps.composer.compose({
          acts: out.acts, language: lang, userText: signals.text, history: toHistory(history),
          address: addressTerm(user.memory), brief: prefersBrief(user.memory),
        });
        text = composed.text;
        trace.compose = { source: composed.source, guard: composed.guardRejection };
        // Last check against the conversation: small talk or an unreadable message that would make
        // the bot say word for word what it said last (within a day) is a repeat — of a greeting, an
        // answer, an instruction — and repeats are not sent. A turn that asks something (a nudge, a
        // status question, "kya bhejna hai?", a file, an identifier) may earn the same answer again;
        // so may the day's one greeting.
        const lastOut = [...history].reverse().find((m) => m.direction === 'out');
        const idleTurn = (SMALL_TALK.has(interp.intent) || interp.intent === 'unclear') && ingested.length === 0 && !replyMsg && !signals.reference
          && !Object.entries(signals.entities).some(([k, v]) => k !== 'dates' && (v as unknown[]).length > 0);
        const dayGreeting = visit.firstOfDay && out.acts.some((a) => a.type === 'greeting' && !a.again);
        const recent = !!lastOut && now.getTime() - lastOut.createdAt.getTime() < 24 * 3_600_000;
        if (lastOut?.text && recent && idleTurn && !dayGreeting && !out.acts.some((a) => REPEATABLE_ACTS.has(a.type)) && plain(text) === plain(lastOut.text)) {
          trace.reason = 'repeat_of_last_reply';
          tlog.info({ intent: interp.intent, acts: trace.acts }, 'reply dropped: identical to the previous reply and nothing new arrived');
          text = undefined;
        } else {
          const meta: MessageMeta = { kind: 'reply', html: true, caseId: c?.id, caseType: c?.type, acts: out.acts.map((a) => a.type), candidates: out.meta?.candidates, refs: out.meta?.refs };
          const threaded = raw.length > 1 || !!replyMsg;
          // Keyed by the messages, not the turn row: a turn re-run after a crash can never reply twice.
          // The transport reads the switch once more right before the send: OFF cancels the reply for good.
          const sent = await this.deps.outbox.send({ key: `turn:${chatId}:${latestId}`, chatId, userId: user.id, text, replyToMessageId: threaded ? last.messageId : undefined, meta });
          trace.delivered = sent.sent;
          if (sent.cancelled) {
            switchedOff = true;
            text = undefined;
          }
        }
      }
      if (switchedOff) {
        trace.reason = 'bot_off';
        tlog.info({ intent: interp.intent, acts: trace.acts }, 'reply cancelled: the bot was switched OFF while the message was being handled');
        // The case's one evidence request never reached the customer: it is still owed, in full, the
        // next time they write while the bot is ON — so the case forgets it ever asked.
        if (requestedNow && c) {
          delete c.facts.requestSentAt;
          c.facts.asks = {};
          c.facts.lastAsked = [];
          c = await store.cases.save(c);
        }
      }

      if (JSON.stringify(user.memory) !== memoryBefore) await store.users.saveMemory(user.id, user.memory);
      await store.messages.markProcessed(chatId, raw.map((m) => m.messageId), { turnId: turn.id, caseId: c?.id });
      const outcome = text ? 'responded' : readMeanwhile ? 'seen_by_human' : switchedOff ? 'bot_off' : 'no_reply';
      await store.turns.update(turn.id, { status: readMeanwhile || switchedOff ? 'skipped' : text ? 'responded' : 'no_reply', caseId: c?.id, trace: scrubber.scrubDeep(trace), completedAt: new Date() });
      metrics?.turns.inc({ outcome, intent: interp.intent, interpreter: interp.source });
      // Operational breadcrumb (no message content).
      tlog.info(
        { intent: interp.intent, interpreter: interp.source, route: decision.kind, case: c?.type, acts: out.acts.map((a) => a.type), replied: !!text, delivered: trace.delivered, ms: Date.now() - started },
        'turn processed',
      );
      return { turnId: turn.id, replied: !!text, text, caseId: c?.id, acts: out.acts.map((a) => a.type) };
    } catch (err) {
      tlog.error({ err }, 'turn failed');
      if (!filed) await this.deps.folders?.leave(chatId, 'match', 'turn_failed');
      metrics?.turns.inc({ outcome: 'failed' });
      await store.turns.update(turn.id, { status: 'failed', error: scrubber.scrub((err as Error).message).slice(0, 1000), trace: scrubber.scrubDeep(trace), completedAt: new Date() });
      await store.messages.markProcessed(chatId, raw.map((m) => m.messageId), { turnId: turn.id }).catch(() => undefined);
      return { turnId: turn.id, replied: true, acts: ['error_fallback'] };
    } finally {
      metrics?.turnLatency.observe(Date.now() - started);
    }
  }

  /** A support issue of a different kind than the customer's latest case: not the one the human is on. */
  /** A deposit/withdrawal case that has had its one evidence request, in request-only mode. */
  private silentCase(c: CaseRecord): boolean {
    return this.deps.cfg.caseReplies !== 'conversational' && (c.type === 'deposit' || c.type === 'withdrawal') && !!c.facts.requestSentAt;
  }

  /** Unknown read state counts as unread: a fresh message is unread unless Telegram says otherwise. */
  private async seenByHuman(chatId: string, messageId: number, tlog: Logger): Promise<boolean> {
    if (!this.deps.readState) return false;
    try {
      return await this.deps.readState.seenByHuman(chatId, messageId);
    } catch (err) {
      tlog.warn({ err }, 'could not read Telegram read state; treating the message as unread');
      return false;
    }
  }

  private async ingestEvidence(raw: InboundMessage[], user: UserRecord, focused: CaseRecord | undefined, reply?: ResolvedReply): Promise<IngestResult[]> {
    const hint = focused ? { caseType: focused.type, expecting: focused.facts.lastAsked.join(', ') || undefined } : undefined;
    const out: IngestResult[] = [];
    for (const m of raw) {
      for (const media of m.media) {
        out.push(await this.deps.evidence.ingest(media, { userId: user.id, chatId: user.chatId, messageId: m.messageId, caseId: focused?.id }, hint));
      }
    }
    // The user swiped onto an older attachment we never analysed (e.g. sent before the bot ran).
    if (reply) {
      for (const media of reply.unprocessedMedia.slice(0, 2)) {
        const r = await this.deps.evidence.ingest(media, { userId: user.id, chatId: user.chatId, messageId: reply.messageId }, hint);
        reply.evidence.push(r.evidence);
        if (!reply.candidates.length && r.evidence.withdrawals?.length) reply.candidates = r.evidence.withdrawals;
      }
    }
    return out;
  }

  private interpreterInput(
    signals: Signals, cases: CaseRecord[], focused: CaseRecord | undefined, history: StoredMessage[], reply: ResolvedReply | undefined, ingested: IngestResult[], now: Date,
    memory?: UserMemory,
    firstMessageOfDay?: boolean,
  ): InterpreterInput {
    const lastBot = [...history].reverse().find((m) => m.direction === 'out');
    return {
      signals,
      customer: describeMemory(memory),
      firstMessageOfDay,
      focused: focused ? summariseCase(focused, now) : undefined,
      others: cases.filter((c) => c.id !== focused?.id).map((c) => summariseCase(c, now)),
      history: toHistory(history),
      lastBot: lastBot ? { text: lastBot.text ?? '', acts: lastBot.meta.acts ?? [] } : undefined,
      reply: reply
        ? {
            fromSelf: reply.fromSelf,
            text: reply.text,
            caseId: reply.caseId,
            caseType: reply.caseType ?? cases.find((c) => c.id === reply.caseId)?.type,
            candidateCount: reply.candidates.length,
            evidenceCategories: reply.evidence.map((e) => e.category),
          }
        : undefined,
      evidence: ingested.map((r) => ({
        category: r.evidence.category,
        confidence: r.evidence.categoryConfidence,
        summary: [r.evidence.status, r.duplicate ? 'resent' : undefined, r.evidence.withdrawals?.length ? `${r.evidence.withdrawals.length} rows` : undefined]
          .filter(Boolean)
          .join(', '),
      })),
    };
  }

  private async runCase(
    c: CaseRecord,
    applied: { isNew: boolean; resumed: boolean },
    interp: Interpretation,
    signals: Signals,
    ingested: IngestResult[],
    reply: ResolvedReply | undefined,
    raw: InboundMessage[],
    user: UserRecord,
    history: StoredMessage[],
    now: Date,
    trace: Record<string, unknown>,
  ): Promise<{ out: WorkflowOutput; c: CaseRecord }> {
    const { store, evidence, handoff } = this.deps;

    let unlock: UnlockResult | undefined;
    if (c.facts.pendingPdf && signals.passwordCandidates.length) {
      const ev = await store.evidence.get(c.facts.pendingPdf.evidenceId);
      if (ev) unlock = await evidence.unlockPdf(ev, signals.passwordCandidates, (ref) => this.deps.transport.downloadMedia(ref));
      trace.unlock = unlock ? { ok: unlock.ok, tried: unlock.tried } : undefined;
    }

    const ids = [...new Set([...c.facts.evidenceIds, ...ingested.map((r) => r.evidence.id), ...(c.facts.pendingPdf ? [c.facts.pendingPdf.evidenceId] : [])])];
    const caseEvidence = await store.evidence.listByIds(ids);
    // Request-only mode: nothing after the one request is ever sent, so nothing counts as nagging —
    // no ask limit, and a frustrated customer is not a reason to abandon collecting for the team.
    const requestOnly = this.deps.cfg.caseReplies !== 'conversational' && (c.type === 'deposit' || c.type === 'withdrawal');
    const wfInterp = requestOnly ? { ...interp, claims: { ...interp.claims, frustrated: false } } : interp;
    const wfCfg = requestOnly ? { ...this.deps.cfg.workflow, maxAsksPerSlot: Number.POSITIVE_INFINITY } : this.deps.cfg.workflow;
    const out = await this.deps.workflows[c.type].run({
      c, isNew: applied.isNew, resumed: applied.resumed, interp: wfInterp, signals, turnEvidence: ingested, caseEvidence, reply, unlock, now,
      lastMessageId: raw[raw.length - 1]!.messageId, turnMessages: raw.map((m) => ({ messageId: m.messageId, text: messageBody(m) })),
      memory: user.memory,
      deps: { admin: this.deps.admin, cfg: wfCfg, log: this.deps.log },
    });

    if (out.ticketUpdate) {
      trace.ticketUpdate = await handoff.appendUpdate(c.id, out.ticketUpdate.note, out.ticketUpdate.evidenceMessageIds);
      // The team has the case through the export bot: later files go the same way.
      if (c.facts.export && EXPORT_DONE.includes(c.facts.export.status) && out.ticketUpdate.evidenceMessageIds.length) {
        trace.exportMore = await this.deps.exporter?.forwardMore(c, out.ticketUpdate.evidenceMessageIds);
      }
    }

    // Export gate: the team gets a case only with everything the bot asked for, and the customer
    // hears "shared with our team" only once the export bot actually has it all.
    let exported = false;
    if (out.handoff && this.deps.exporter) {
      const missing = missingForExport(c);
      if (!waitsForItems(out.handoff, c)) {
        // The customer stopped short or wants a person: a support-group ticket, saying what never arrived.
        if (missing.length) {
          const note = `Not exported, missing: ${missing.join(', ')}.${out.handoff.note ? ` ${out.handoff.note}` : ''}`;
          out.handoff = c.facts.claims.refusesDocuments ? { reason: 'user_declined_more_info', declined: true, note } : { ...out.handoff, note };
        }
      } else if (missing.length) {
        // Still collecting: no handoff, no reminder, nothing changes for the customer.
        trace.exportWait = missing;
        c.missing = missing;
        out.handoff = undefined;
      } else {
        const r = await this.deps.exporter.export(c, user, out.handoff.reason);
        trace.export = r.ok ? { ok: true } : { ok: false, error: r.error };
        if (r.ok) {
          exported = true;
          // Verified delivery, and (conversational mode) the confirmation goes out once per case: VERIFIED → CONFIRMED.
          if (c.facts.export!.status !== 'confirmed' && this.deps.cfg.caseReplies === 'conversational') {
            c.facts.export!.status = 'confirmed';
            out.acts.push({ type: 'export_confirmed' });
          }
        } else {
          // Not shared, so never say it was: the case stays pending and the next message retries.
          out.handoff = undefined;
        }
      }
    }

    if (out.handoff && exported) {
      // The team has the case through the export bot: no ticket, no summary anywhere else.
      c.facts.handoffReason = out.handoff.reason;
      c.facts.lastAsked = [];
      c.status = 'escalated';
      out.acts = out.acts.filter((a) => a.type !== 'ask' && a.type !== 'clarify_issue_type');
      trace.handoff = { reason: out.handoff.reason, exported: true };
    } else if (out.handoff) {
      const allEvidence = await store.evidence.listByIds(c.facts.evidenceIds);
      const res = await handoff.escalate(c, out.handoff, { user, evidence: allEvidence, history });
      c.facts.handoffReason = out.handoff.reason;
      c.facts.lastAsked = [];
      // The customer is told nothing: no escalation, forwarding or "please wait" message.
      if (res.delivered) {
        c.status = 'escalated';
        c.escalation = 'delivered';
      } else {
        c.escalation = 'failed';
      }
      // Anything we were about to ask for is dropped too: the case is with humans now.
      out.acts = out.acts.filter((a) => a.type !== 'ask' && a.type !== 'clarify_issue_type');
      trace.handoff = { reason: out.handoff.reason, delivered: res.delivered };
    }

    const saved = await store.cases.save(c);
    // Personalised memory: what we learned here helps the next conversation start further ahead.
    user.memory = rememberCase(user.memory, saved, now);
    for (const r of ingested) {
      if (!r.evidence.caseId || r.evidence.caseId !== saved.id) {
        const fresh = await store.evidence.get(r.evidence.id);
        if (fresh && !fresh.caseId) await store.evidence.update({ ...fresh, caseId: saved.id });
      }
    }
    trace.case = { id: saved.id, type: saved.type, status: saved.status, step: saved.step, missing: saved.missing };
    return { out, c: saved };
  }

  /** Turns that belong to no case: smalltalk and unrelated questions. Never leaks case data. */
  private general(interp: Interpretation, signals: Signals, ingested: IngestResult[], firstOfDay: boolean): WorkflowOutput {
    const acts: Act[] = [];
    if (ingested.some((r) => r.evidence.category === 'unrelated' || r.evidence.category === 'unknown')) acts.push({ type: 'evidence_unrelated' });
    switch (interp.intent) {
      case 'greeting': {
        // One greeting per customer per day, on their first message of the day. Any later "hi" the
        // same day is answered ("ji sir, bataiye") or, for "kaise ho", replied to — never re-welcomed.
        const howAreYou = /kaise\s*ho|kya\s*haal|how\s*are\s*you|कैसे\s*हो/i.test(signals.text);
        acts.push(firstOfDay ? { type: 'greeting' } : { type: 'greeting', again: howAreYou ? 'how_are_you' : 'hello' });
        break;
      }
      case 'thanks':
        acts.push({ type: 'thanks' });
        break;
      case 'acknowledgement':
        break; // nothing to add; don't repeat status
      case 'general_query': {
        // Only answer from approved knowledge. Outside it, stay silent rather than guess.
        const knowledge = this.deps.knowledge.search(signals.text).map((k) => k.answer);
        if (knowledge.length) acts.push({ type: 'general_answer', question: signals.text, knowledge });
        break;
      }
      default:
        break; // unclear / unknown: say nothing
    }
    return { acts };
  }
}
