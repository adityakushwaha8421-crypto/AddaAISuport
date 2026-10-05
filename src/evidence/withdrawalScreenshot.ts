import type { Logger } from 'pino';
import type { LlmClient } from '../llm/client.js';

/** What a withdrawal shows: the only thing the agent needs to know to choose its next step. */
export type WithdrawalStatus = 'pending' | 'success' | 'failed' | 'reversed' | 'unknown';

/** The team's panel, asked what a withdrawal id shows. Not wired today: an id on its own is left to the team. */
export interface WithdrawalLookup {
  withdrawalStatus(withdrawalId: string): Promise<WithdrawalStatus | undefined>;
}

export interface WithdrawalRow {
  /** As printed on the screen, when legible. */
  withdrawalId?: string;
  status: WithdrawalStatus;
  /** The status word exactly as shown. */
  statusRaw?: string;
  amount?: number;
}

export interface WithdrawalScreenshot {
  /** The app's withdrawal history / a withdrawal status screen — not a bank app, a chat, a meme. */
  isWithdrawalScreen: boolean;
  /** Top-most row first (the latest request). */
  rows: WithdrawalRow[];
}

const STATUS_WORDS: Array<[WithdrawalStatus, RegExp]> = [
  ['success', /^(?:success|successful|succeeded|completed?|paid|processed|settled|credited|done|approved)$/i],
  ['pending', /^(?:pending|processing|in[\s_-]?progress|in[\s_-]?process|initiated|submitted|requested|queued|awaiting|on[\s_-]?hold|hold|under[\s_-]?review|review)$/i],
  ['failed', /^(?:failed|failure|error|declined|bounced|rejected|cancelled|canceled|denied)$/i],
  ['reversed', /^(?:reversed|refunded|returned|reversal)$/i],
];

/** The status word on the screen → what it means. Anything unrecognised is `unknown`, never a guess. */
export function normaliseWithdrawalStatus(raw: string | undefined | null): WithdrawalStatus {
  const s = (raw ?? '').trim();
  for (const [status, re] of STATUS_WORDS) if (re.test(s)) return status;
  return 'unknown';
}

const SYSTEM = `You read ONE image a customer sent to the support of Fantasy Adda (an Indian fantasy-sports app). Be literal and conservative.

1. is_withdrawal_screen: true only when the image is the app's withdrawal history ("Withdraw History") or a withdrawal request / status screen. A bank app, a UPI receipt, a bank statement, a chat, a match screen or anything else is false.
2. rows: every withdrawal row in VISUAL ORDER, position 1 = the top-most row. For each row copy exactly what is printed:
   - withdrawal_id: the transaction / withdrawal id (for example "WD-19106-67317"), or null when it is not clearly legible. Never complete or guess an id.
   - status: the status word exactly as shown ("Success", "Pending", "Processing", "Failed", "Rejected", "Reversed"…), or null when no status is visible.
   - amount: the amount as a number without currency sign, or null.
If the image is not a withdrawal screen, rows is an empty list. Reply with JSON only.`;

const SCHEMA = {
  name: 'withdrawal_screenshot',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['is_withdrawal_screen', 'rows'],
    properties: {
      is_withdrawal_screen: { type: 'boolean' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['position', 'withdrawal_id', 'status', 'amount'],
          properties: { position: { type: 'integer' }, withdrawal_id: { type: ['string', 'null'] }, status: { type: ['string', 'null'] }, amount: { type: ['number', 'null'] } },
        },
      },
    },
  },
};

interface Raw {
  is_withdrawal_screen: boolean;
  rows: Array<{ position: number; withdrawal_id: string | null; status: string | null; amount: number | null }>;
}

/**
 * Read a customer's screenshot of their withdrawal history. Undefined when the model is not
 * available or the read fails: the caller then stays silent and the team looks at the image.
 */
export async function readWithdrawalScreenshot(llm: LlmClient | undefined, image: Buffer, mimeType: string, log: Logger): Promise<WithdrawalScreenshot | undefined> {
  if (!llm?.available) return undefined;
  try {
    const raw = await llm.json<Raw>({
      purpose: 'withdrawal_screenshot',
      system: SYSTEM,
      user: [{ type: 'text', text: 'Read this image.' }, { type: 'image', mimeType, data: image, detail: 'high' }],
      schema: SCHEMA,
      maxTokens: 800,
    });
    const rows = [...(raw.rows ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((r): WithdrawalRow => ({ withdrawalId: r.withdrawal_id?.trim() || undefined, status: normaliseWithdrawalStatus(r.status), statusRaw: r.status?.trim() || undefined, amount: r.amount ?? undefined }));
    return { isWithdrawalScreen: !!raw.is_withdrawal_screen, rows };
  } catch (err) {
    log.warn({ err }, 'the withdrawal screenshot could not be read; leaving it to the team');
    return undefined;
  }
}
