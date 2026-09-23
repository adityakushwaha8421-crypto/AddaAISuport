/**
 * CUSTOMER MESSAGING IS DISABLED.
 *
 * The automatic reply system was removed (see git history before "Remove the automatic reply
 * system" for the full previous implementation). This switch is the safety net that stays: while
 * it is `false`, the guarded transport (`control/guardedTransport.ts`) refuses every send and
 * forward to a chat that is not one of the team's, whatever code path asks for it — so nothing
 * added later can message a customer by accident until it is deliberately enabled here.
 *
 * Reply workflows are to be added one by one. Each one that may message customers must stamp its
 * outbox `kind` and be listed in `ENABLED_CUSTOMER_MESSAGES`, or flip `CUSTOMER_MESSAGING_ENABLED`.
 */
export const CUSTOMER_MESSAGING_ENABLED = false;

/** Message kinds allowed through while the switch above is `false`. Empty: nothing at all. */
export const ENABLED_CUSTOMER_MESSAGES: ReadonlySet<string> = new Set<string>();
