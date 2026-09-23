/**
 * TEMPORARY HOLD ON ALL CUSTOMER-FACING MESSAGES.
 *
 * While this is `false`, nothing automatic is sent to any customer chat: no AI replies, greetings,
 * deposit/withdrawal answers, evidence requests, match-issue replies, export confirmations,
 * follow-ups, or queued/delayed replies — including the "typing…" indicator. Every one of them is
 * refused at the transport (`control/guardedTransport.ts`), the last step before Telegram, and a
 * refused reply is cancelled in the outbox so it is never sent later either.
 *
 * Everything else keeps running for development and testing: messages are read, understood and
 * stored, cases are opened and updated, evidence is analysed and forwarded to the export bot,
 * tickets reach the support group, chats are filed in folders, and the admin commands
 * (/boton, /botoff, /restart) still answer the admin.
 *
 * The reply logic itself is untouched. To bring customer messaging back, set this to `true`
 * (or, to enable it piece by piece, gate the individual acts in `pipeline/processor.ts`).
 */
export const CUSTOMER_MESSAGING_ENABLED = false;
