import { beforeEach, describe, expect, it } from 'vitest';
import { ScriptedLlm } from '../../src/llm/fake.js';
import type { InterpreterInput } from '../../src/nlu/context.js';
import { lexicalInterpret } from '../../src/nlu/lexical.js';
import { NO_CLAIMS } from '../../src/nlu/types.js';
import { analysisOf } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES } from '../helpers/fixtures.js';
import { Harness, MATCH_FOLDER } from '../helpers/harness.js';

/**
 * Chat monitoring for match problems: the chat is organised into the "Match issues" folder for the
 * human team, the customer gets no message, and the chat leaves the folder as soon as the customer
 * writes about something else or a human replies.
 */
let h: Harness;
beforeEach(() => {
  h = new Harness({ fixtures: ADMIN_FIXTURES });
});

describe('match issues are filed for manual review, silently', () => {
  it.each([
    ['mere points galat update hue hain', 'wrong_points'],
    ['match under review dikha raha hai', 'match_under_review'],
    ['points abhi tak update nahi hue', 'late_points'],
    ['lineup galat hai sir', 'lineup'],
    ['match extend kyu kiya', 'match_extension'],
    ['mera player missing hai team me', 'player_missing'],
    ['result galat declare hua', 'match_result'],
    ['kal wale match me problem hai', 'other_match'],
  ])('"%s" → filed in "Match issues", nothing sent, no case', async (text, category) => {
    const u = h.user(`m-${category}`);
    expect(await u.say(text)).toBe('');
    expect(h.transport.sent).toHaveLength(0); // no reply, and no ticket in the support group
    expect(h.inMatchFolder(u.id)).toBe(true);
    expect(await h.casesOf(u.id)).toHaveLength(0);
    expect(h.metrics.chatFolders.get({ folder: 'match', action: 'add', category, outcome: 'added' })).toBe(1);
  });

  it('a match screenshot with no text is filed too', async () => {
    h.vision.set('scorecard', analysisOf({ category: 'match_screenshot', confidence: 0.9, transcript: 'IND vs AUS\nYour points: 212\nRank 4,512' }));
    const u = h.user('shot');
    expect(await u.photo('scorecard')).toBe('');
    expect(h.inMatchFolder(u.id)).toBe(true);
  });

  it('keeps chats of different customers apart', async () => {
    await h.user('a').say('lineup galat hai sir');
    await h.user('b').say('hello');
    expect(h.folders.folders.get(MATCH_FOLDER)).toEqual(['a']);
  });
});

describe('while the team has not answered yet', () => {
  it('small talk gets no reply and leaves the chat where the team can see it', async () => {
    const u = h.user('next');
    await u.say('lineup galat hai sir');
    expect(await u.say('hello')).toBe('');
    expect(await u.say('kab tak hoga?')).toBe('');
    expect(await u.say('reply do please')).toBe('');
    expect(h.inMatchFolder(u.id)).toBe(true);
    expect(h.transport.sent).toHaveLength(0);
    expect(await h.casesOf(u.id)).toHaveLength(0);
  });

  it('a different support problem is handled and moves the chat to Support', async () => {
    const u = h.user('other');
    await u.say('points galat hai');
    expect(await u.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
    expect(h.inMatchFolder(u.id)).toBe(false);
    expect(h.folders.folders.has(MATCH_FOLDER)).toBe(false); // Telegram can't keep an empty folder
    expect(await u.say('hello')).toBe(''); // now a pending deposit case keeps greetings quiet
  });

  it('once a human has answered, the hold is over', async () => {
    const u = h.user('answered');
    await u.say('points galat hai');
    await h.app.relay.onOwnOutgoing({ chatId: u.id, messageId: 700, text: 'Sir, points 1 ghante me update ho jayenge.' });
    expect(h.inMatchFolder(u.id)).toBe(false);
    expect(await u.say('ok')).toBe(''); // the human has the chat
    await h.app.relay.onOwnOutgoing({ chatId: u.id, messageId: 701, text: '/ai' });
    expect(await u.say('hello')).toMatch(/Bataiye, kya help chahiye/); // the bot is back, and the day's greeting is spent
  });

  it('a new match complaint keeps it in', async () => {
    const u = h.user('again');
    await u.say('points galat hai');
    await u.say('aur lineup bhi galat tha');
    expect(h.inMatchFolder(u.id)).toBe(true);
    expect(h.folders.calls.filter((c) => c.op === 'remove')).toHaveLength(0); // never taken out and put back
  });

  it('a human replying from the account takes it out', async () => {
    const u = h.user('human');
    await u.say('result galat declare hua');
    await h.app.relay.onOwnOutgoing({ chatId: u.id });
    expect(h.inMatchFolder(u.id)).toBe(false);
  });

  it('a human reply relayed from the support group takes it out', async () => {
    const u = h.user('relay');
    await u.say('mujhe customer care se baat karni hai, mera KYC reject ho gaya bina reason ke');
    const ticketMsg = h.supportMessages[0]!;
    await u.say('aur mere points bhi galat update hue');
    expect(h.inMatchFolder(u.id)).toBe(true);

    await h.app.relay.onSupportMessage({ chatId: '-100999', messageId: 9001, fromUserId: 'agent1', text: 'Sir, points recheck ho rahe hain.', replyToMessageId: ticketMsg.messageId });
    expect(u.last).toBe('Sir, points recheck ho rahe hain.');
    expect(h.inMatchFolder(u.id)).toBe(false);
  });

  it('an internal note in the support group does not count as a reply', async () => {
    const u = h.user('note');
    await u.say('mujhe customer care se baat karni hai, mera KYC reject ho gaya bina reason ke');
    const ticketMsg = h.supportMessages[0]!;
    await u.say('points bhi galat hai');
    await h.app.relay.onSupportMessage({ chatId: '-100999', messageId: 9002, fromUserId: 'agent1', text: '/note checking scorecard', replyToMessageId: ticketMsg.messageId });
    expect(h.inMatchFolder(u.id)).toBe(true);
  });

  it('a customer message while a human has taken over still takes it out', async () => {
    const u = h.user('takeover');
    await u.say('player missing hai team me');
    await h.store.users.setHumanTakeover(u.id, new Date(h.clock().getTime() + 30 * 60_000));
    await u.say('reply do please');
    expect(h.inMatchFolder(u.id)).toBe(false);
  });

  it('a turn that fails still takes it out', async () => {
    let fail = false;
    const flaky = {
      async interpret(i: InterpreterInput) {
        if (fail) throw new Error('interpreter down');
        return lexicalInterpret(i);
      },
    };
    const hf = new Harness({ fixtures: ADMIN_FIXTURES, interpreter: flaky });
    const u = hf.user('flaky');
    await u.say('points galat hai');
    fail = true;
    await u.say('hello');
    expect(hf.inMatchFolder(u.id)).toBe(false);
  });

  it('survives a restart: the folder lives on Telegram, not in the process', async () => {
    const u = h.user('restart');
    await u.say('match under review hai');
    h.restart();
    await u.say('hello');
    expect(h.inMatchFolder(u.id)).toBe(true); // still the team's: the hold survives too (it lives with the customer)
    await u.say('deposit nahi aaya');
    expect(h.inMatchFolder(u.id)).toBe(false);
  });
});

describe('coming back into the folder', () => {
  it("a chat taken out by the customer's own different problem is filed again by a later match complaint", async () => {
    const u = h.user('back-customer');
    await u.say('points galat hai');
    await u.say('deposit nahi aaya');
    expect(h.inMatchFolder(u.id)).toBe(false);
    expect(await u.say('match under review hai')).toBe('');
    expect(h.inMatchFolder(u.id)).toBe(true);
    expect(h.metrics.chatFolders.get({ folder: 'match', action: 'add', category: 'match_under_review', outcome: 'added' })).toBe(1);
  });

  it('a chat taken out by a human reply is filed again, even while that human still has the chat', async () => {
    const u = h.user('back-human');
    await u.say('result galat declare hua');
    await h.app.relay.onOwnOutgoing({ chatId: u.id }); // human answers: out, and the bot pauses here
    expect(h.inMatchFolder(u.id)).toBe(false);
    const sent = h.transport.sent.length;
    await u.say('ab lineup bhi galat dikha raha hai');
    expect(h.inMatchFolder(u.id)).toBe(true);
    expect(h.transport.sent).toHaveLength(sent); // still no bot reply while the human handles it
  });

  it('a support-group reply does not stop the chat from being filed again', async () => {
    const u = h.user('back-relay');
    await u.say('mujhe customer care se baat karni hai, mera KYC reject ho gaya bina reason ke');
    const ticketMsg = h.supportMessages[0]!;
    await u.say('points bhi galat hai');
    await h.app.relay.onSupportMessage({ chatId: '-100999', messageId: 9003, fromUserId: 'agent1', text: 'Sir, check kar rahe hain.', replyToMessageId: ticketMsg.messageId });
    expect(h.inMatchFolder(u.id)).toBe(false);
    await u.say('player missing hai team me');
    expect(h.inMatchFolder(u.id)).toBe(true);
  });

  it('every message is judged on its own: in, out, in, out, in', async () => {
    const u = h.user('cycle');
    const steps: Array<[string, boolean]> = [
      ['points galat hai', true],
      ['deposit nahi aaya', false],
      ['player missing hai team me', true],
      ['withdrawal nahi aaya', false],
      ['points galat hai', true], // the very same complaint again still counts
    ];
    for (const [text, filed] of steps) {
      await u.say(text);
      expect(h.inMatchFolder(u.id), text).toBe(filed);
    }
  });

  it('recreates the folder when it had been deleted for being empty', async () => {
    const u = h.user('recreate');
    await u.say('points galat hai');
    await u.say('deposit nahi aaya');
    expect(h.folders.folders.has(MATCH_FOLDER)).toBe(false);
    await u.say('lineup galat hai sir');
    expect(h.folders.folders.get(MATCH_FOLDER)).toEqual([u.id]);
  });

  it('a match screenshot sent during a human takeover files the chat again', async () => {
    h.vision.set('scorecard', analysisOf({ category: 'match_screenshot', confidence: 0.9, transcript: 'IND vs AUS\nYour points: 212' }));
    const u = h.user('back-shot');
    await u.say('result galat declare hua');
    await h.app.relay.onOwnOutgoing({ chatId: u.id });
    await u.photo('scorecard');
    expect(h.inMatchFolder(u.id)).toBe(true);
  });

  it('works across a restart', async () => {
    const u = h.user('back-restart');
    await u.say('points galat hai');
    await u.say('hello');
    h.restart();
    await u.say('match extend kyu kiya');
    expect(h.inMatchFolder(u.id)).toBe(true);
  });
});

describe('alongside other work', () => {
  it('a deposit problem that also mentions a match is match-related: filed for the team, no reply, no case', async () => {
    const u = h.user('mixed');
    expect(await u.say('deposit nahi aaya aur points bhi galat hai')).toBe('');
    expect(h.inMatchFolder(u.id)).toBe(true);
    expect(await h.casesOf(u.id)).toHaveLength(0);
    // Said again without the match part, it is the bot's deposit issue.
    expect(await u.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
    expect(h.inMatchFolder(u.id)).toBe(false);
  });

  it('a match complaint in the middle of a deposit case leaves the case untouched', async () => {
    const u = h.user('midcase');
    await u.say('deposit nahi aaya');
    const before = await h.caseOf(u.id);
    expect(await u.say('lineup galat hai sir')).toBe('');
    expect(h.inMatchFolder(u.id)).toBe(true);
    const after = await h.caseOf(u.id);
    expect(after).toMatchObject({ id: before!.id, status: 'open', step: before!.step });
    expect(after?.facts.asks).toEqual(before?.facts.asks);
  });

  it('a Telegram folder failure never costs the customer a reply', async () => {
    const u = h.user('flood');
    h.folders.failNext = 5;
    expect(await u.say('deposit nahi aaya')).toMatch(/deposit check karne ke liye/);
  });

  it('the LLM catches match problems the keyword fallback cannot', async () => {
    const llm = new ScriptedLlm().on('interpret', () => ({
      intent: 'match_issue', case_type: null, relation: 'none', target_case_id: null, claims: { ...NO_CLAIMS },
      reference: { kind: 'none', index: null }, affirmation: 'none', language: 'hinglish', gist: 'Match start delayed',
      proposed: { registration_number: null, withdrawal_id: null, order_id: null, utr: null, amount: null },
      match_issue: { detected: true, category: 'match_extension' }, confidence: 0.9,
    }));
    const hl = new Harness({ fixtures: ADMIN_FIXTURES, llm });
    const u = hl.user('llm');
    expect(await u.say('bhai 7 baje wala khel abhi tak shuru kyu nahi hua')).toBe('');
    expect(hl.inMatchFolder(u.id)).toBe(true);
  });
});
