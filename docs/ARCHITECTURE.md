# FA Support Agent — Architecture

**State of the codebase:** the large automatic reply system was removed (git history, commit
`de1427a` and earlier). On the remaining infrastructure sit exactly two customer-facing workflows,
added deliberately: the one evidence request per deposit/withdrawal case, and the one solved note
after the export bot's payment confirmation. Nothing else can reach a customer.

## 1. What runs

```
Telegram (GramJS, personal account)
   │ NewMessage / UpdateReadHistoryInbox
   ▼
telegram/user/userTransport.ts ── screens the sender (own account, bots, contacts, Telegram service,
   │                               TELEGRAM_ALLOWED_USERS), routes Saved Messages to onAdminCommand,
   │                               support group / export bot / own outgoing to their handlers
   ▼
app.ts ─ onMessage:  admin command? → control/adminCommands.ts (replies through the RAW transport)
                     else → users.upsert + messages.insert (scrubbed) → workflows/evidenceRequest.ts
        ─ onOwnOutgoing → evidenceRequest.onOwnOutgoing (human takeover / resume command)
        ─ onExportMessage → workflows/paymentConfirmed.ts
        ─ onSupportMessage / onExportForward: log only.

workflows/evidenceRequest.ts (per customer message, in this order; any other outcome = silence):
  bot_enabled fresh? → not stale? → no human takeover? → has text? → detect language →
  open request in this chat? (same type & young → silent; the model is not asked inside an open case) →
  nlu/issueType.ts: moneyDirection scorer, else the model once (deposit | withdrawal | other | unclear) →
  not read by a human? → bot_enabled once more → requests.create('sending') → guarded sendText(kind
  'evidence_request') → markSent + outbound message row. A failed send removes the row.
workflows/paymentConfirmed.ts: PAYMENT CONFIRMED with a User ID → bot_enabled → dedupe key in settings
  (order id, else a fingerprint of the text) → guarded sendText(kind 'payment_confirmed') in the
  user's language → requests.markSolved.
```

Boot (`index.ts`): env → logger (with secret scrubbing) → store → OpenAI client (unused) →
transport → `assemble()` → `BotSwitch.restore()` → health server → `transport.start()`. The
`Supervisor` (`control/supervisor.ts`) owns the process: `/restart` stops the running instance,
re-reads `.env`, boots a new one under the same instance lock and only then confirms to the admin.

## 2. Module map

| Module | Role |
|---|---|
| `config/env.ts` | zod-validated environment; refuses secrets in path settings; `secretValues()` feeds the scrubber |
| `telegram/transport.ts` | the `Transport` interface (send text, delete own message, health) and `ReadStateApi` |
| `telegram/user/*` | GramJS implementation (receive, screen senders, route Saved Messages / support group / export bot / own sends, send with rate limits, read state), session stores (string / encrypted file), login + session + check scripts |
| `control/botSwitch.ts` | `bot_enabled` in the store's `settings` + `BOT_STATE_FILE` mirror; `isOnNow()` reads fresh; `restore()` at boot |
| `control/adminCommands.ts` | `/boton` `/botoff` `/restart` for `ADMIN_TELEGRAM_IDS` and the owner in Saved Messages |
| `control/customerMessaging.ts` | `CUSTOMER_MESSAGING_ENABLED = false` + allowlist {`evidence_request`, `payment_confirmed`} |
| `nlu/moneyDirection.ts`, `nlu/normalize.ts`, `nlu/issueType.ts` | direction-of-money scorer (Hinglish/Hindi/English cues), text normalisation + language detection, scorer-then-model classification |
| `workflows/evidenceRequest.ts`, `workflows/paymentConfirmed.ts` | the two workflows |
| `response/requests.ts`, `response/html.ts` | the request and solved-note wording in three languages; HTML escaping |
| `control/guardedTransport.ts` | wraps the transport: refuses customer sends/forwards while disabled or OFF; team chats pass |
| `storage/*` | `users`, `messages`, `evidence_requests`, `settings` repos over memory or Postgres; append-only migrations (old tables remain, unused) |
| `llm/*` | OpenAI client (`LlmClient`, `OpenAiLlm`, `DisabledLlm`, `ScriptedLlm`); the only prompt is the issue-type classifier |
| `security/*` | scrubber (secrets never reach logs), AES-256-GCM for the session file |
| `observability/*` | pino logger, health/readiness/metrics server, minimal Prometheus registry |
| `util/*` | instance lock, token buckets / semaphore |

## 3. Rules that hold today

- **Two customer messages, nothing else.** Both workflows send through `app.transport` (guarded),
  which throws `MessagingHeldError` for any chat that is not the support group or export bot unless
  the send's `kind` is allowlisted, and `BotOffError` while `/botoff` is in force. Admin replies
  use the raw transport on purpose.
- **One request per case, then silence.** An open request (younger than `CASE_REOPEN_HOURS`)
  silences the chat for that issue type; no reminder, status or follow-up exists in the code.
- **No guess, no question.** A message that is not clearly a deposit or withdrawal is stored and
  left alone.
- **Kill switch survives everything.** `bot.enabled` in the store (every process sees it) and the
  state file (a full restart with the in-memory store); `/restart` carries it in-process.
- **Secrets never logged.** Every configured secret is registered with the scrubber before any log line.
- **One instance per account.** PID lock at `INSTANCE_LOCK_FILE`.

## 4. Adding a reply workflow later

1. Give it an outbox/transport `kind` and send only through `app.transport`.
2. Add the kind to `ENABLED_CUSTOMER_MESSAGES` (or flip `CUSTOMER_MESSAGING_ENABLED`) deliberately.
3. Check `botSwitch.isOnNow()` at its first line and rely on the guard's final check before the send.
4. Cover it in `tests/unit/receiveOnly.test.ts`-style tests: what it sends, to whom, and what it
   never sends.
