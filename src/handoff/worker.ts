import type { Logger } from 'pino';
import { addressTerm, prefersBrief } from '../domain/memory.js';
import type { OutboxSender } from '../pipeline/outbox.js';
import type { ResponseComposer } from '../response/composer.js';
import type { Store } from '../storage/types.js';
import { ConflictError } from '../storage/types.js';
import type { KeyedMutex } from '../util/mutex.js';
import type { EvidenceExporter } from './exporter.js';
import type { HandoffService } from './service.js';

export interface WorkerOptions {
  store: Store;
  handoff: HandoffService;
  outbox: OutboxSender;
  locks: KeyedMutex;
  log: Logger;
  maxAttempts: number;
  idleCloseHours: number;
  clock?: () => Date;
  /** With an export bot: retry failed exports and finish their handoff. */
  exporter?: EvidenceExporter;
  composer?: ResponseComposer;
  exportRetryAfterMs?: number;
  maxExportAttempts?: number;
  /** While OFF, every background duty waits. */
  botSwitch?: { isOn(): Promise<boolean> };
}

/**
 * Background duties:
 *  - retry undelivered tickets; when one lands, THEN tell the customer it was forwarded
 *  - retry unsent outbox messages
 *  - retry failed exports; when one is verified, THEN confirm to the customer and hand off
 *  - close idle, non-escalated cases
 */
export class HandoffWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly o: WorkerOptions) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    if (this.o.botSwitch && !(await this.o.botSwitch.isOn())) return; // OFF: every background duty waits too
    this.running = true;
    try {
      await this.retryTickets();
      await this.retryExports();
      await this.o.outbox.flushPending();
      await this.closeIdle();
    } catch (err) {
      this.o.log.error({ err }, 'handoff worker tick failed');
    } finally {
      this.running = false;
    }
  }

  async retryTickets(): Promise<number> {
    const { store, handoff, locks, log } = this.o;
    if (!handoff.configured) return 0; // nowhere to deliver to; nothing to retry
    let delivered = 0;
    for (const t of await store.tickets.listUndelivered(this.o.maxAttempts)) {
      await locks.run(t.chatId, async () => {
        const fresh = await store.tickets.get(t.id);
        if (!fresh || fresh.status === 'delivered' || fresh.status === 'closed') return;
        const res = await handoff.deliver(fresh);
        if (!res.delivered) return;
        delivered++;
        const c = await store.cases.get(t.caseId);
        if (c && c.status !== 'closed') {
          try {
            await store.cases.save({ ...c, status: 'escalated', escalation: 'delivered' });
          } catch (err) {
            if (!(err instanceof ConflictError)) throw err;
          }
        }
        log.info({ ticket: t.id }, 'delayed handoff delivered (customer not notified by design)');
      });
    }
    return delivered;
  }

  /** A case whose export failed is still pending: send what is missing, then finish the handoff. */
  async retryExports(): Promise<number> {
    const { store, locks, log, exporter, composer } = this.o;
    if (!exporter || !composer) return 0;
    const now = this.o.clock?.() ?? new Date();
    const retryAfter = this.o.exportRetryAfterMs ?? 2 * 60_000;
    const maxAttempts = this.o.maxExportAttempts ?? 20;
    let exported = 0;
    for (const stale of await store.cases.listExportFailed()) {
      await locks.run(stale.chatId, async () => {
        const c = await store.cases.get(stale.id);
        const st = c?.facts.export;
        // 'failed', or a 'forwarding' left behind by a process that died mid-export.
        if (!c || !st || (st.status !== 'failed' && st.status !== 'forwarding') || c.status === 'closed' || !st.reason) return;
        if (st.attempts >= maxAttempts || now.getTime() - Date.parse(st.at) < retryAfter) return;
        const user = await store.users.get(c.userId);
        if (!user) return;
        const r = await exporter.export(c, user, st.reason);
        if (r.ok) {
          exported++;
          const reason = st.reason;
          c.facts.handoffReason = reason;
          c.facts.lastAsked = [];
          c.missing = [];
          if (c.facts.export!.status !== 'confirmed') {
            c.facts.export!.status = 'confirmed';
            const lang = user.preferredLanguage ?? 'hinglish';
            const composed = await composer.compose({ acts: [{ type: 'export_confirmed' }], language: lang, userText: '', history: [], address: addressTerm(user.memory), brief: prefersBrief(user.memory) });
            await this.o.outbox.send({ key: `export:${c.id}`, chatId: c.chatId, userId: c.userId, text: composed.text, meta: { kind: 'reply', html: true, caseId: c.id, caseType: c.type, acts: ['export_confirmed'] } });
          }
          c.status = 'escalated'; // the team has it through the export bot: no ticket
          log.info({ case: c.id, attempts: c.facts.export!.attempts }, 'delayed export delivered; customer confirmed');
        }
        try {
          await store.cases.save(c);
        } catch (err) {
          if (!(err instanceof ConflictError)) throw err;
        }
      });
    }
    return exported;
  }

  async closeIdle(): Promise<number> {
    const { store, locks } = this.o;
    const now = this.o.clock?.() ?? new Date();
    const before = new Date(now.getTime() - this.o.idleCloseHours * 3_600_000);
    let closed = 0;
    for (const c of await store.cases.listIdle(before)) {
      if (c.status === 'escalated') continue; // humans own it
      await locks.run(c.chatId, async () => {
        const fresh = await store.cases.get(c.id);
        if (!fresh || fresh.status === 'escalated' || fresh.lastActivityAt >= before) return;
        await store.cases.save({ ...fresh, status: 'closed' });
        const user = await store.users.get(fresh.userId);
        if (user?.focusCaseId === fresh.id) await store.users.setFocus(fresh.userId, undefined);
        closed++;
      });
    }
    return closed;
  }
}
