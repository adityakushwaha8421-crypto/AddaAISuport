import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Everything about the admin panel's structure lives in config/admin.json (non-secret), so the
 * gateway can be pointed at the real panel — or adapted after a UI change — without code changes.
 * Credentials come only from the environment.
 */
const searchSchema = z.object({
  /** Page with the search form, e.g. "/payouts". */
  path: z.string().optional(),
  /** Alternative: direct URL with the query, e.g. "/payouts?search={query}". */
  urlTemplate: z.string().optional(),
  input: z.string().optional(),
  submit: z.string().optional(),
  resultRow: z.string().default('table tbody tr'),
  noResults: z.string().optional(),
  /** Inside the matching row, the element that opens the detail view. */
  viewButton: z.string().optional(),
});

export const adminPanelConfigSchema = z.object({
  loginPath: z.string().default('/login'),
  login: z.object({
    username: z.string(),
    password: z.string(),
    submit: z.string(),
    /** Visible only when logged in. */
    loggedInMarker: z.string(),
    /** Visible when credentials were rejected. */
    errorMarker: z.string().optional(),
  }),
  timezone: z.string().default('+05:30'),
  payout: z.object({
    search: searchSchema,
    /** Container of the detail view (page or modal). */
    detail: z.string().default('body'),
    labels: z.record(z.string(), z.array(z.string())),
  }),
  deposit: z.object({
    search: searchSchema,
    table: z.string().default('table'),
    columns: z.record(z.string(), z.array(z.string())),
  }),
});

export type AdminPanelConfig = z.infer<typeof adminPanelConfigSchema>;

export async function loadAdminPanelConfig(path: string): Promise<AdminPanelConfig> {
  return adminPanelConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export const DEFAULT_PAYOUT_LABELS: Record<string, string[]> = {
  withdrawalId: ['Withdrawal ID', 'Withdraw ID', 'Payout ID', 'Request ID', 'Withdrawal Id'],
  amount: ['Amount', 'Payout Amount', 'Withdrawal Amount'],
  status: ['Status', 'Payout Status'],
  beneficiaryName: ['Beneficiary', 'Beneficiary Name', 'Account Holder', 'Account Holder Name'],
  bankName: ['Bank', 'Bank Name'],
  branch: ['Branch', 'Branch Name'],
  accountNumber: ['Account Number', 'Account No', 'A/C No', 'Bank Account', 'Account'],
  ifsc: ['IFSC', 'IFSC Code'],
  utr: ['UTR', 'UTR Number', 'Bank Reference', 'Bank Ref No', 'RRN'],
  gateway: ['Gateway', 'Payment Gateway', 'Payout Gateway'],
  vendorOrderId: ['Vendor Order', 'Vendor Order ID', 'Gateway Order ID', 'Gateway Reference'],
  requestedAt: ['Requested At', 'Request Date', 'Created At', 'Created'],
  processedAt: ['Processed At', 'Completed At', 'Updated At', 'Processed On'],
  registrationNumber: ['Mobile', 'Mobile Number', 'Registered Number', 'Phone', 'User Mobile'],
  failureReason: ['Failure Reason', 'Reason', 'Remarks', 'Error'],
};

export const DEFAULT_DEPOSIT_COLUMNS: Record<string, string[]> = {
  orderId: ['Order ID', 'Order Id', 'Order', 'Txn ID', 'Transaction ID'],
  amount: ['Amount'],
  status: ['Status'],
  utr: ['UTR', 'Bank Ref', 'RRN', 'Reference'],
  createdAt: ['Date', 'Created At', 'Created', 'Time', 'Date & Time'],
  gateway: ['Gateway', 'Payment Gateway', 'Mode'],
  registrationNumber: ['Mobile', 'Phone', 'Registered Number', 'User'],
};
