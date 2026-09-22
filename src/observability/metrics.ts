/** Minimal Prometheus-compatible metrics registry (no external dependency). */

type Labels = Record<string, string | number | boolean | undefined>;

const key = (labels: Labels): string =>
  Object.entries(labels)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`)
    .join(',');

class Counter {
  readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
}

class Histogram {
  readonly buckets = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
  readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string) {}
  observe(ms: number, labels: Labels = {}): void {
    const k = key(labels);
    const s = this.series.get(k) ?? { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => {
      if (ms <= b) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += ms;
    s.count += 1;
    this.series.set(k, s);
  }
}

class Gauge {
  readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  set(value: number, labels: Labels = {}): void {
    this.values.set(key(labels), value);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
}

export class Metrics {
  readonly inboundMessages = new Counter('fa_inbound_messages_total', 'Inbound Telegram messages');
  readonly duplicateMessages = new Counter('fa_duplicate_messages_total', 'Inbound messages dropped as duplicates');
  readonly turns = new Counter('fa_turns_total', 'Processed turns by outcome');
  readonly replies = new Counter('fa_replies_total', 'Replies sent');
  readonly llmCalls = new Counter('fa_llm_calls_total', 'LLM calls by purpose and outcome');
  readonly adminCalls = new Counter('fa_admin_calls_total', 'Admin gateway calls by op and outcome');
  readonly handoffs = new Counter('fa_handoffs_total', 'Handoffs by reason and delivery outcome');
  readonly exports = new Counter('fa_exports_total', 'Evidence exports to the export bot by case type and outcome');
  readonly evidence = new Counter('fa_evidence_total', 'Evidence items by category');
  readonly guardRejections = new Counter('fa_response_guard_rejections_total', 'LLM responses rejected by the guard');
  readonly chatFolders = new Counter('fa_chat_folder_total', 'Chat folder changes by folder, action, category/reason and outcome');
  readonly jobs = new Counter('fa_jobs_total', 'Queue jobs by type and outcome');
  readonly queueDepth = new Gauge('fa_queue_jobs', 'Jobs in the queue by status');
  readonly jobLatency = new Histogram('fa_job_latency_ms', 'Job execution latency');
  readonly turnLatency = new Histogram('fa_turn_latency_ms', 'Turn processing latency');
  readonly llmLatency = new Histogram('fa_llm_latency_ms', 'LLM call latency');
  readonly adminLatency = new Histogram('fa_admin_latency_ms', 'Admin call latency');

  render(): string {
    const lines: string[] = [];
    for (const m of Object.values(this)) {
      if (m instanceof Counter) {
        lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} counter`);
        for (const [k, v] of m.values) lines.push(`${m.name}${k ? `{${k}}` : ''} ${v}`);
      } else if (m instanceof Gauge) {
        lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} gauge`);
        for (const [k, v] of m.values) lines.push(`${m.name}${k ? `{${k}}` : ''} ${v}`);
      } else if (m instanceof Histogram) {
        lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} histogram`);
        for (const [k, s] of m.series) {
          const sep = k ? ',' : '';
          m.buckets.forEach((b, i) => lines.push(`${m.name}_bucket{${k}${sep}le="${b}"} ${s.counts[i]}`));
          lines.push(`${m.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`);
          lines.push(`${m.name}_sum${k ? `{${k}}` : ''} ${s.sum}`, `${m.name}_count${k ? `{${k}}` : ''} ${s.count}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }
}
