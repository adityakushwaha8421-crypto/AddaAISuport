import type { Logger } from 'pino';
import type { ResolvedReply } from '../context/reply.js';
import type { AdminGateway } from '../domain/admin.js';
import type { CaseRecord, HandoffReason } from '../domain/cases.js';
import type { EvidenceItem } from '../domain/evidence.js';
import type { IngestResult, UnlockResult } from '../evidence/service.js';
import type { UserMemory } from '../domain/memory.js';
import type { Interpretation, Signals } from '../nlu/types.js';
import type { Act } from '../response/acts.js';
import type { MessageMeta } from '../storage/types.js';

export interface WorkflowConfig {
  maxAsksPerSlot: number;
  withdrawalSlaHours: number;
  depositLookbackDays: number;
  /** Re-query non-final payouts / deposits older than this. */
  refreshMinutes: number;
  maxPasswordAttempts: number;
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  maxAsksPerSlot: 2,
  withdrawalSlaHours: 24,
  depositLookbackDays: 30,
  refreshMinutes: 10,
  maxPasswordAttempts: 3,
};

export interface WorkflowDeps {
  admin: AdminGateway;
  cfg: WorkflowConfig;
  log: Logger;
}

export interface WorkflowInput {
  /** Mutable draft; the processor persists it. */
  c: CaseRecord;
  isNew: boolean;
  resumed: boolean;
  interp: Interpretation;
  signals: Signals;
  /** Evidence ingested this turn (duplicates flagged). */
  turnEvidence: IngestResult[];
  /** All evidence linked to the case, including this turn's. */
  caseEvidence: EvidenceItem[];
  reply?: ResolvedReply;
  unlock?: UnlockResult;
  /** What we already know about this customer from earlier cases. */
  memory: UserMemory;
  lastMessageId: number;
  /** The turn's messages, so a fact can be tied to the message that actually carried it. */
  turnMessages: Array<{ messageId: number; text: string }>;
  now: Date;
  deps: WorkflowDeps;
}

export interface HandoffRequest {
  reason: HandoffReason;
  /** User declined to provide more → wording "jo details available hain usi basis par". */
  declined?: boolean;
  note?: string;
}

export interface WorkflowOutput {
  acts: Act[];
  handoff?: HandoffRequest;
  /** For escalated cases: new info to append to the existing ticket. */
  ticketUpdate?: { note: string; evidenceMessageIds: number[] };
  meta?: MessageMeta;
}

export interface Workflow {
  run(input: WorkflowInput): Promise<WorkflowOutput>;
}
