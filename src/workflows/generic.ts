import { absorb, asked, escalatedFollowup, evidenceNotices, frustrationPreamble, requestSlots } from './common.js';
import type { Workflow, WorkflowInput, WorkflowOutput } from './types.js';

const SCREEN_CATEGORIES = new Set(['technical_screenshot', 'account_screenshot', 'technical_recording']);

/**
 * Technical / account / other issues: there is no backend tool that can fix these, so the best
 * automation can do is understand the problem, collect one round of useful context, and hand a
 * clean case to humans. Also hosts the "deposit or withdrawal?" clarification step.
 */
export class GenericWorkflow implements Workflow {
  async run(inp: WorkflowInput): Promise<WorkflowOutput> {
    const { c } = inp;
    const absorbed = absorb(inp);
    if (c.status === 'escalated') return escalatedFollowup(inp, absorbed);
    const out: WorkflowOutput = { acts: frustrationPreamble(inp), meta: { caseId: c.id, caseType: c.type } };
    const pre = evidenceNotices(absorbed);

    if (c.type === 'other' && c.step === 'clarify_type') {
      out.acts.push(...pre);
      if (c.facts.claims.wantsHuman || asked(c, 'issue_description') >= 1 || c.facts.claims.refusesDocuments) {
        out.handoff = { reason: 'insufficient_evidence', note: 'Could not tell whether this is a deposit or withdrawal issue' };
        return out;
      }
      c.facts.asks.issue_description = 1;
      c.facts.lastAsked = ['issue_description'];
      out.acts.push({ type: 'clarify_issue_type' });
      return out;
    }

    const words = c.facts.description.join(' ').split(/\s+/).filter(Boolean).length;
    const hasScreen = inp.caseEvidence.some((e) => SCREEN_CATEGORIES.has(e.category));
    out.acts.push(...pre);

    if (c.facts.claims.wantsHuman) {
      // Give the team something to work with, but never block a user who insists.
      if (words < 6 && !hasScreen && asked(c, 'issue_description') === 0) {
        requestSlots(inp, out, absorbed, ['issue_description']);
        return out;
      }
      out.handoff = { reason: 'user_requested_human' };
      return out;
    }
    if (hasScreen || words >= 8 || asked(c, 'issue_description') >= 1 || c.facts.claims.refusesDocuments) {
      out.handoff = { reason: 'unsupported_issue', declined: c.facts.claims.refusesDocuments, note: `${c.type} issue` };
      return out;
    }
    requestSlots(inp, out, absorbed, ['issue_description', 'screenshot'], { initial: true });
    c.step = 'collecting';
    return out;
  }
}
