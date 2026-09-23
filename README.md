# FA Support Agent

Context-aware AI customer-support agent for Telegram (Fantasy Adda). It is **not** a form: it
understands the current message in the light of history, swipe-replies, screenshots and PDFs,
verifies facts against the admin panel, solves what it can, asks only for what is genuinely
missing, and hands the case to humans — with a complete summary — when automation reaches its limit.

> Understand everything available → verify what can be verified → solve what can be solved →
> ask only for genuinely missing information → hand off to a human when automation reaches its limit.

Architecture, decisions and module map: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (no Telegram, no database)

```bash
npm install
npm test                 # unit + storage contract + conversation regression suites
npm run dev:chat         # chat with the full agent in your terminal (fixture admin data)
```

In `dev:chat` try: `withdrawal nahi aaya` → `WD-15436-64215` → `credit nahi hua` →
`/pdf path/to/statement.pdf` → `/support`. With `OPENAI_API_KEY` set it uses the real model
(interpretation, screenshot understanding, phrasing); without it runs in degraded mode.

## Production setup

1. **Configure** — `cp .env.example .env` and fill it in. Secrets live only in `.env`.
2. **Database** — PostgreSQL 14+. `npm run db:migrate` (also runs automatically at start-up).
3. **Telegram account** — the agent runs on your personal Telegram account (MTProto; no bot token).
   Set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (https://my.telegram.org → API development tools),
   then run `npm run telegram:session` once: it asks for the login code (and 2FA password), then
   writes the resulting **session string** into `.env` as `TELEGRAM_SESSION` (and a copy to
   `secrets/telegram.session.string`, mode 0600). The agent uses that string directly. The string
   is a logged-in device: keep `.env` private, never commit or paste it anywhere; pass `--print`
   only if you need to see it to move it to another machine. Alternative: set
   `SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`) and run `npm run telegram:login` to keep the
   session AES-256-GCM encrypted at `TELEGRAM_SESSION_FILE` instead.
   Run a single instance per account. The agent only answers messages that are still **unread**:
   once you open a chat and read a message, it leaves that message to you. If you type in a
   customer chat from your phone, that customer is yours: the agent closes their unfinished case and
   goes completely silent in the chat — no replies, no evidence requests, no greetings, no new
   workflow whatever the customer writes next — until you hand it back by typing `/ai` (or `/bot`)
   in that chat, which is deleted again before the customer sees it. `HUMAN_TAKEOVER_MINUTES` (default
   0 = never) can add an automatic hand-back after that many minutes.
4. **Export bot** — set `EXPORT_BOT_ID` to the bot's Telegram user id, then open that bot from the
   account and press **Start** once (a user account can only message a bot it has started). Each
   completed case goes there as plain Telegram forwards of the customer's original messages (the
   number, the screenshot, the video, the statement) — no summary text. The bot's
   `PAYMENT CONFIRMED` reply makes the agent tell that customer the deposit is solved — the
   customer is identified by a `User ID: <telegram id>` in the reply, by the reply being on one of
   the forwards, or by the `Mobile: <number>` line matching one pending case.
5. **Support group** — add the account to the support group and set `SUPPORT_GROUP_CHAT_ID`.
   Agents reply *to the ticket message* to answer the customer; `/note …` stays internal,
   `/bot` hands the chat back to the bot, `/close` closes the case.
6. **Admin panel** — `ADMIN_MODE=playwright` + `ADMIN_BASE_URL/USERNAME/PASSWORD`. Adapt
   [config/admin.json](config/admin.json) (selectors, label/column synonyms) to the real panel, then
   verify with `npm run admin:login -- WD-XXXXX-XXXXX`. `ADMIN_HEADLESS=false` lets you watch.
7. **Run** — `npm run build && npm start`, or `docker compose up -d` (Postgres + agent;
   mount `./secrets`). Health: `GET /healthz`, Prometheus metrics: `GET /metrics` (`HTTP_PORT`).

## Running at scale

One process (`ROLE=all`, the default) is fine for a few hundred customers a day. Beyond that,
split the roles (all with `STORE=postgres`, the queue lives in the database):

```
ROLE=gateway  INTERNAL_TOKEN=<random>  HTTP_HOST=0.0.0.0          # exactly one: owns the Telegram session
ROLE=worker   INTERNAL_TOKEN=<same>    GATEWAY_URL=http://gateway:9464  WORKER_CONCURRENCY=4   # as many as you like
```

The gateway only receives, persists and queues messages and executes Telegram operations for the
workers; workers do the AI, PDF and export work. Add workers when `fa_queue_jobs{status="pending"}`
stays high. Every job is leased and retried with backoff; a worker that dies loses its lease and
another one finishes the job without duplicating replies or forwards. `GET /readyz` returns 503
while an instance drains (SIGTERM finishes in-flight jobs first). Rate limits: `TELEGRAM_SEND_RATE`
(account-wide/s), `TELEGRAM_CHAT_SEND_RATE` (per chat/s), `OPENAI_MAX_CONCURRENCY`.

## Admin commands

Three commands control the agent. They work for the Telegram user ids listed in `ADMIN_TELEGRAM_IDS`
(comma-separated) when they message the account, and always for the account owner typing in
**Saved Messages** (the chat with yourself). From anyone else the same words are just a customer
message and do nothing.

| Command | Effect | Reply |
|---|---|---|
| `/botoff` | Agent OFF, saved permanently (store `settings`, shared by every process). **Everything automatic stops**: replies, evidence requests, greetings, folder filing, exports, confirmations, background retries. The state is checked before a message is read, before the AI is called and again right before every send or forward, so a reply that was being prepared when the command arrived is cancelled; unsent replies from before are withdrawn and never sent later. Messages are still received and stored, and the work waits in the queue. | `⛔ Bot is OFF` |
| `/boton` | Agent ON again, saved permanently; the work that arrived while OFF is picked up. | `✅ Bot is ON` |
| `/restart` | Safe in-process restart: in-flight jobs finish, Telegram disconnects and reconnects, `.env` and every config file are reloaded, the ON/OFF state is preserved. | `✅ Bot restarted successfully.` (only after the new instance is up) |

## ⚠️ Customer messaging is currently on hold

`src/control/customerMessaging.ts` holds `CUSTOMER_MESSAGING_ENABLED = false`. While it is
`false`, **no automatic message reaches any customer**: no AI replies, greetings,
deposit/withdrawal answers, evidence requests, match-issue replies, export confirmations,
follow-ups or queued replies, and no "typing…" indicator. The transport refuses each one as the
last step before Telegram, and the outbox cancels it so it is never sent later. Everything
internal keeps running (cases, evidence analysis, forwards to the export bot, support-group
tickets, folders, `/boton` `/botoff` `/restart` replies to the admin). The reply logic below is
unchanged and is re-enabled by flipping that constant (or gating individual acts in
`src/pipeline/processor.ts` to bring it back piece by piece).

**Active right now (and only this):**

1. **Folder management** — a match-related message moves the chat to **Match issues**, any other
   support issue to **Support**; a later, different issue moves it again. No customer reply.
2. **Export bot payment confirmation** — when the export bot sends `✅ PAYMENT CONFIRMED` with a
   `User ID: <id>` line, exactly that customer is told, in their language:
   *"Sir, aapka issue solved ho gaya hai. Sorry for the inconvenience. 🙏"* — once per payment
   (same order or same confirmation re-sent → nothing more). A confirmation without a User ID
   messages nobody (it can still close the matching case by mobile/reply, silently). This is the
   one kind on the `ENABLED_CUSTOMER_MESSAGES` allowlist in `src/control/customerMessaging.ts`.

## How it behaves

| Situation | Behaviour |
|---|---|
| How the issue is described | Deposit vs withdrawal is read from the direction of the money in natural Hinglish/Hindi/English ("paise add nahi hue" → deposit; "mere paise nahi aaye", "bank me nahi aaya" → withdrawal), spelling mistakes and all; a phrasing that fits both ("amount credit nahi hua") gets one short question, never a guess |
| Match issue (points, lineup, under review, extension, missing player, result…) | Manual only: the chat goes to the **Match issues** folder and the bot sends nothing — no reply, request, greeting or "team is checking" line — even when the message also mentions a deposit. Small talk and follow-ups stay silent and keep the chat there until a human answers; a different support problem is handled and moves the chat to **Support** |
| Greetings | A greeting ("Hello sir 👋 Kaise help karun?") only on the customer's **first message of their calendar day** (`CUSTOMER_TIMEZONE`, default Asia/Kolkata); every later "hi"/"hello" that day is answered without a welcome, and never while a case is pending |
| Deposit / withdrawal case (`CASE_REPLIES=request_only`, the default) | The bot first works out which it is (asking once if it genuinely cannot tell), sends the evidence request **once**, and then says nothing more in that case: no "mil gaya", no reminders, no "which withdrawal?", no status, no "shared with the team" and no "solved" message. Underneath it keeps collecting, exports the items to the team's bot when complete, files tickets for customers who ask for a person, and closes the case on the team's confirmation. `CASE_REPLIES=conversational` restores the full dialogue. |
| First message of an issue | One batched request (deposit: registered number, payment screenshot, payment video, bank statement PDF; withdrawal: Withdrawal ID or history screenshot, bank statement PDF — nothing else) |
| Partial info arrives | Confirms what arrived ("Payment screenshot mil gaya ✅"), asks only the rest |
| Info already given anywhere (text, screenshot, reply, earlier turn) | Never asked again |
| Returning customer | Remembers the registration number they proved earlier, their payout bank (masked), past cases, and how they write (language, "sir"/"bhai", short replies) — deposit and withdrawal cases stay separate |
| "upar wala" / "second wala" / "neeche wala" / swipe-reply | Resolved against the rows of the screenshot or the bot list being replied to; ambiguous → asks, never guesses |
| Unrelated question mid-case ("lineup de diya karo") | Case paused, question answered without leaking case data; resumed later with state intact |
| Withdrawal SUCCESS | Reports it with masked destination (`HDFC Bank XXXX6789`); asks for a statement **only** if the user says it didn't arrive |
| Bank statement | Must be the payout account (account/IFSC/bank/name); mismatch → says so; same account + credit missing → human |
| PDF | Password asked only if actually encrypted; passwords parsed from natural text, tried, never stored or logged |
| User can't/won't provide more | Stops asking; hands off with what exists |
| Admin panel down | Honest handoff — never a false "not found" |
| Handoff / uncertainty | The customer is told **nothing** — no "team will check", no "forwarded", no "please wait". The case (with its full summary) goes to the support group, and failed deliveries are retried silently |
| Outside its knowledge | Stays silent rather than guessing; only approved `knowledge.json` answers are given |

**Presentation.** Replies are plain text internally and rendered as Telegram HTML at send time: amounts in bold, IDs and masked accounts in monospace, everything else escaped, so no customer or agent text can inject markup.

**Anti-hallucination.** Identifiers (IDs, UTRs, amounts, accounts) are taken only from the user's
own text, evidence transcripts, or the admin panel — LLM-proposed values that don't literally occur
are discarded. Vision fields unconfirmed by the transcript are down-weighted. Customer replies are
built from structured *acts* holding verified values; LLM phrasing is checked by a guard that
rejects any new number/ID, unearned "forwarded/received/successful" claims, invented timelines or
claims of being human, falling back to templates.

**Privacy.** Order details are disclosed only against proof of payment (screenshot, UTR, or amount
+ date) — typing someone's phone number reveals nothing. Accounts are masked for customers and
support alike.

**Idempotency.** Inbound messages are de-duplicated by `(chat, message_id)`; each turn has exactly
one outbox entry (`turn:<id>`), so retries/crashes can't double-reply; tickets are one-per-case;
evidence is de-duplicated by Telegram file id and SHA-256; admin lookups are cached and single-flighted.
Unprocessed messages are recovered at start-up.

## Testing

```bash
npm test                  # everything offline & deterministic
npm run typecheck
TEST_DATABASE_URL=postgres://… npm test   # also run the storage contract against real Postgres
RUN_LLM_EVALS=1 OPENAI_API_KEY=… npm run test:llm   # live interpreter evaluation (costs tokens)
```

- `tests/unit` — entities, passwords, references, intent (lexical + LLM validation), evidence
  (real encrypted PDFs, vision cross-checks), verification, router, queue, response guard,
  admin (resilience + Playwright against a local mock panel), handoff, security, Telegram mapping,
  storage contract (memory / pg-mem / Postgres).
- `tests/conversations/regression.test.ts` — the 20 required conversation scenarios, end-to-end.
- `tests/conversations/extended.test.ts` — clarification, frustration, voice notes, escalated
  follow-ups, admin outage, SLA breach, crash recovery, idle close, human takeover, LLM path.

## Configuration notes

- Registration/withdrawal/order ID formats are regexes in `.env`.
- General (non-case) answers come only from [config/knowledge.json](config/knowledge.json) — add
  business-approved entries (format: `config/knowledge.example.json`).
- Tone and phrasing rules: [config/style/fa_chat_style.json](config/style/fa_chat_style.json).
- Customer memory lives in `users.memory` (registration numbers, masked payout bank, last 5 cases).
  A support agent can erase it by replying `/forget` on the ticket.
- `MAX_ASKS_PER_SLOT` (default 2): a request counts when it's new or the user made no progress;
  beyond the limit the case goes to humans instead of looping.
- **Evidence export** — with `EXPORT_BOT_ID` set, a case reaches the team only once every item the
  bot asked for is in (deposit: number, payment screenshot, bank statement PDF, payment video;
  withdrawal: **only** the Withdrawal ID or history screenshot, and the bank statement PDF — nothing
  else is asked for or forwarded). Then the original messages are forwarded to the export bot (real forwards, so the bot sees the customer;
  nothing else is sent, no summary, no case id), Telegram is asked to confirm each one exists in
  the bot's chat, and only then the customer reads: *"Your details and documents have been shared with our team successfully. They
  will review your issue and work on resolving it as soon as possible. ✅"*. The case is then
  submitted: greetings and "ok" get no reply, nothing is asked again, later files are forwarded
  silently. The forwarding state is stored per case, so nothing is ever forwarded or confirmed
  twice. If the export fails or cannot be verified the customer is told nothing, the case stays
  pending, and it is retried automatically (worker, every 2 minutes, up to 20 times). Exported
  cases post nothing to the support group. A customer who says they cannot send an item, or asks
  for a person, goes to the support group as a ticket instead (no case id shown), without an
  export. When the bot replies `PAYMENT CONFIRMED … User ID: <id>`, that customer gets "Sir, aapka
  deposit issue solve ho gaya hai. Inconvenience ke liye sorry. ✅" (English customers get the
  English line) and the deposit case is closed as solved; a repeated confirmation sends nothing.
- **Waiting after a request** — once the bot has asked for details, it waits. "Hi", "ok", "thanks"
  and the like get no reply while a case is pending (asked, or with the team); the details, a
  document or a clearly new issue continue the conversation. A case ends only when it is resolved,
  idle-closed, or a human replies.
- **Unread messages only** — `REPLY_ONLY_TO_UNREAD` (default `true`). The bot replies to a message
  only while it is unread on Telegram; a message a human has already read (greeting, deposit,
  withdrawal, anything) gets no reply, even if the chat has an open case. The next message, while
  still unread, is answered normally. Read messages are still filed in their chat folder.
- **Chat folders** — `CHAT_FOLDERS_ENABLED` (default `true`), `MATCH_ISSUES_FOLDER` (default
  `Match issues`) and `SUPPORT_FOLDER` (default `Support`); titles at most 12 characters. Each chat
  sits in the one folder its **latest message** calls for: a match problem (wrong or late points,
  under review, lineup, extension, missing player, result) → Match issues, with no reply; any other
  support issue (deposit, withdrawal, payment, account/login, technical…) → Support; small talk like
  "hello" → neither. A message mentioning both a match and a deposit problem goes to Match issues.
  A human reply takes a chat out of its folder (Match issues or Support); the customer's next
  message files it again if it needs to. Telegram doesn't allow empty
  folders, so a folder disappears when it has no chats and comes back with the next one.

## Known limitations

- Voice notes are acknowledged but not transcribed. **Every PDF a customer sends counts as their
  bank statement** and is forwarded to the team as it is; scanned (image-only) PDFs are not OCR'd,
  so nothing can be verified from them automatically (with the admin panel on, the customer is
  asked once for a downloaded e-statement).
- Screen recordings need `ffmpeg` (`FFMPEG_PATH`); without it they are handled as unsupported.
- The Playwright gateway is generic and config-driven; it has been tested against a mock panel and
  must be pointed at the real one (`npm run admin:login`) before production.
- One running instance per Telegram account (one MTProto session).
- Telegram caps how many chats a folder can hold (about 100 on a regular account). Support fills
  fastest, since a chat stays there until its latest message is a match problem or small talk. Past
  the cap, filing fails; it is logged and counted in `fa_chat_folder_total{outcome="failed"}`.

## Evidence forwarded to the export bot by hand

Staff share the Telegram account with the bot. When a person reads or answers a customer chat, the bot steps
back (`seen_by_human` / `human_takeover`) and its own export never runs; the person then forwards the customer's
number, payment screenshot, payment video and bank statement to the export bot themselves.

`src/handoff/manualExports.ts` watches the account's own forwards in the export bot's chat
(`onExportForward`; the exporter's forwards are told apart and ignored). It finds the customer from the forward's
original sender - or, when the customer hides their account on forwards, from the file id / number the customer
sent us - and once all FOUR items of one customer are there **and Telegram confirms each of them exists in the
export bot's chat**, sends the agreed "shared with our team" confirmation, once. A partial set, a forward that
never arrived, or a case the bot already confirmed itself earns nothing. Window: 60 minutes per customer.

Log lines to look for: `manual forward to the export bot noted; still waiting for the rest`,
`manual export verified in the export bot chat: customer told their documents were shared`,
`manual export not confirmed: Telegram does not show every item in the export bot chat`.
