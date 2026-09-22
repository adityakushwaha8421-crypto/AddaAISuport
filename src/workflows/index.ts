import type { CaseType } from '../domain/cases.js';
import { DepositWorkflow } from './deposit.js';
import { GenericWorkflow } from './generic.js';
import type { Workflow } from './types.js';
import { WithdrawalWorkflow } from './withdrawal.js';

export * from './types.js';

export function createWorkflows(): Record<CaseType, Workflow> {
  const generic = new GenericWorkflow();
  return {
    deposit: new DepositWorkflow(),
    withdrawal: new WithdrawalWorkflow(),
    technical: generic,
    account: generic,
    other: generic,
  };
}
