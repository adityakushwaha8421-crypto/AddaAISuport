import type { AdminFixtures } from '../../src/admin/fixture.js';

/** Admin-panel data shared by the conversation regression tests. Clock is 2026-09-11 12:00 IST. */
export const ADMIN_FIXTURES: AdminFixtures = {
  payouts: [
    {
      withdrawalId: 'WD-15436-64215', amount: 1450, status: 'SUCCESS', statusRaw: 'Success', beneficiaryName: 'RAHUL KUMAR',
      bankName: 'HDFC Bank', branch: 'Andheri East', accountNumber: '50100123456789', ifsc: 'HDFC0001234', utr: '523456789012',
      gateway: 'PayoutX', vendorOrderId: 'VX-88121', requestedAt: '2026-09-05T09:40:00+05:30', processedAt: '2026-09-05T10:00:00+05:30',
    },
    { withdrawalId: 'WD-15436-61002', amount: 700, status: 'PROCESSING', statusRaw: 'Processing', requestedAt: '2026-09-11T10:00:00+05:30', accountNumber: '50100123456789', bankName: 'HDFC Bank' },
    { withdrawalId: 'WD-15436-59990', amount: 300, status: 'FAILED', statusRaw: 'Failed', failureReason: 'Invalid IFSC', requestedAt: '2026-09-01T10:00:00+05:30' },
    {
      withdrawalId: 'WD-20001-11111', amount: 900, status: 'SUCCESS', bankName: 'State Bank of India', accountNumber: '30012345678',
      ifsc: 'SBIN0004321', utr: '611112222333', processedAt: '2026-09-09T12:00:00+05:30',
    },
    {
      withdrawalId: 'WD-20001-22222', amount: 400, status: 'SUCCESS', bankName: 'State Bank of India', accountNumber: '30012345678',
      ifsc: 'SBIN0004321', utr: '622223333444', processedAt: '2026-09-08T12:00:00+05:30',
    },
  ],
  deposits: [
    { registrationNumber: '9810822372', orderId: 'ORD771001', amount: 500, status: 'SUCCESS', utr: '612345678901', createdAt: '2026-09-11T09:15:00+05:30' },
    { registrationNumber: '9810822372', orderId: 'ORD771002', amount: 1000, status: 'PENDING', createdAt: '2026-09-10T18:00:00+05:30' },
    { registrationNumber: '9876543210', orderId: 'ORD880001', amount: 250, status: 'SUCCESS', createdAt: '2026-09-10T11:00:00+05:30' },
  ],
};

/** Statement of the HDFC account WD-15436-64215 was paid to — contains the payout credit. */
export const HDFC_STATEMENT_WITH_CREDIT = [
  'HDFC Bank Ltd', 'Statement of Account', 'Account Holder Name: RAHUL KUMAR', 'Account No : 50100123456789', 'IFSC : HDFC0001234',
  'Statement From : 01/09/2026 To : 10/09/2026', 'Date Narration Chq/Ref Withdrawal Deposit Closing Balance',
  '02/09/2026 UPI-SWIGGY 612300000001 250.00 1,950.00', '05/09/2026 IMPS-523456789012-FANTASYADDA 1,450.00 3,400.00',
  '07/09/2026 ATM WDL 1,000.00 2,400.00',
];

/** Same account, but the payout credit is missing. */
export const HDFC_STATEMENT_WITHOUT_CREDIT = HDFC_STATEMENT_WITH_CREDIT.filter((l) => !l.includes('FANTASYADDA'));

/** A different person's / account's statement. */
export const OTHER_ACCOUNT_STATEMENT = [
  'ICICI Bank', 'Statement of Account', 'Account Holder Name: PRIYA SINGH', 'Account Number : 000401234567', 'IFSC : ICIC0000004',
  'Statement Period: 01/09/2026 to 10/09/2026', 'Date Particulars Debit Credit Balance',
  '03/09/2026 NEFT CR SALARY 25,000.00 30,000.00', '06/09/2026 UPI DR AMAZON 1,200.00 28,800.00', '08/09/2026 ATM 2,000.00 26,800.00',
];
