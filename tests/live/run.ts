/**
 * Live self-test: plays realistic conversations through the full agent with the REAL model
 * (OPENAI_MODEL reads every message and phrases replies, as in production — this costs tokens) and
 * prints each reply the way Telegram renders it, next to what the bot decided on that turn.
 *
 *   npm run test:live             all scenarios
 *   npm run test:live -- deposit  only scenarios whose title contains "deposit"
 *   npm run test:live -- --raw    also print the Telegram HTML
 *
 * Telegram delivery, screenshots (vision) and the admin panel are simulated; PDFs are parsed for real.
 */
import 'dotenv/config';
import { Writable } from 'node:stream';
import pino from 'pino';
import { DisabledAdminGateway } from '../../src/admin/fixture.js';
import { loadEnv } from '../../src/config/env.js';
import { OpenAiLlm } from '../../src/llm/openai.js';
import { analysisOf, SCREENSHOTS } from '../helpers/fakeVision.js';
import { ADMIN_FIXTURES, HDFC_STATEMENT_WITH_CREDIT, HDFC_STATEMENT_WITHOUT_CREDIT } from '../helpers/fixtures.js';
import { Harness, type UserSim } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdfFactory.js';

type Step = string | { photo: keyof typeof IMAGES; caption?: string } | { pdf: string[]; name?: string } | { video: true };
interface Scenario {
  title: string;
  admin: 'panel' | 'disabled';
  steps: Step[];
}

const IMAGES = {
  pay500: SCREENSHOTS.payment500,
  pay1000: analysisOf({
    category: 'payment_screenshot',
    transcript: 'Google Pay\nPayment successful\n₹1,000\nTo Fantasy Adda\n10 Sep 2026, 6:02 PM\nUPI transaction ID 698765432101',
    payment: { amount: 1000, amount_confidence: 0.95, date: '2026-09-10', time: '18:02', utr: '698765432101', utr_confidence: 0.95, status: 'success', app: 'Google Pay' } as never,
  }),
  withdrawalHistory: SCREENSHOTS.withdrawalHistory,
  selfie: SCREENSHOTS.selfie,
};

const SCENARIOS: Scenario[] = [
  { title: 'Greeting and small talk', admin: 'panel', steps: ['hi', 'kaise ho aap', 'ok thanks'] },
  { title: 'Deposit — success (admin panel connected)', admin: 'panel', steps: ['sir maine 500 add kiye the wallet me nahi aaye', { photo: 'pay500' }, '9810822372'] },
  { title: 'Deposit — pending order', admin: 'panel', steps: ['deposit nahi aaya 1000 ka', '9810822372', { photo: 'pay1000' }] },
  { title: 'Deposit — live setup (admin panel disabled): collect all four, export, confirm', admin: 'disabled', steps: ['deposit nahi aaya', 'hi', '9810822372', { photo: 'pay500' }, 'kya hua sir?', { pdf: HDFC_STATEMENT_WITHOUT_CREDIT }, { video: true }, 'ok thanks'] },
  { title: 'Withdrawal — success, then "not received"', admin: 'panel', steps: ['withdrawal nahi aaya', 'WD-15436-64215', 'bank me nahi aaya sir', { pdf: HDFC_STATEMENT_WITHOUT_CREDIT }] },
  { title: 'Withdrawal — credit found in statement', admin: 'panel', steps: ['WD-15436-64215 ka paisa bank me nahi dikha', { pdf: HDFC_STATEMENT_WITH_CREDIT }] },
  { title: 'Withdrawal — pick a row from history screenshot', admin: 'panel', steps: ['mera withdrawal pending hai', { photo: 'withdrawalHistory' }, 'upar wala'] },
  { title: 'Withdrawal — processing, then failed', admin: 'panel', steps: ['WD-15436-61002 ka status batao', 'aur WD-15436-59990 bhi fail dikha raha hai'] },
  { title: 'Deposit — English customer', admin: 'panel', steps: ['Hi, I deposited 500 rupees but it is not showing in my wallet', '9810822372', { photo: 'pay500' }] },
  { title: 'Withdrawal — what to send, wrong file, match issue in between', admin: 'panel', steps: ['withdrawal ka issue hai', 'kya bhejna hai?', { photo: 'selfie' }, 'mere points galat update hue', 'WD-20001-11111'] },
  { title: 'Withdrawal — frustrated customer', admin: 'panel', steps: ['kitni baar bolu withdrawal ka paisa nahi aaya', 'WD-15436-59990'] },
  { title: 'Withdrawal — live setup (admin panel disabled): ID, statement, export', admin: 'disabled', steps: ['withdrawal nahi aaya', 'WD-15436-64215', 'abhi tak nahi aaya', { pdf: HDFC_STATEMENT_WITHOUT_CREDIT }] },
];

const args = process.argv.slice(2);
const RAW = args.includes('--raw');
const filter = args.filter((a) => !a.startsWith('--')).join(' ').toLowerCase();

const C = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m', mag: '\x1b[35m' };

/** Telegram HTML → terminal: bold, italic, monospace. */
const render = (html: string) =>
  html
    .replace(/<b>(.*?)<\/b>/gs, `${C.bold}$1${C.reset}`)
    .replace(/<i>(.*?)<\/i>/gs, '\x1b[3m$1\x1b[23m')
    .replace(/<code>(.*?)<\/code>/gs, `${C.cyan}$1${C.reset}`)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const label = (s: Step) => (typeof s === 'string' ? s : 'photo' in s ? `[photo: ${s.photo}]${s.caption ? ` ${s.caption}` : ''}` : 'video' in s ? '[video: screen recording]' : `[pdf: ${s.name ?? 'statement.pdf'}]`);

function send(u: UserSim, s: Step) {
  if (typeof s === 'string') return u.say(s);
  if ('photo' in s) return u.photo(s.photo, s.caption);
  if ('video' in s) return u.video();
  return u.pdf(buildPdf(s.pdf), s.name);
}

const sum = (m: Map<string, number>, needle: string) => [...m.entries()].filter(([k]) => k.includes(needle)).reduce((a, [, v]) => a + v, 0);

async function main() {
  const env = loadEnv(process.env, []);
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set: the live self-test needs the real model');
  const events: Array<Record<string, unknown>> = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n')) if (line.trim()) try { events.push(JSON.parse(line)); } catch { /* not JSON */ }
      cb();
    },
  });
  const log = pino({ level: 'info' }, sink);
  const llm = new OpenAiLlm({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, model: env.OPENAI_MODEL, visionModel: env.OPENAI_VISION_MODEL, reasoningEffort: env.OPENAI_REASONING_EFFORT, timeoutMs: env.OPENAI_TIMEOUT_MS, log });

  const chosen = SCENARIOS.filter((s) => !filter || s.title.toLowerCase().includes(filter));
  console.log(`${C.bold}Live self-test${C.reset} — model ${env.OPENAI_MODEL}, ${chosen.length} conversations\n`);
  let problems = 0;

  for (const sc of chosen) {
    const h = new Harness({
      fixtures: ADMIN_FIXTURES, llm, log, responseMode: 'llm',
      adminGateway: sc.admin === 'disabled' ? new DisabledAdminGateway() : undefined,
    });
    for (const [k, v] of Object.entries(IMAGES)) h.vision.set(k, v);
    const u = h.user(`live-${sc.title}`);
    console.log(`${C.mag}${C.bold}━━ ${sc.title}${C.reset}  ${C.dim}(admin: ${sc.admin})${C.reset}`);

    for (const step of sc.steps) {
      const from = events.length;
      const composeBefore = sum(llm['opts'].metrics?.llmCalls.values ?? new Map(), 'compose');
      const repliesBefore = u.replies.length;
      const supportBefore = h.supportMessages.length;
      const exportsBefore = h.exportedFiles.length;
      const started = Date.now();
      await send(u, step);
      const ms = Date.now() - started;

      console.log(`${C.yellow}👤 ${label(step)}${C.reset}`);
      const newReplies = u.replies.slice(repliesBefore);
      if (!newReplies.length) console.log(`${C.dim}🤖 (no reply)${C.reset}`);
      for (const r of newReplies) {
        console.log(`${C.green}🤖${C.reset} ${render(r.text).split('\n').join('\n   ')}`);
        if (RAW) console.log(`${C.dim}   html: ${JSON.stringify(r.text)}${C.reset}`);
      }

      const turn = events.slice(from).find((e) => e.msg === 'turn processed' || String(e.msg ?? '').startsWith('turn skipped') || String(e.msg ?? '').startsWith('match issue'));
      const rejected = events.slice(from).filter((e) => String(e.msg).includes('rejected by guard'));
      const warns = events.slice(from).filter((e) => (e.level as number) >= 40 && !String(e.msg).includes('rejected by guard'));
      const folder = h.folderOf(u.id);
      const support = h.supportMessages.length - supportBefore;
      const exported = h.exportedFiles.length - exportsBefore;
      const bits = [
        turn ? `intent=${turn.intent ?? (String(turn.msg).startsWith('match issue') ? `match_issue(${turn.category})` : '?')}${turn.interpreter ? `/${turn.interpreter}` : ''}` : 'intent=?',
        turn?.acts ? `acts=${(turn.acts as string[]).join(',') || '-'}` : undefined,
        turn?.case ? `case=${turn.case}` : undefined,
        rejected.length ? `${C.red}guard rejected: ${rejected.map((e) => e.reason).join('; ')}${C.dim}` : undefined,
        `folder=${folder}`,
        support ? `support-group +${support}` : undefined,
        exported ? `${C.green}export-bot +${exported} forwards${C.dim}` : undefined,
        `${ms}ms`,
      ].filter(Boolean);
      console.log(`${C.dim}   ↳ ${bits.join('  ')}${C.reset}`);
      for (const w of warns) {
        problems++;
        console.log(`${C.red}   ⚠ ${w.msg}${w.err ? `: ${(w.err as { message?: string }).message}` : ''}${C.reset}`);
      }
      void composeBefore;
    }
    console.log('');
  }
  console.log(problems ? `${C.red}${problems} warning(s) logged${C.reset}` : `${C.green}No warnings logged${C.reset}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
