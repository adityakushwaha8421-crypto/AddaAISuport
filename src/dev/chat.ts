/**
 * Talk to the full agent from your terminal — no Telegram needed.
 *   npm run dev:chat
 * Uses the in-memory store, ADMIN_MODE (fixture by default) and OpenAI when OPENAI_API_KEY is set.
 *
 * Commands:  /photo <path> [caption]   /pdf <path> [caption]   /reply <botMsgNo> <text>
 *            /support (show support-group posts)   /case (dump focused case)   /quit
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline';
import { DisabledAdminGateway, FixtureAdminGateway } from '../admin/fixture.js';
import { assemble } from '../app.js';
import { loadEnv } from '../config/env.js';
import type { InboundMessage, MediaRef } from '../domain/messages.js';
import { NoFrameExtractor } from '../evidence/video.js';
import { LlmVisionAnalyzer } from '../evidence/vision.js';
import { DisabledLlm } from '../llm/client.js';
import { OpenAiLlm } from '../llm/openai.js';
import { DEFAULT_PATTERNS } from '../nlu/entities.js';
import { silentLogger } from '../observability/logger.js';
import { loadStyleGuide } from '../response/composer.js';
import { KnowledgeBase } from '../response/knowledge.js';
import { MemoryStore } from '../storage/memory.js';
import type { SendOptions, Transport } from '../telegram/transport.js';

const SUPPORT = 'support-group';
const USER = 'dev-user';

class ConsoleTransport implements Transport {
  readonly files = new Map<string, Buffer>();
  readonly support: string[] = [];
  readonly botMessages: number[] = [];
  private id = 0;
  next() {
    return ++this.id;
  }
  async start() {}
  async stop() {}
  healthy() {
    return true;
  }
  async sendText(chatId: string, text: string, _o?: SendOptions) {
    const messageId = this.next();
    if (chatId === SUPPORT) this.support.push(text);
    else {
      this.botMessages.push(messageId);
      console.log(`\n\x1b[36mbot [#${this.botMessages.length}]\x1b[0m ${text}\n`);
    }
    return { messageId };
  }
  async forwardMessage() {
    return { messageId: this.next() };
  }
  async downloadMedia(ref: MediaRef) {
    return this.files.get(ref.fileRef)!;
  }
  async sendTyping() {}
  async messagesExist(_chatId: string, ids: number[]) {
    return ids;
  }
}

async function main() {
  const env = loadEnv(process.env, []);
  const transport = new ConsoleTransport();
  const llm = env.OPENAI_API_KEY
    ? new OpenAiLlm({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, model: env.OPENAI_MODEL, visionModel: env.OPENAI_VISION_MODEL, timeoutMs: env.OPENAI_TIMEOUT_MS, log: silentLogger })
    : new DisabledLlm();
  const store = new MemoryStore();
  const admin = env.ADMIN_MODE === 'disabled' || env.ADMIN_MODE === 'fixture'
    ? await FixtureAdminGateway.fromFile(env.ADMIN_FIXTURE_FILE).catch(() => new DisabledAdminGateway())
    : new DisabledAdminGateway();
  const app = assemble(
    {
      store, transport, llm, vision: new LlmVisionAnalyzer(llm), frames: new NoFrameExtractor(), admin, patterns: DEFAULT_PATTERNS,
      style: await loadStyleGuide(env.STYLE_GUIDE_FILE), knowledge: await KnowledgeBase.fromFile(env.KNOWLEDGE_FILE), log: silentLogger,
    },
    {
      supportChatId: SUPPORT, historyMessages: 20, reopenWindowHours: 48,
      workflow: { maxAsksPerSlot: 2, withdrawalSlaHours: 24, depositLookbackDays: 3650, refreshMinutes: 10, maxPasswordAttempts: 3 },
      debounceMs: 0, maxWaitMs: 0, maxConcurrentTurns: 1, responseMode: env.RESPONSE_MODE, takeoverMinutes: 60, handoffMaxAttempts: 10,
      idleCloseHours: 48, admin: { timeoutMs: 30_000, cacheTtlMs: 60_000, retries: 0, breakerThreshold: 5, breakerCooldownMs: 30_000 },
    },
  );

  console.log(`FA support agent — terminal chat (${llm.available ? 'OpenAI' : 'offline: lexical + templates'}, admin: ${admin.name}). /quit to exit.\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const prompt = () => process.stdout.write('\x1b[33myou>\x1b[0m ');
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!process.stdin.isTTY) console.log(line);
    if (!line) {
      prompt();
      continue;
    }
    if (line === '/quit') break;
    if (line === '/support') {
      console.log(transport.support.join('\n\n---\n\n') || '(no support posts)');
      prompt();
      continue;
    }
    if (line === '/case') {
      const u = await store.users.get(USER);
      console.dir(u?.focusCaseId ? await store.cases.get(u.focusCaseId) : undefined, { depth: 5 });
      prompt();
      continue;
    }
    const msg: InboundMessage = { chatId: USER, userId: USER, messageId: transport.next(), date: new Date(), media: [], sender: { firstName: 'Dev' } };
    const [cmd, arg, ...rest] = line.split(' ');
    if (cmd === '/photo' || cmd === '/pdf') {
      const data = await readFile(arg!);
      const ref = `file-${msg.messageId}`;
      transport.files.set(ref, data);
      const ext = extname(arg!).toLowerCase();
      msg.media = [cmd === '/pdf'
        ? { kind: 'document', fileRef: ref, fileUniqueId: ref, mimeType: 'application/pdf', fileName: basename(arg!) }
        : { kind: 'photo', fileRef: ref, fileUniqueId: ref, mimeType: ext === '.png' ? 'image/png' : 'image/jpeg' }];
      msg.caption = rest.join(' ') || undefined;
    } else if (cmd === '/reply') {
      const target = transport.botMessages[Number(arg) - 1];
      msg.replyTo = target ? { messageId: target, media: [], fromSelf: true } : undefined;
      msg.text = rest.join(' ');
    } else {
      msg.text = line;
    }
    if (await app.processor.receive(msg)) await app.processor.process(USER, [msg]);
    prompt();
  }
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
