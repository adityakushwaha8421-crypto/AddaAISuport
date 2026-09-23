# FA Support Agent

A Telegram agent for Fantasy Adda customer support, running on a **personal Telegram account**
(GramJS / MTProto, no bot token). **The automatic reply system has been removed.** What runs today:

- connects to Telegram with the account's session and stays connected (reconnects, session checks);
- **receives and stores** every customer message (text, captions, media references) with the
  sender, in Postgres or an in-memory store — and **sends nothing back to any customer**;
- answers only the admin's commands: `/boton`, `/botoff`, `/restart`;
- health (`GET /healthz`, `/readyz`) and Prometheus metrics (`GET /metrics`);
- infrastructure kept for the workflows to come: the OpenAI client (unused), the storage layer,
  the secret scrubber, the rate limiters, the Telegram folder/read-state helpers.

Reply workflows will be added one by one. Until then there is **no AI processing, no greeting, no
evidence request, no follow-up, no confirmation, no forwarding — zero automatic messages**. The
full previous implementation is in git history (commit `de1427a` and earlier).

Module map and design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Two safety nets

1. **Customer messaging switch (code).** `src/control/customerMessaging.ts` holds
   `CUSTOMER_MESSAGING_ENABLED = false` and an empty allowlist. Every automatic code path must send
   through the guarded transport (`app.transport`), which refuses any send or forward to a chat that
   is not the support group or the export bot. So nothing added later can message a customer by
   accident until it is deliberately enabled there.
2. **Kill switch (runtime).** `/botoff` sets `bot_enabled = false` in the store (shared by every
   process) and mirrors it to `BOT_STATE_FILE` (`data/bot-state.json`) so it survives a full
   restart even with `STORE=memory`, a `/restart`, and any reconnect. The guarded transport reads
   it fresh right before every send. `/boton` turns it back on. Today the switch changes nothing
   visible, since nothing replies; it is recorded on each stored message (`meta.ignored`).

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
| `/restart` | Safe in-process restart: Telegram disconnects and reconnects, `.env` is reloaded, the ON/OFF state is carried over. | `✅ Bot restarted successfully.` (after the new instance is up) |

## What is stored

- `users` — Telegram id, chat id, username, first name, language code.
- `messages` — every inbound customer message (text/caption after secret scrubbing, media
  references, reply-to id, Telegram date), marked `processedAt` on arrival with
  `meta.ignored = no_reply_system` (or `bot_off`). Outbound rows will come with the workflows.
- `settings` — `bot.enabled`, `bot.enabledAt`.

Messages from the account's own contacts (`TELEGRAM_IGNORE_CONTACTS=true`), from bots, from
Telegram's service account and from the owner's own account are never treated as customer messages.
`TELEGRAM_ALLOWED_USERS` restricts customers to a list (testing).

## Testing

```bash
npm test                  # offline & deterministic
npm run typecheck
TEST_DATABASE_URL=postgres://… npm test   # also run the storage contract against real Postgres
```

- `tests/unit/receiveOnly.test.ts` — the agent receives and stores messages of every kind, ON and
  OFF, and sends **zero** messages to customers; admin commands still answer the admin; the guarded
  transport refuses any attempt to message a customer.
- `tests/unit/adminControl.test.ts` — `/boton`, `/botoff`, `/restart`, the switch and the supervisor.
- `tests/unit/security.test.ts` — env validation, secret scrubbing, session encryption.
- `tests/unit/storage.contract.test.ts` — users, messages, settings (memory / pg-mem / Postgres).
- `tests/unit/userTransport.*.test.ts`, `telegram.test.ts`, `folders.test.ts`, `readState.test.ts` —
  the Telegram transport (message mapping, Saved Messages routing, own sends, folders, read state).

## Security rules (unchanged)

Telegram credentials and session strings are never hardcoded and never logged; the logger scrubs
every configured secret. `.env`, `secrets/`, `data/` and `logs/` are never committed.
