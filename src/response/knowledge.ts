import { readFile } from 'node:fs/promises';
import { lexicalForm } from '../nlu/normalize.js';

export interface KnowledgeEntry {
  id: string;
  /** Words/phrases (any language) that indicate this topic. */
  keywords: string[];
  /** Approved answer text. Only business-approved facts belong here. */
  answer: string;
}

/**
 * Operator-maintained answers for general questions. The bot never invents policies; if nothing
 * here matches, it answers without facts (or offers help with support issues).
 */
export class KnowledgeBase {
  constructor(private readonly entries: KnowledgeEntry[] = []) {}

  static async fromFile(path: string): Promise<KnowledgeBase> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as { entries?: KnowledgeEntry[] };
      return new KnowledgeBase(raw.entries ?? []);
    } catch {
      return new KnowledgeBase([]);
    }
  }

  search(query: string, limit = 2): KnowledgeEntry[] {
    const q = ` ${lexicalForm(query)} `;
    return this.entries
      .map((e) => ({ e, score: e.keywords.reduce((s, k) => s + (q.includes(` ${lexicalForm(k)} `) || q.includes(lexicalForm(k)) ? k.length : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.e);
  }
}
