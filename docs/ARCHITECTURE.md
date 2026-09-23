# FA Support Agent — Architecture

> Understand everything available → verify what can be verified → solve what can be solved →
> ask only for what is genuinely missing → hand off to a human when automation reaches its limit.

The LLM is the **reasoning layer**. The database is the **source of truth** for state, and the
admin panel is the **source of truth** for money. Nothing the model says becomes a fact until it is
either (a) literally present in what the user sent, or (b) returned by a backend/admin tool.

---

## 1. Turn pipeline

A *turn* is one logical user utterance: a single message, or a burst of messages that arrive
within a short debounce window (e.g. a screenshot followed by "ye dekho"). A turn produces **at most
one** logical reply.

```
Transport (GramJS — personal Telegram account over MTProto)      ── the GATEWAY process
   │  normalises to InboundMessage (text, caption, media refs, reply_to snapshot)
   ▼
Receiver ──► Dedup (messages UNIQUE(chat_id, message_id, direction))  ── duplicate → drop
   ▼
Job queue (Postgres `jobs` table; one `turn` job per chat, rapid messages merged into it,
           run after the debounce; ordering key = chat id, so one chat never runs twice at once)
   ▼
JobRunner (N WORKER processes × WORKER_CONCURRENCY; leases + heartbeats; crashed leases reaped)
   ▼
TurnProcessor
   1. Secret scrub       – PDF passwords / OTPs removed from text before storage or LLM
   2. Context            – history, focused + paused cases, reply/swipe context (DB-resolved)
   3. Evidence           – download → hash → dedupe → classify → extract (image / PDF / video)
   4. Signals            – deterministic entities, ordinal references, password candidates
   5. Interpretation     – LLM structured output (lexical fallback), validated against signals
   6. Case routing       – continue / new / resume / side-topic (pause) / none
   7. Workflow           – absorb facts → resolve references → admin verification → decide
   8. Handoff            – ticket (idempotent) → support-group delivery → only then tell user
   9. Compose            – ResponsePlan (acts) → template or guarded LLM phrasing
  10. Persist + send     – case (optimistic version), outbox (UNIQUE turn_id), outbound message meta
```

### 1.1 Processes and roles (`ROLE`)
| Role | Runs | Needs |
|---|---|---|
| `all` (default) | everything in one process, in-memory or Postgres queue | — |
| `gateway` (exactly one per Telegram account) | the MTProto session, message persistence + queueing, the internal HTTP API (`/internal/*`, bearer `INTERNAL_TOKEN`), chat folders, periodic maintenance (ticket/export retries, idle close), instance lock | `STORE=postgres`, `INTERNAL_TOKEN` |
| `worker` (any number) | queued jobs: AI turns, media, PDF parsing, export forwarding, relays, bot confirmations; Telegram through `RemoteTransport` → gateway | `STORE=postgres`, `INTERNAL_TOKEN`, `GATEWAY_URL` |

Fast path (gateway): receive → persist → enqueue, milliseconds, never blocked by AI or downloads.
Slow path (workers): everything else. Telegram itself allows one MTProto session per account and
~30 messages/second, so the gateway is the natural single point; it does no heavy work.

### 1.2 What makes it safe with many workers
- **Ordering + isolation**: a job's `ordering_key` is the customer chat; the queue hands out at most
  one running job per key, oldest first, across all workers. Human actions from the account
  (`own_outgoing`) queue under the same key, so a human and the AI never race on one chat. Case
  writes are optimistic (`version`), so a stale write fails instead of overwriting.
- **Idempotency keys**: inbound `messages UNIQUE(chat, id, direction)`; turn replies `outbox
  UNIQUE(key = turn:<chat>:<last message id>)` (a re-run of the same turn cannot send twice);
  evidence by `file_unique_id` and sha256; export forwards recorded per message in
  `facts.export.forwarded`; the customer's "shared" line once per case (`status: confirmed`);
  bot confirmations `outbox solved:<case>`; queue jobs by `idempotency_key` (`support:`, `own:`,
  `export:` + Telegram message id).
- **Leases**: a job is leased for `JOB_LEASE_SECONDS` and heartbeated; a worker that dies stops
  heartbeating and the reaper returns the job. Handlers re-run safely: a turn skips messages
  already `processed_at`, exports resend only forwards not yet recorded.
- **Retries with backoff**: jobs 2s·2ⁿ (jitter, cap 5 min, `JOB_MAX_ATTEMPTS` then dead, kept for
  inspection); outbox sends retried by the maintenance loop; worker→gateway HTTP calls retried on
  network/5xx only; Telegram `FLOOD_WAIT` ≤ 30 s waited out in place.
- **Backpressure**: per-chat and account-wide token buckets on sends (`TELEGRAM_SEND_RATE`,
  `TELEGRAM_CHAT_SEND_RATE`); `OPENAI_MAX_CONCURRENCY` per process; a customer's flood merges into
  one pending turn instead of one job per message; queue depth exported as `fa_queue_jobs` and
  logged when the backlog grows (add workers).
- **Health**: `/healthz` (store, telegram, admin), `/readyz` (503 while draining or the queue is
  unreachable — take the instance out of rotation), `/metrics`. SIGTERM: stop claiming, finish
  in-flight jobs (30 s cap), disconnect, close the pool.

## 2. Module map

| Path | Responsibility |
|---|---|
| `src/config` | zod-validated env, non-secret JSON config (admin selectors, style, knowledge) |
| `src/observability` | pino logger with secret scrubbing, metrics registry, health server |
| `src/security` | secret scrubber, masking (account/phone), AES-GCM for session files |
| `src/domain` | shared types: messages, cases, evidence, admin records, plans |
| `src/storage` | `Store` interface + `MemoryStore` + `PostgresStore`, SQL migrations |
| `src/telegram` | `Transport` interface, `user/` account transport (GramJS, isolated), encrypted session lifecycle, login CLI |
| `src/pipeline` | receiver, turn processor, outbox sender |
| `src/queue` | durable job queue (`MemoryQueue`, `PostgresQueue`), `JobRunner` (leases, heartbeats, backoff, drain) |
| `src/telegram/remote.ts`, `gatewayApi.ts` | worker↔gateway internal API: Telegram operations and folder edits over HTTP |
| `src/util/rateLimiter.ts` | token buckets, semaphore, retry with backoff |
| `src/context` | conversation history, reply context resolution, reference resolution |
| `src/nlu` | deterministic entity extraction, password parsing, lexical fallback, LLM interpreter |
| `src/llm` | `LlmClient` interface + OpenAI implementation (JSON-schema outputs, vision) |
| `src/evidence` | classifier + extractors: images (vision+transcript parsing), PDF (password, text), video (frames) |
| `src/verification` | deposit matching, account matching, statement transaction search |
| `src/admin` | `AdminGateway` interface, resilient wrapper (timeout/retry/breaker/cache/single-flight), Playwright + fixture gateways |
| `src/domain/memory.ts` | per-customer memory across cases: proved registration numbers, payout bank (masked), case history |
| `src/cases` | case service: create / focus / pause / resume / close, slot + ask tracking |
| `src/workflows` | `deposit`, `withdrawal`, `generic` (collect-and-handoff), workflow registry |
| `src/handoff` | ticket lifecycle, summary builder, support-group delivery, retry worker, relay, evidence export to the export bot + its "PAYMENT CONFIRMED" replies |
| `src/monitoring` | chat folders: keeps each chat in "Match issues" or "Support" by its latest message |
| `src/response` | style guide, act templates (Hinglish/English/Hindi), LLM phrasing + hallucination guard |
| `src/app.ts` | composition root shared by production (`src/index.ts`), the terminal chat and the test harness |
| `src/util` | keyed mutex (per-chat serialisation across processor and workers) |
| `src/dev` | `npm run dev:chat` — full agent in a terminal |

## 3. Key design decisions

### 3.1 Facts vs interpretations
Every case field carries a **source** (`text`, `reply`, `screenshot`, `statement`, `admin`) and
**confidence**. Admin values overwrite everything else. LLM-proposed identifiers are dropped unless
they appear verbatim (after normalisation) in the user's text or in the evidence transcript.

### 3.2 Minimum friction
Workflows are **goal-driven**, not checklists. Each workflow computes "what do I need for the next
verification step", checks every source first, and asks for the *minimum* missing slot.
`asks[slot]` counts are persisted; a slot is never asked more than `MAX_ASKS_PER_SLOT` times — after
that, or when the user declines, the case goes to a human with whatever exists.
The first request in a case is **batched** (all likely useful items in one message); later messages
**acknowledge what was received** and ask only for the remainder.

### 3.3 Reply / swipe context
Every outbound message is stored with `meta` (e.g. the withdrawal candidates it listed, the order it
talked about). Every inbound message with `reply_to` is resolved against the DB first (text, caption,
evidence extracted from its media, bot meta) and falls back to the transport's snapshot. Ordinal
references ("upar wala", "second wala", "last wala") resolve against the candidates attached to the
replied-to message, else the most recent candidate list in the focused case.

### 3.4 Topic switching
One **focused** case per user; others are `paused`. A side topic pauses the focused case and is
answered without case data. A later message that clearly targets a paused case (explicit mention,
matching entity/evidence type, reply to a message of that case) resumes it with all its state.

### 3.5 Idempotency
- inbound: `messages UNIQUE(chat_id, telegram_message_id, direction)`
- replies: `outbox UNIQUE(turn_id)` — one logical reply per turn, crash-safe
- evidence: `UNIQUE(user_id, file_unique_id)` + sha256 reuse — no double processing
- tickets: one open ticket per case; delivery is a separate state (`created → delivered | failed`)
- admin lookups: single-flight + TTL cache

### 3.6 Handoff (silent)
Handoff is a workflow outcome, not an error path. The ticket carries a masked, structured summary
to the support group, and a worker retries failed deliveries. The customer is told **nothing**:
no escalation, forwarding, "manual check" or "please wait" line — humans take the case over from
the group. The same applies when the agent is unsure or a question falls outside approved
knowledge: it stays silent instead of guessing. The response guard rejects any phrasing that
mentions the team or escalation.

**Waiting for requested details.** Sending a request does not finish a case. While any case is
pending (`open`, `paused` or `escalated`), a greeting, "ok" or "thanks" with nothing structural in
it gets no reply and changes nothing: no greeting restart, no reminder, no status change. The
requested details, a document, a clearly new issue or a question the case can answer move the
conversation on. Only completion (`resolved`), an idle close or a human reply ends a pending case.

**Export.** Handoffs on deposit and withdrawal cases pass through the export gate first (§3.14):
the ticket and the customer's confirmation wait until everything requested has arrived.

**Human replies.** When a human answers the customer (typed on the account, or relayed from the
support group), the customer is the human's: the bot closes their pending cases and says nothing
in that chat — no reply, no request, no greeting, no new case for a new complaint, no workflow
change — for every message until the human hands the chat back (`AI_RESUME_COMMAND`, default
`/ai`, or `/bot`, typed in the chat and deleted again; `/bot` on the ticket in the support group
does the same). `HUMAN_TAKEOVER_MINUTES` > 0 adds an automatic hand-back after that long; the
default 0 leaves it to the human. Messages keep being read and filed into the folders meanwhile,
so the team still sees what the customer is writing about.

A message a human already read on Telegram gets no reply either (§3.13). Otherwise, silence is decided in three places: `isUncertain` in the processor drops a turn before any case
work when the interpreter could not read the message and the turn carries nothing structural
(evidence, identifier, reference, password, claim); `requestSlots` records what is outstanding
without asking again when a turn brings nothing that answers or chases the request; and `general`
answers an unrelated question only from approved knowledge. A dropped turn is stored with status
`skipped` and still appears in the transcript for humans.

### 3.7 Privacy: proof before disclosure
Anyone can type a phone number. Deposit order details (IDs, amounts, statuses) are only disclosed
when the user shows proof of the payment (screenshot, UTR, or amount + date) that matches an order.
Bank accounts are masked everywhere (customers and support group).

### 3.8 Customer memory
`users.memory` keeps what a customer proved in earlier cases: registration numbers (flagged
verified once the admin panel matched them), the payout bank masked, and the last five cases.
A new case pre-fills the registration number from memory with source `memory` — the lowest
precedence, so anything the customer types now overrides it — which removes it from the one-time
request. The support summary carries a one-line customer history; prompts get the same line without
the raw identifiers. `/forget` on a ticket erases it.

### 3.9 Ask accounting
A slot's ask counter increases when it is requested for the first time, or when the user made no
progress since the last request. Asking for the remaining item right after partial progress is
batch-then-confirm and does not count. Reaching `MAX_ASKS_PER_SLOT` → handoff, never a loop.
Promises ("baad mein bhejta hoon") are acknowledged without counting; "already sent" claims get an
honest "not received yet".

### 3.10 Language
The reply language follows the user's words. Messages with no language signal (IDs, numbers,
"ok", a bare password) keep the user's previous language; English requires positive evidence, so
Hinglish is the default for terse technical messages.

### 3.10 Context before every reply
No message is answered on its own words. Before a turn is interpreted the processor has loaded, for
that chat: the recent history in both directions (`HISTORY_MESSAGES`), every case of the customer
with the focused one marked, the message being swiped/replied to (resolved to its case, its rows
and its files), the files uploaded in this turn, the customer's memory (numbers proved earlier,
payout bank, language, form of address) and whether this is their first message of the day. The
interpreter is handed all of it — each case with what was asked (and how often), what was received
and what is still missing, the bot's last message, the replied-to message — and is told to decide
first what the conversation is about, whether an issue is pending and whether the turn continues it.
The workflows then only request what is still missing (`requestSlots`: a standing request is never
repeated for a turn that brings nothing, "kya bhejna hai?" gets the outstanding list without counting
as a new ask), a greeting goes out once per customer day (§3.10b), references such as "upar wala"
resolve against the rows of the screenshot or list they point at, and the reply language follows the
customer's. As a last check the processor compares the composed reply with the bot's previous
message in the chat: the same words, prompted by a turn that brought nothing new (no file, no
identifier, no reference, no question about what to send), are a repeat and are not sent.

### 3.10d Request-only cases
`CASE_REPLIES=request_only` (the default) turns every deposit/withdrawal case into a single
customer-facing message. After routing and the workflow run, the processor keeps only an `ask` of
mode `initial` (never `pdf_password` or `withdrawal_choice`) the first time one appears, records
`facts.requestSentAt`, and from then on empties the act list for that case: acknowledgements,
reminders, row choices, statement notices, status, "kya bhejna hai" lists, the export confirmation
and the "deposit solved" message are all dropped (the export state stays `verified`, the solved case
is still resolved). The workflows run with an unlimited ask budget and with `frustrated` cleared, so
nothing that is never sent can push a case to a human; a customer asking for a person or refusing
documents still becomes a support-group ticket, and the typing indicator is not shown in a case
that has had its request. `conversational` restores the previous behaviour end to end.

### 3.10a Deposit or withdrawal: the direction of the money
Customers almost never write "deposit" or "withdrawal". `nlu/moneyDirection.ts` reads which way the
money was meant to move from Hinglish, Hindi or English phrasing (misspellings included): money
pushed INTO the wallet that does not show ("paise add nahi hue", "payment kar diya balance nahi
aaya", "wallet me show nahi ho raha", "paise daale the", "bank se kat gaye") is a deposit; money
LEAVING the wallet that never reached the bank ("nikale", "bank me nahi aaya", "transfer nahi hua",
"wallet se paise chale gaye", "winnings", "pending") is a withdrawal. Money the customer was simply
waiting to receive ("mere paise nahi aaye", "receive nahi hua", "kaha gaye") is a payout unless
something says they paid in. Cues are weighted, a named direction beats a generic "money did not
come", and phrasings that fit both sides ("amount credit nahi hua", "payment problem") score nothing:
the bot then asks one short question ("Deposit ka issue hai ya withdrawal ka?") instead of guessing.
The same semantics are spelled out to the LLM interpreter, which also receives the deterministic cue
scores as a hint; when no case is in focus and the text names a direction outright, that reading
overrides a model that shrugged or picked the other side. Inside a case, "paise nahi aaye" is a
follow-up of that case, never a switch of type. `tests/unit/moneyDirection.test.ts` and
`tests/conversations/intent-variations.test.ts` hold the phrasing tables.

### 3.10c Admin commands and the supervisor
`/boton`, `/botoff` and `/restart` (`control/adminCommands.ts`) are accepted from the Telegram ids
in `ADMIN_TELEGRAM_IDS` messaging the account, and from the account owner in Saved Messages (the
transport routes the owner's own messages there to `onAdminCommand`); from anyone else they are
ordinary customer text. The ON/OFF state is a row in the `settings` table (`control/botSwitch.ts`),
so every worker sees it and it survives restarts. OFF pauses everything automatic: the job runner
stops claiming (a job caught mid-flight is released back untouched via `DeferJobError`, its attempt
not counted) and the maintenance worker skips its ticks, so replies, requests, greetings, folder
filing, exports, confirmations and retries all wait; messages are still received, stored and
queued. ON lets the backlog run. `/restart` goes to the process supervisor (`control/supervisor.ts`): the running
agent is stopped cleanly (jobs drained, Telegram disconnected, store closed), `.env` is re-read,
a fresh agent is booted in the same process under the same instance lock with the ON/OFF state
carried over, and only then the admin is told "✅ Bot restarted successfully." Boot failures are
retried with backoff.

### 3.11 Degraded mode
If OpenAI is unavailable the lexical interpreter and templates keep the bot functional (with lower
confidence → more conservative decisions). If the admin panel is unavailable, verification is
reported as unavailable and the case is handed off rather than guessed.

### 3.12 Chat folders: "Match issues" and "Support" (organise, never answer)
Every customer chat is kept in the one Telegram folder its **latest message** calls for, for the
human team. Nothing earlier counts, and moving never excludes a customer from either folder.

| Latest message | Folder |
|---|---|
| a match problem — wrong or late points, under review, lineup, extension, missing player, result — even next to another issue | **Match issues** (and no reply when the match is all it's about) |
| any other support matter — deposit, withdrawal, payment, account/login, technical, a general question, asking for a human — or an answer, document or "ok" inside an ongoing case | **Support** |
| small talk, a vague follow-up or an unclear message **while a match issue awaits the team** (no human has answered since it was filed) | stays in **Match issues**, no reply |
| small talk with no case behind it (hello, thanks) | neither |

`placementFor` (in `monitoring/chatFolders.ts`) makes the decision from the interpretation: LLM
primary, with `nlu/matchIssue.ts` and vision's `match_screenshot` as the degraded-mode detector. The
processor applies it on every turn, including during a human takeover (the bot reads but doesn't
reply) and on uncertain turns. A turn that fails takes the chat out of Match issues only.
A human reply — typed from the account, or relayed from the support group (not a `/note`) — takes
a chat out of whichever folder it is in (Match issues or Support); the next message files it again if needed.

Telegram is the source of truth, since the team can move chats by hand. `ChatFolders` caches
membership for a minute, so a message that leaves a chat where it already is costs no API call.
Edits rewrite a whole folder and run one at a time. A chat joins its new folder before leaving the
old one, so a failure leaves it where it was and never in no folder; the next message completes the
move. Editing keeps what a human set on a folder (icon, colour, pins). Telegram rejects an empty
folder, so a folder is deleted when its last chat leaves and recreated with the next one.

### 3.13 Reply only to unread messages
The bot answers a message only while it is still **unread** on Telegram. Once a human on the
account has read it (opened the chat on the phone or desktop), the message is theirs, whatever it
says: greeting, deposit, withdrawal or match issue. Only the latest message of a turn counts, and
the customer's cases play no part in the decision. A read message is still filed in its chat
folder, but it gets no reply, no request and no ticket, so an unread message later starts fresh.

Telegram pushes `updateReadHistoryInbox` to every session of the account when a chat is read;
`ReadTracker` (`telegram/user/readState.ts`) keeps the highest read message per chat. Sending a
message can mark a chat read too, so a read that lands while our own reply goes out (or within
3 s after) and covers nothing newer than we had received is attributed to that send. Messages that
arrived before the process was listening (recovered after a restart) are checked with
`messages.getPeerDialogs`. The processor checks before typing, again after interpretation, and
once more just before sending, so a human who opens the chat while a reply is being prepared
still gets the message. If the read state can't be fetched, a fresh message counts as unread.
`REPLY_ONLY_TO_UNREAD=false` turns the rule off. A human *reply* also pauses the bot (§3.6),
independently of this rule.

### 3.13a Any PDF is the bank statement
`EvidenceService.processPdf` classifies every PDF as `bank_statement`: a text PDF is parsed as far
as it goes (facts may be empty, note `no_statement_cues`), a scanned one is stored `unreadable`.
The file is never dropped from the case, so the export always has it; automated statement checks
simply find nothing in a PDF without statement content.

### 3.14 Evidence export and the export bot
`EXPORT_BOT_ID` names a Telegram bot the team runs. When a workflow decides a case needs humans,
the processor's export gate (`handoff/exporter.ts`) first checks **every item the bot asked for
in that case** (`facts.asks` → registration number, payment screenshot, payment video, bank
statement, withdrawal reference, UTR). With items still missing on a verification handoff the bot
keeps collecting in silence: no ticket, no reminder. If the customer stopped instead (declined,
asked for a human, limits reached), the ticket goes to the support group as before, with a note
of what never arrived, and nothing is exported.

With everything in, the exporter **forwards the original messages** as real Telegram forwards
(author kept) and nothing else — no header, no summary, no case id. Deposit: the message the number
was typed in, the payment screenshot, the payment video, the bank statement. Withdrawal: **only**
the message the Withdrawal ID was typed in (or the withdrawal-history screenshot) and the bank
statement PDF — a number typed on the side or a payment screenshot is not forwarded. In a
withdrawal case any screenshot of the app counts as the history screenshot, the way any PDF counts
as the statement; with the screenshot and the PDF in, the case is exported even when no ID could be
read from it (no row to pick). Never the conversation, greetings or stray photos. Delivery is then **verified with Telegram**
(`messages.getMessages` on the bot chat must return every forward id). Only that verified delivery
produces the agreed confirmation, exactly once per case (`facts.export.confirmed`), and the case
is `escalated` with `facts.export.status = sent`. An exported case posts **nothing** to the
support group; handoffs where the customer stopped or asked for a person (declined, human
request, limits, unreadable PDF) still become a support-group ticket, which no longer shows a
case id.

`facts.export.forwarded` (customer message id → forward id) means a retry sends only what is
missing and never duplicates a file. A failed or unverified export leaves the case open with
`status = failed`, the customer is told nothing, and it is retried by the next customer message
that reaches the workflow and by the handoff worker (every tick, once the last attempt is
2 minutes old, up to 20 attempts); the worker then sends the confirmation (outbox key
`export:<case>`). Files sent after the export are forwarded the same way, without a new
confirmation. Password-protected PDFs are forwarded as they are (the password is never sent
anywhere).

The export bot writes back. `handoff/confirmations.ts` accepts only a message containing
`PAYMENT CONFIRMED`, and picks the customer from, in order: a `User ID: <digits>` in the text (a
private chat's user id); the forwarded message the bot replied to (`facts.export.forwarded`);
the `Mobile: <10 digits>` in the text, when exactly one pending exported deposit case carries that
registration number. Anything else matches nobody and sends nothing. The customer's pending deposit case is marked `resolved`/`solved`, its
ticket closed, and a `deposit_solved` line is sent in the customer's stored language through the
outbox (key `solved:<case>`), so the same confirmation twice sends nothing twice. An unknown
User ID, a missing one, or a customer with no pending deposit case sends nothing.

## 4. Build phases

1. Telegram receiver + session management + database
2. Conversation/context engine
3. Intent/entity extraction
4. Evidence/media processing
5. Deposit workflow
6. Withdrawal workflow
7. Admin tools
8. Human handoff
9. Testing/observability

## 5. Assumptions (configurable)
- Registration number = 10-digit Indian mobile number (`REGISTRATION_NUMBER_PATTERN`).
- Withdrawal IDs match `WITHDRAWAL_ID_PATTERN` (default covers `WD-15436-64215`-style IDs).
- Admin panel structure is unknown: the Playwright gateway is driven by `config/admin.json`
  (URLs, selectors, label synonyms) so it can be pointed at the real panel without code changes.
