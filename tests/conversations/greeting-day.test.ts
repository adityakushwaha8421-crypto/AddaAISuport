import { beforeEach, describe, expect, it } from 'vitest';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { Harness } from '../helpers/harness.js';

/**
 * One greeting per customer per calendar day (their local day, Asia/Kolkata by default), on their
 * first message of the day only. Later hellos are answered, never re-welcomed; a pending case keeps
 * greetings silent altogether. The harness clock starts at 12:00 IST.
 */
const GREETING = 'Hello sir 👋 Kaise help karun?';
const NO_GREETING = 'Ji sir 😊 Bataiye, kya help chahiye?';

let h: Harness;
beforeEach(() => {
  h = new Harness({ adminGateway: new DisabledAdminGateway() });
});

describe('greeting only on the first message of the day', () => {
  it('a second and third hello the same day get an answer, not another welcome', async () => {
    const u = h.user('g1');
    expect(await u.say('hi')).toBe(GREETING);
    expect(await u.say('hello')).toBe(NO_GREETING);
    h.advance(6 * 60); // still the same day (18:00 IST)
    expect(await u.say('good morning sir')).toBe(''); // would be word for word the last reply: not sent again
    expect(await u.say('kaise ho')).toMatch(/Main theek hoon/);
  });

  it('any first message of the day uses up the greeting, even one without a hello in it', async () => {
    const u = h.user('g2');
    expect(await u.say('lineup kab aayega')).toBe(''); // a general question with no approved answer: silence, no case
    expect(await h.casesOf(u.id)).toHaveLength(0);
    expect(await u.say('hi')).toBe(NO_GREETING);
  });

  it('a new calendar day allows exactly one greeting again', async () => {
    const u = h.user('g3');
    expect(await u.say('hi')).toBe(GREETING);
    h.advance(13 * 60); // 01:00 IST the next day
    expect(await u.say('hi')).toBe(GREETING);
    expect(await u.say('hi')).toBe(NO_GREETING);
    h.advance(24 * 60);
    expect(await u.say('namaste')).toBe(GREETING);
  });

  it('the day boundary is the customer\'s midnight, not UTC', async () => {
    const u = h.user('g4');
    expect(await u.say('hi')).toBe(GREETING); // 12:00 IST = 06:30 UTC
    h.advance(11 * 60 + 40); // 23:40 IST, 18:10 UTC: a new UTC day would have started at 05:30 IST already
    expect(await u.say('hi')).toBe(NO_GREETING);
    h.advance(30); // 00:10 IST
    expect(await u.say('hi')).toBe(GREETING);
  });

  it('with a case pending, a greeting gets nothing at all, first of the day or not', async () => {
    const u = h.user('g5');
    expect(await u.say('deposit nahi hua')).toMatch(/deposit check karne ke liye/);
    expect(await u.say('hi')).toBe('');
    h.advance(24 * 60);
    expect(await u.say('hello sir')).toBe('');
    expect((await h.caseOf(u.id))?.facts.asks.registration_number).toBe(1);
  });
});
