import type { CaseRecord } from '../domain/cases.js';
import type { Store, UserRecord } from '../storage/types.js';
import type { RouteDecision } from './router.js';

export interface AppliedRoute {
  case?: CaseRecord;
  isNew: boolean;
  resumed: boolean;
  paused: CaseRecord[];
}

/**
 * Applies routing decisions to persistent state: creates cases, pauses the previously focused
 * case on a topic switch, resumes paused cases, and tracks the user's focus.
 * One user can hold several cases; only one is focused at a time.
 */
export class CaseService {
  constructor(private readonly store: Store) {}

  async load(user: UserRecord): Promise<{ cases: CaseRecord[]; focused?: CaseRecord }> {
    const cases = await this.store.cases.listActive(user.id);
    const focused = user.focusCaseId ? cases.find((c) => c.id === user.focusCaseId) : undefined;
    return { cases, focused };
  }

  async apply(user: UserRecord, focused: CaseRecord | undefined, d: RouteDecision, now: Date): Promise<AppliedRoute> {
    const paused: CaseRecord[] = [];
    const pauseFocused = async (except?: string) => {
      if (focused && focused.id !== except && focused.status === 'open') {
        paused.push(await this.store.cases.save({ ...focused, status: 'paused' }));
      }
    };

    if (d.kind === 'none') {
      if (d.unfocus) {
        await pauseFocused();
        await this.store.users.setFocus(user.id, undefined);
      }
      return { isNew: false, resumed: false, paused };
    }

    if (d.kind === 'create') {
      await pauseFocused();
      const c = await this.store.cases.create({ userId: user.id, chatId: user.chatId, type: d.type, step: d.step, status: 'open' });
      await this.store.users.setFocus(user.id, c.id);
      return { case: c, isNew: true, resumed: false, paused };
    }

    const target = { ...d.target };
    await pauseFocused(target.id);
    const resumed = target.id !== focused?.id;
    if (target.status === 'paused') target.status = 'open';
    if (d.retypeTo) {
      target.type = d.retypeTo;
      target.step = 'start';
    }
    target.lastActivityAt = now;
    await this.store.users.setFocus(user.id, target.id);
    return { case: target, isNew: false, resumed, paused };
  }
}
