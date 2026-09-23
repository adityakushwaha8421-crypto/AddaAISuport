/**
 * WHAT MAY BE SAID TO A CUSTOMER, AND NOTHING ELSE.
 *
 * `CUSTOMER_MESSAGING_ENABLED` stays `false`: the guarded transport (`control/guardedTransport.ts`)
 * refuses every send and forward to a chat that is not one of the team's — unless the send carries
 * one of the kinds listed below. Every workflow that messages customers must stamp its kind and be
 * listed here deliberately, so nothing added later can message a customer by accident.
 *
 * Enabled today (`workflows/`):
 *  - `evidence_request`: the ONE request per deposit/withdrawal case (then silence in that case);
 *  - `payment_confirmed`: the one solved note after the export bot's "✅ PAYMENT CONFIRMED … User ID".
 */
export const CUSTOMER_MESSAGING_ENABLED = false;

/** Message kinds allowed through while the switch above is `false`. */
export const ENABLED_CUSTOMER_MESSAGES: ReadonlySet<string> = new Set<string>(['evidence_request', 'payment_confirmed']);
