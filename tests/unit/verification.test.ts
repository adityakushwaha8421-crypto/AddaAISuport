import { describe, expect, it } from 'vitest';
import type { DepositOrder, PayoutDetails } from '../../src/domain/admin.js';
import { bestAccountMatch, compareAccount, compareName } from '../../src/verification/accountMatch.js';
import { matchDeposit } from '../../src/verification/depositMatch.js';
import { checkStatementAgainstPayout, findTransaction, isSameAccount } from '../../src/verification/statementCheck.js';
import { parseStatement } from '../../src/evidence/statement.js';

describe('account matching', () => {
  it.each([
    ['123456789012', '123456789012', 'match'],
    ['00123456789012', '123456789012', 'match'],
    ['123456789012', 'XXXXXXXX9012', 'partial'],
    ['123456789012', 'XXXXXX789012', 'match'],
    ['XXXXXXXX9012', '****9012', 'partial'],
    ['123456789012', '123456781111', 'mismatch'],
    ['123456789012', 'XXXXXXXX1111', 'mismatch'],
    ['123456789012', 'XX12', 'unknown'],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(compareAccount(a, b)).toBe(expected);
  });

  it('takes the best match across all accounts on a statement', () => {
    expect(bestAccountMatch('123456789012', ['55554444', 'XXXX9012'])).toBe('partial');
    expect(bestAccountMatch(undefined, ['1234'])).toBe('unknown');
  });

  it('compares holder names loosely', () => {
    expect(compareName('RAHUL KUMAR SHARMA', 'Mr. Rahul Kumar')).toBe('match');
    expect(compareName('RAHUL KUMAR', 'PRIYA SINGH')).toBe('mismatch');
  });

  it('decides same-account with corroboration for masked numbers', () => {
    expect(isSameAccount({ account: 'partial', bank: 'unknown', ifsc: 'match', name: 'unknown' })).toBe(true);
    expect(isSameAccount({ account: 'partial', bank: 'unknown', ifsc: 'unknown', name: 'unknown' })).toBeUndefined();
    expect(isSameAccount({ account: 'partial', bank: 'mismatch', ifsc: 'unknown', name: 'match' })).toBe(false);
    expect(isSameAccount({ account: 'mismatch', bank: 'match', ifsc: 'match', name: 'match' })).toBe(false);
  });
});

const STATEMENT = [
  'State Bank of India',
  'Account Statement',
  'Account Name : Mr. RAHUL KUMAR',
  'Account Number : 00000123456789012',
  'IFSC Code : SBIN0001234',
  'Statement Period: 01/09/2026 to 10/09/2026',
  'Txn Date  Description  Debit  Credit  Balance',
  '02/09/2026  UPI/DR/612345678901/FANTASY  500.00    1,200.00',
  '05/09/2026  IMPS/CR/523456789012/FANTASYADDA    1,450.00  2,650.00',
  '07/09/2026  ATM WDL  1,000.00    1,650.00',
];

describe('bank statement parsing & transaction search', () => {
  const st = parseStatement(STATEMENT);

  it('extracts header facts', () => {
    expect(st.accountNumbers).toContain('00000123456789012');
    expect(st.ifsc).toBe('SBIN0001234');
    expect(st.bankName).toBe('State Bank of India');
    expect(st.holderName).toMatch(/RAHUL KUMAR/);
    expect(st.periodFrom).toBe('2026-09-01');
    expect(st.periodTo).toBe('2026-09-10');
    expect(st.lines).toHaveLength(3);
  });

  it('finds a transaction by UTR, then amount+date, never by amount alone', () => {
    expect(findTransaction(st.lines, { utr: '523456789012' })).toMatchObject({ found: true, quality: 'utr', date: '2026-09-05' });
    expect(findTransaction(st.lines, { amount: 1450, date: '2026-09-04' })).toMatchObject({ found: true, quality: 'amount_and_date' });
    expect(findTransaction(st.lines, { amount: 1450, date: '2026-08-20' })).toMatchObject({ found: false, quality: 'amount_only' });
    expect(findTransaction(st.lines, { amount: 999, date: '2026-09-05' })).toMatchObject({ found: false, quality: 'none' });
  });

  it('verifies a statement against the payout destination', () => {
    const payout: PayoutDetails = {
      withdrawalId: 'WD-1', amount: 1450, status: 'SUCCESS', accountNumber: '123456789012', ifsc: 'SBIN0001234',
      bankName: 'SBI', beneficiaryName: 'Rahul Kumar', utr: '523456789012', processedAt: '2026-09-05T10:00:00Z',
    };
    const check = checkStatementAgainstPayout('ev1', payout, st);
    expect(check).toMatchObject({ account: 'match', ifsc: 'match', bank: 'match', name: 'match', coversPayoutDate: true });
    expect(check.transaction).toMatchObject({ found: true, quality: 'utr' });
    expect(isSameAccount(check)).toBe(true);

    const wrong = checkStatementAgainstPayout('ev1', { ...payout, accountNumber: '999988887777', ifsc: 'HDFC0000001', bankName: 'HDFC Bank' }, st);
    expect(wrong.account).toBe('mismatch');
    expect(isSameAccount(wrong)).toBe(false);
  });
});

describe('deposit matching', () => {
  const orders: DepositOrder[] = [
    { orderId: 'ORD1', amount: 500, status: 'SUCCESS', utr: '612345678901', createdAt: '2026-09-02T09:00:00Z' },
    { orderId: 'ORD2', amount: 500, status: 'PENDING', createdAt: '2026-09-08T09:00:00Z' },
    { orderId: 'ORD3', amount: 750, status: 'FAILED', createdAt: '2026-09-09T09:00:00Z' },
  ];
  it('matches exactly by UTR', () => {
    expect(matchDeposit({ utr: '612345678901' }, orders)).toMatchObject({ quality: 'exact_utr', order: { orderId: 'ORD1' } });
  });
  it('matches by amount and time window', () => {
    expect(matchDeposit({ amount: 500, when: '2026-09-08T10:30:00Z' }, orders)).toMatchObject({ quality: 'amount_and_time', order: { orderId: 'ORD2' } });
  });
  it('accepts a unique amount but flags duplicates as ambiguous', () => {
    expect(matchDeposit({ amount: 750 }, orders)).toMatchObject({ quality: 'amount_only', order: { orderId: 'ORD3' } });
    expect(matchDeposit({ amount: 500 }, orders).quality).toBe('ambiguous');
    expect(matchDeposit({ amount: 123 }, orders).quality).toBe('none');
  });
  it('handles no details and no orders', () => {
    expect(matchDeposit({}, [orders[0]!])).toMatchObject({ quality: 'single_recent' });
    expect(matchDeposit({}, orders).quality).toBe('ambiguous');
    expect(matchDeposit({ amount: 5 }, []).quality).toBe('none');
  });
});
