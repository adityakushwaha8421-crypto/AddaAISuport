# FA Support Agent

A Telegram agent for Fantasy Adda customer support, running on a **personal Telegram account**
(GramJS / MTProto, no bot token). It does exactly two things towards customers, and nothing else:

1. **One evidence request per case.** When a customer's message is clearly a **deposit** problem
   (money paid into the wallet, not showing) or a **withdrawal** problem (money withdrawn, not in
   the bank), the agent sends the list of documents the team needs — **once** — in the customer's
   language. The issue is read from the direction of the money in Hinglish/Hindi/English with
   misspellings (`src/nlu/moneyDirection.ts`), after ruling out match problems
   (`src/nlu/matchIssue.ts`); a vague follow-up ("paisa nahi aaya", "abhi tak nahi hua") takes its
   direction from the customer's recent messages; only when none of that is decisive is the model
   asked once, with that history as context (`src/nlu/issueType.ts`). Phrase tables:
   `tests/helpers/issuePhrases.ts`; live accuracy run: `RUN_LLM_EVALS=1 npm test -- tests/evals`. After that it is
   silent in that case: no acknowledgements, reminders, status updates or follow-ups, whatever the
   customer writes or sends. The human team handles everything from there.
2. **One solved note per confirmed payment.** When the export bot sends `✅ PAYMENT CONFIRMED`
   naming a `User ID`, exactly that customer is told once, in their language:
   *"Sir, aapka issue solved ho gaya hai. Sorry for the inconvenience. 🙏"*

Everything else — greetings, thanks, match issues, app/login problems, questions, unclear money
messages, bare photos — is received and stored and gets **no reply**. There is no clarification
question and no guess: when the issue is not clearly one of the two, the agent stays silent.

The previous, much larger reply system is in git history (commit `de1427a` and earlier).
Module map and design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What the request asks for

| Case | Requested (once) |
|---|---|
| Deposit | 10-digit registered number · payment screenshot · bank statement PDF of the account paid from · screen recording (video) of the payment |
| Withdrawal | Withdrawal ID **or** withdrawal-history screenshot · bank statement PDF of the account the amount should have reached |

## When the agent stays silent even for a deposit/withdrawal message

- `/botoff` is in force (checked first, fresh from the store, and again inside the transport right before the send).
- The chat already has an open request of the same type younger than `CASE_REOPEN_HOURS` (48).
  A clearly named problem of the *other* type gets its own single request.
- A human wrote in that chat from the account (until they type `/ai` or `/bot` there, which is deleted again).
- A human already read the message on Telegram (`REPLY_ONLY_TO_UNREAD`).
- The message is older than `STALE_MESSAGE_SECONDS` (300) when handled: a restart or reconnect catch-up never answers old messages.
- The message has no text (a bare screenshot or file says nothing about the issue).

## Two safety nets

1. **Customer messaging allowlist (code).** `src/control/customerMessaging.ts` keeps
   `CUSTOMER_MESSAGING_ENABLED = false` and allows exactly two message kinds through:
   `evidence_request` and `payment_confirmed`. Every automatic code path sends through the guarded
   transport (`app.transport`), which refuses any other send or forward to a chat that is not the
   support group or the export bot. Nothing added later can message a customer until it is listed there.
2. **Kill switch (runtime).** `/botoff` sets `bot_enabled = false` in the store (shared by every
   process) and mirrors it to `BOT_STATE_FILE` (`data/bot-state.json`) so it survives a full
   restart even with `STORE=memory`, a `/restart`, and any reconnect. Both workflows check it at
   their first line and the guarded transport reads it fresh right before every send. `/boton` turns
   it back on; messages that arrived while OFF are never answered.

## Setup

1. **Configure** — `cp .env.example .env` and fill it in. Secrets live only in `.env`, never in code.
2. **Database** — PostgreSQL 14+ and `STORE=postgres`; `npm run db:migrate` (also runs at start-up).
   `STORE=memory` keeps messages in the process only (development).
3. **Telegram account** — set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (https://my.telegram.org →
   API development tools), then run `npm run telegram:session` once: it asks for the login code
   (and 2FA password) and writes the **session string** into `.env` as `TELEGRAM_SESSION`. The
   string is a logged-in device: keep `.env` private, never commit or paste it anywhere.
   Alternative: `SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`) + `npm run telegram:login` keeps
   the session AES-256-GCM encrypted at `TELEGRAM_SESSION_FILE`. One running instance per account
   (`INSTANCE_LOCK_FILE`). `npm run telegram:check` verifies the login without starting the agent.
4. **Run** — `npm run build && npm start`, or `docker compose up -d` (Postgres + agent; mount
   `./secrets` and `./data`).

## Admin commands

Accepted from the Telegram user ids in `ADMIN_TELEGRAM_IDS` (comma-separated) when they message
the account, and always from the account owner typing in **Saved Messages**. From anyone else the
same words are an ordinary customer message: stored, not acted on, not answered.

| Command | Effect | Reply |
|---|---|---|
| `/botoff` | `bot_enabled = false`, saved in the store and the state file. | `⛔ Bot is OFF` |
| `/boton` | `bot_enabled = true`, saved the same way. | `✅ Bot is ON` |
| `/restart` (or `kill -USR2 <pid>` on the machine) | **Update + restart.** `git pull --ff-only` in the project folder, `npm install` if the lockfile changed, `npm run build`, then the running agent stops cleanly and a fresh process starts on the new code (`RESTART_MODE=respawn`, the default; `exit` lets systemd/docker/pm2 restart it instead). `.env` is re-read, the ON/OFF state is kept. If the pull or build fails, nothing restarts and the admin is told why. | `🔄 Pulling the latest code…` at once, then `✅ Bot restarted successfully.` + the commit, from the new process once it is up; or `⚠️ Update failed.` + reason |

## What is stored

- `users` — Telegram id, chat id, username, first name, language code.
- `messages` — every inbound customer message (text/caption after secret scrubbing, media
  references, reply-to id, Telegram date) and every outbound one (`meta.kind`).
- `evidence_requests` — one row per case: chat, user, issue type, language, status
  (`sending` → `sent` → `solved`), the request's Telegram id. With `STORE=memory` this ledger is
  kept on disk (`REQUESTS_STATE_FILE`, `data/requests.json`), so a restart never leads to a
  customer being asked a second time.
- `settings` — `bot.enabled`, `bot.enabledAt`, and one `payment_confirmed:…` key per payment told.

Messages from the account's own contacts (`TELEGRAM_IGNORE_CONTACTS=true`), from bots, from
Telegram's service account and from the owner's own account are never treated as customer messages.
`TELEGRAM_ALLOWED_USERS` restricts customers to a list (testing).

## Testing

```bash
npm test                  # offline & deterministic
npm run typecheck
TEST_DATABASE_URL=postgres://… npm test   # also run the storage contract against real Postgres
```

- `tests/unit/evidenceRequest.test.ts` — the workflow end to end: deposit/withdrawal read from
  natural phrasing in three languages, one request then silence for every follow-up, a second
  different issue, human takeover and `/ai`, read-by-human, `/botoff`, stale messages, failed
  sends, and the PAYMENT CONFIRMED note (exact user, once per payment, language, no User ID → nobody).
- `tests/unit/moneyDirection.test.ts` — the phrasing tables for the direction scorer.
- `tests/unit/receiveOnly.test.ts` — everything else is stored and gets **zero** messages; admin
  commands still answer the admin; the guarded transport refuses any other customer send.
- `tests/unit/adminControl.test.ts` — `/boton`, `/botoff`, `/restart`, the switch and the supervisor.
- `tests/unit/security.test.ts` — env validation, secret scrubbing, session encryption.
- `tests/unit/storage.contract.test.ts` — users, messages, settings (memory / pg-mem / Postgres).
- `tests/unit/userTransport.savedMessages.test.ts`, `telegram.test.ts`, `readState.test.ts` — the
  Telegram transport (message mapping, sender screening, Saved Messages routing, own sends, read state).

## Security rules (unchanged)

Telegram credentials and session strings are never hardcoded and never logged; the logger scrubs
every configured secret. `.env`, `secrets/`, `data/` and `logs/` are never committed.
