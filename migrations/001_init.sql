CREATE TABLE IF NOT EXISTS groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL,
  name       text NOT NULL,
  currency   text NOT NULL DEFAULT 'USD',
  is_demo    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  description       text NOT NULL,
  -- Integer cents. Never a float: a currency column that cannot represent
  -- "a third of ten dollars" is a feature, because neither can a wallet.
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  paid_by_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  split_mode        text NOT NULL DEFAULT 'equal'
                    CHECK (split_mode IN ('equal', 'shares', 'percent', 'exact')),
  spent_on          date NOT NULL DEFAULT CURRENT_DATE,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_group_idx ON expenses (group_id, spent_on DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id  uuid NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  share_cents bigint NOT NULL CHECK (share_cents >= 0),
  PRIMARY KEY (expense_id, member_id)
);

CREATE TABLE IF NOT EXISTS settlements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  from_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  to_member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  note           text NOT NULL DEFAULT '',
  settled_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (from_member_id <> to_member_id)
);
CREATE INDEX IF NOT EXISTS settlements_group_idx ON settlements (group_id, settled_at DESC);
