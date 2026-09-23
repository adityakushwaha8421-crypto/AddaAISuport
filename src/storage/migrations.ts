/**
 * Ordered, append-only schema migrations. Never edit an applied migration — add a new one.
 * Kept in TS (not .sql files) so the compiled build is self-contained.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE users (
  id                    text PRIMARY KEY,
  chat_id               text NOT NULL,
  username              text,
  first_name            text,
  language_code         text,
  preferred_language    text,
  human_takeover_until  timestamptz,
  focus_case_id         uuid,
  memory                jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id                    uuid PRIMARY KEY,
  chat_id               text NOT NULL,
  user_id               text NOT NULL,
  telegram_message_id   bigint NOT NULL,
  direction             text NOT NULL,
  text                  text,
  caption               text,
  media                 jsonb NOT NULL DEFAULT '[]',
  reply_to_message_id   bigint,
  case_id               uuid,
  turn_id               uuid,
  meta                  jsonb NOT NULL DEFAULT '{}',
  processed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_direction_chk CHECK (direction IN ('in', 'out')),
  CONSTRAINT messages_dedup UNIQUE (chat_id, telegram_message_id, direction)
);
CREATE INDEX messages_chat_created_idx ON messages (chat_id, created_at);
CREATE INDEX messages_unprocessed_idx ON messages (direction, processed_at, created_at);

CREATE TABLE turns (
  id                    uuid PRIMARY KEY,
  chat_id               text NOT NULL,
  user_id               text NOT NULL,
  message_ids           jsonb NOT NULL DEFAULT '[]',
  status                text NOT NULL,
  case_id               uuid,
  trace                 jsonb NOT NULL DEFAULT '{}',
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);
CREATE INDEX turns_status_created_idx ON turns (status, created_at);

CREATE TABLE cases (
  id                    uuid PRIMARY KEY,
  user_id               text NOT NULL,
  chat_id               text NOT NULL,
  type                  text NOT NULL,
  status                text NOT NULL,
  step                  text NOT NULL,
  registration_number   text,
  withdrawal_id         text,
  order_id              text,
  amount                numeric(14, 2),
  txn_time              text,
  utr                   text,
  confidence            real NOT NULL DEFAULT 0,
  missing               jsonb NOT NULL DEFAULT '[]',
  escalation            text NOT NULL DEFAULT 'none',
  facts                 jsonb NOT NULL DEFAULT '{}',
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_activity_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_user_status_idx ON cases (user_id, status);
CREATE INDEX cases_activity_idx ON cases (status, last_activity_at);
CREATE INDEX cases_withdrawal_idx ON cases (withdrawal_id);
CREATE INDEX cases_registration_idx ON cases (registration_number);

CREATE TABLE evidence (
  id                    uuid PRIMARY KEY,
  user_id               text NOT NULL,
  chat_id               text NOT NULL,
  case_id               uuid,
  message_id            bigint NOT NULL,
  media_kind            text NOT NULL,
  file_ref              text NOT NULL,
  file_unique_id        text,
  mime_type             text,
  file_name             text,
  sha256                text,
  category              text NOT NULL,
  category_confidence   real NOT NULL DEFAULT 0,
  status                text NOT NULL,
  transcript            text,
  extracted             jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_user_file_idx ON evidence (user_id, file_unique_id);
CREATE INDEX evidence_user_sha_idx ON evidence (user_id, sha256);
CREATE INDEX evidence_message_idx ON evidence (chat_id, message_id);

CREATE TABLE tickets (
  id                    uuid PRIMARY KEY,
  case_id               uuid NOT NULL,
  -- equals case_id while the ticket is open, NULL once closed: enforces one open ticket per case
  open_case_id          uuid UNIQUE,
  user_id               text NOT NULL,
  chat_id               text NOT NULL,
  reason                text NOT NULL,
  summary               jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL,
  attempts              integer NOT NULL DEFAULT 0,
  support_chat_id       text,
  support_message_id    bigint,
  last_error            text,
  user_notified         boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz
);
CREATE INDEX tickets_status_idx ON tickets (status);
CREATE INDEX tickets_support_msg_idx ON tickets (support_chat_id, support_message_id);

CREATE TABLE outbox (
  id                    uuid PRIMARY KEY,
  key                   text NOT NULL UNIQUE,
  chat_id               text NOT NULL,
  user_id               text,
  text                  text NOT NULL,
  reply_to_message_id   bigint,
  meta                  jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL,
  attempts              integer NOT NULL DEFAULT 0,
  telegram_message_id   bigint,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz
);
CREATE INDEX outbox_status_idx ON outbox (status);
`,
  },
  {
    id: '002_jobs',
    sql: `
CREATE TABLE jobs (
  id               bigserial PRIMARY KEY,
  type             text NOT NULL,
  ordering_key     text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  payload          jsonb NOT NULL DEFAULT '{}',
  run_at           timestamptz NOT NULL DEFAULT now(),
  attempts         int NOT NULL DEFAULT 0,
  worker           text,
  leased_until     timestamptz,
  last_error       text,
  idempotency_key  text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (status, run_at, id);
CREATE INDEX jobs_key_idx ON jobs (ordering_key, status);
CREATE INDEX jobs_lease_idx ON jobs (status, leased_until);
`,
  },
  {
    id: '003_settings',
    sql: `
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: '004_evidence_requests',
    sql: `
CREATE TABLE evidence_requests (
  id                   uuid PRIMARY KEY,
  chat_id              text NOT NULL,
  user_id              text NOT NULL,
  issue_type           text NOT NULL,
  language             text NOT NULL,
  status               text NOT NULL,
  telegram_message_id  bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  solved_at            timestamptz
);
CREATE INDEX evidence_requests_chat_idx ON evidence_requests (chat_id, status, created_at);
CREATE INDEX evidence_requests_user_idx ON evidence_requests (user_id, status);
`,
  },
];
