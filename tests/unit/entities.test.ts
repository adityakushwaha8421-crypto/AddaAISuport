import { describe, expect, it } from 'vitest';
import { bestEntities, compilePatterns, extractEntities } from '../../src/nlu/entities.js';

const NOW = new Date('2026-09-11T10:00:00Z');
const ex = (t: string) => extractEntities(t, { now: NOW });

describe('registration number extraction', () => {
  it.each([
    ['number dusra hai 9810822372', '9810822372'],
    ['mera registered number 9876543210 hai', '9876543210'],
    ['9810822372', '9810822372'],
    ['+91 98108 22372 pe account hai', '9810822372'],
    ['reg no: 98108-22372', '9810822372'],
    ['mobile no.९८१०८२२३७२', '9810822372'],
  ])('%s → %s', (text, expected) => {
    expect(bestEntities(ex(text)).registrationNumber?.value).toBe(expected);
  });

  it('does not treat numbers starting 0-5 or longer runs as mobile numbers', () => {
    expect(ex('amount 5123456789').registrationNumbers).toHaveLength(0);
    expect(ex('12345678901234').registrationNumbers).toHaveLength(0);
  });

  it('prefers account-number interpretation when labelled a/c', () => {
    const e = ex('a/c no 9876543210 pe paisa bheja');
    expect(e.accountNumbers[0]?.value).toBe('9876543210');
    expect(e.registrationNumbers).toHaveLength(0);
  });

  it('supports custom registration patterns', () => {
    const patterns = compilePatterns({ registration: '\\bFA\\d{6}\\b', withdrawalId: '\\bWD-\\d+\\b', orderId: '\\bORD\\d+\\b' });
    expect(extractEntities('user id FA123456', { patterns }).registrationNumbers[0]?.value).toBe('FA123456');
  });
});

describe('withdrawal / order id extraction', () => {
  it.each([
    ['mera withdrawal id WD-15436-64215 hai sir', 'WD-15436-64215'],
    ['wd-15436-64215 check karo', 'WD-15436-64215'],
    ['withdrawal id: 88213345 pending hai', '88213345'],
    ['payout no - WDX9912 status?', 'WDX9912'],
  ])('%s → %s', (text, expected) => {
    expect(bestEntities(ex(text)).withdrawalId?.value).toBe(expected);
  });

  it('extracts order ids but not words that merely start with a prefix', () => {
    expect(ex('order id ORD99812 ka paisa').orderIds[0]?.value).toBe('ORD99812');
    expect(ex('fantasy adda deposit nahi aaya').orderIds).toHaveLength(0);
    expect(ex('order is late').orderIds).toHaveLength(0);
  });
});

describe('UTR, amount, date, IFSC', () => {
  it('extracts labelled and bare UTRs', () => {
    expect(ex('UTR: 412345678901').utrs[0]).toMatchObject({ value: '412345678901', confidence: 0.95 });
    expect(ex('ref no. 523456789012 hai').utrs[0]?.value).toBe('523456789012');
    expect(ex('payment 612345678901 se kiya').utrs[0]).toMatchObject({ value: '612345678901', confidence: 0.65 });
  });

  it.each([
    ['₹500 deposit kiya', 500],
    ['Rs. 1,250.50 kata', 1250.5],
    ['2000 rs nahi aaya', 2000],
    ['500/- add kiya tha', 500],
    ['300 ka deposit fail', 300],
  ])('%s → %d', (text, amount) => {
    expect(bestEntities(ex(text)).amount?.value).toBe(amount);
  });

  it('does not read a registration number as an amount', () => {
    const e = ex('9810822372 pe 500 rs dala');
    expect(e.amounts.map((a) => a.value)).toEqual([500]);
    expect(e.registrationNumbers[0]?.value).toBe('9810822372');
  });

  it.each([
    ['12/08/2026 ko payment kiya', '2026-08-12'],
    ['on 3 Sep 2026', '2026-09-03'],
    ['Sep 3, 2026 10:22 PM', '2026-09-03'],
    ['2026-09-01', '2026-09-01'],
    ['aaj deposit kiya', '2026-09-11'],
    ['kal withdrawal kiya', '2026-09-10'],
  ])('%s → %s', (text, iso) => {
    expect(bestEntities(ex(text)).date?.value).toBe(iso);
  });

  it('extracts IFSC codes', () => {
    expect(ex('ifsc sbin0001234').ifscs[0]?.value).toBe('SBIN0001234');
  });
});
