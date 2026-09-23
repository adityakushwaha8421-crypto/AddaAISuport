# FA Support Agent — Architecture

**State of the codebase:** the automatic reply system (NLU, workflows, response composer, cases,
evidence, handoff, export, chat folders, job queue, admin-panel gateway, gateway/worker roles) was
removed. The full previous implementation is in git history (commit `de1427a` and earlier). What
remains is the infrastructure a reply workflow will be built on, and it can send **nothing** to a
customer.

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
                     else → users.upsert + messages.insert (scrubbed) + markProcessed; log. Nothing else.
        ─ onSupportMessage / onOwnOutgoing / onExportMessage / onExportForward: log only.
```

Boot (`index.ts`): env → logger (with secret scrubbing) → store → OpenAI client (unused) →
transport → `assemble()` → `BotSwitch.restore()` → health server → `transport.start()`. The
`Supervisor` (`control/supervisor.ts`) owns the process: `/restart` stops the running instance,
re-reads `.env`, boots a new one under the same instance lock and only then confirms to the admin.

## 2. Module map

| Module | Role |
|---|---|
| `config/env.ts` | zod-validated environment; refuses secrets in path settings; `secretValues()` feeds the scrubber |
| `telegram/transport.ts` | the `Transport` interface (send, forward, download, typing, delete, recent outgoing, folders, read state) |
| `telegram/user/*` | GramJS implementation, session stores (string / encrypted file), login + session scripts, folders + read-state helpers |
| `control/botSwitch.ts` | `bot_enabled` in the store's `settings` + `BOT_STATE_FILE` mirror; `isOnNow()` reads fresh; `restore()` at boot |
| `control/adminCommands.ts` | `/boton` `/botoff` `/restart` for `ADMIN_TELEGRAM_IDS` and the owner in Saved Messages |
| `control/customerMessaging.ts` | `CUSTOMER_MESSAGING_ENABLED = false` + empty allowlist: the code-level switch |
| `control/guardedTransport.ts` | wraps the transport: refuses customer sends/forwards while disabled or OFF; team chats pass |
| `storage/*` | `users`, `messages`, `settings` repos over memory or Postgres; append-only migrations (old tables remain, unused) |
| `llm/*` | OpenAI client (`LlmClient`, `OpenAiLlm`, `DisabledLlm`, `FakeLlm`) — infrastructure only, no prompts |
| `security/*` | scrubber (secrets never reach logs), AES-256-GCM for the session file, masking helpers |
| `observability/*` | pino logger, health/readiness/metrics server, minimal Prometheus registry |
| `util/*` | instance lock, keyed mutex, token buckets / semaphore |

## 3. Rules that hold today

- **No customer message, ever.** No code path sends to a customer. `app.transport` (guarded) is what
  a future workflow must use; it throws `MessagingHeldError` for any chat that is not the support
  group or export bot while `CUSTOMER_MESSAGING_ENABLED` is false and the kind is not allowlisted,
  and `BotOffError` while `/botoff` is in force. Admin replies use the raw transport on purpose.
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
