import type { VisionAnalysis, VisionAnalyzer, VisionHint } from '../../src/evidence/vision.js';

/** Deterministic vision model: the "image" bytes are a key into a table of analyses. */
export class FakeVision implements VisionAnalyzer {
  readonly available = true;
  readonly calls: Array<{ key: string; hint?: VisionHint }> = [];
  private readonly table = new Map<string, VisionAnalysis>();

  set(key: string, analysis: Partial<VisionAnalysis> & Pick<VisionAnalysis, 'category'>): this {
    this.table.set(key, analysisOf(analysis));
    return this;
  }

  async analyze(image: Buffer, _mime: string, hint?: VisionHint): Promise<VisionAnalysis> {
    const key = image.toString('utf8');
    this.calls.push({ key, hint });
    return this.table.get(key) ?? analysisOf({ category: 'unknown', confidence: 0.1 });
  }
}

export function analysisOf(a: Partial<VisionAnalysis> & Pick<VisionAnalysis, 'category'>): VisionAnalysis {
  return {
    confidence: 0.9,
    transcript: '',
    withdrawals: [],
    statement: { account_number: null, ifsc: null, bank_name: null, holder_name: null },
    technical: { error_text: null, screen: null },
    ...a,
    payment: {
      amount: null, amount_confidence: 0, date: null, time: null, utr: null, utr_confidence: 0, transaction_id: null,
      reference_number: null, status: null, payer: null, payee: null, app: null, ...(a.payment ?? {}),
    },
  };
}

/** Screenshot fixtures reused across tests. */
export const SCREENSHOTS = {
  payment500: analysisOf({
    category: 'payment_screenshot',
    transcript: 'PhonePe\nPayment Successful\n₹500\nPaid to Fantasy Adda\n11 Sep 2026, 09:14 AM\nUTR: 612345678901\nTransaction ID T2609110914',
    payment: { amount: 500, amount_confidence: 0.95, date: '2026-09-11', time: '09:14', utr: '612345678901', utr_confidence: 0.95, status: 'success', app: 'PhonePe' } as VisionAnalysis['payment'],
  }),
  withdrawalHistory: analysisOf({
    category: 'withdrawal_screenshot',
    transcript: 'Withdrawal History\nWD-15436-64215  ₹1,450  Success  05 Sep 2026\nWD-15436-61002  ₹700  Processing  03 Sep 2026\nWD-15436-59990  ₹300  Failed  01 Sep 2026',
    withdrawals: [
      { position: 2, withdrawal_id: 'WD-15436-61002', amount: 700, status: 'Processing', datetime: '2026-09-03', confidence: 0.9 },
      { position: 1, withdrawal_id: 'WD-15436-64215', amount: 1450, status: 'Success', datetime: '2026-09-05', confidence: 0.9 },
      { position: 3, withdrawal_id: 'WD-15436-59990', amount: 300, status: 'Failed', datetime: '2026-09-01', confidence: 0.9 },
    ],
  }),
  withdrawalTwoRows: analysisOf({
    category: 'withdrawal_screenshot',
    transcript: 'My Withdrawals\nWD-20001-11111 ₹900 Success\nWD-20001-22222 ₹400 Success',
    withdrawals: [
      { position: 1, withdrawal_id: 'WD-20001-11111', amount: 900, status: 'Success', datetime: null, confidence: 0.9 },
      { position: 2, withdrawal_id: 'WD-20001-22222', amount: 400, status: 'Success', datetime: null, confidence: 0.9 },
    ],
  }),
  selfie: analysisOf({ category: 'unrelated', confidence: 0.95, transcript: '' }),
};
