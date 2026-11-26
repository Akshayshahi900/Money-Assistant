-- ===== Source data (synthetic, read-only for the assistant) =====
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('savings','credit_card','wallet')),
  opening_balance REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, upi_id TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  timestamp TEXT NOT NULL,                       -- ISO 8601, +05:30 (IST)
  amount REAL NOT NULL CHECK (amount > 0),
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  raw_description TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  merchant TEXT,
  category TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_ts ON transactions(timestamp);

-- ===== Derived views: THE single definition of "what counts as spending" =====
-- Every number shown to the user is computed from these views.
DROP VIEW IF EXISTS txn_flagged;
CREATE VIEW txn_flagged AS
SELECT t.*,
  -- own-account movements: card bill payments, wallet loads, self transfers
  CASE WHEN raw_description LIKE '%CC BILL PAY%' OR raw_description LIKE '%PAYMENT RECEIVED%'
         OR raw_description LIKE '%SELF TRANSFER%' OR raw_description LIKE '%WALLET LOAD%'
       THEN 1 ELSE 0 END AS is_transfer,
  -- same account+description+amount+direction within 10 minutes of the previous one
  CASE WHEN (julianday(timestamp) - julianday(LAG(timestamp) OVER w)) * 86400 <= 600
       THEN 1 ELSE 0 END AS is_duplicate,
  CASE WHEN direction='credit' AND (raw_description LIKE '%REFUND%' OR raw_description LIKE '%REVERSAL%')
       THEN 1 ELSE 0 END AS is_refund
FROM transactions t
WINDOW w AS (PARTITION BY account_id, raw_description, amount, direction ORDER BY timestamp, id);

-- Spending events: real debits (positive) and refunds (negative), no transfers, no duplicates
DROP VIEW IF EXISTS spend_events;
CREATE VIEW spend_events AS
SELECT id, account_id, timestamp, substr(timestamp,1,10) AS day,
       COALESCE(category,'Uncategorised') AS category, merchant, raw_description, payment_mode,
       CASE WHEN direction='debit' THEN amount ELSE -amount END AS net_amount
FROM txn_flagged
WHERE is_transfer=0 AND is_duplicate=0 AND (direction='debit' OR is_refund=1);

-- ===== Assistant-owned state =====
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  state_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS messages (            -- chat transcript + rendered UI, replayed on refresh
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','action')),
  text TEXT,
  ui_json TEXT,                                   -- validated UI spec (JSON) or NULL
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_actions (     -- drafts awaiting explicit user confirmation
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  kind TEXT NOT NULL,                             -- 'create_budget' | 'create_group'
  draft_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','cancelled')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, monthly_limit REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
  PRIMARY KEY (group_id, contact_id)
);
CREATE TABLE IF NOT EXISTS group_transactions (
  group_id TEXT NOT NULL REFERENCES groups(id), transaction_id TEXT NOT NULL REFERENCES transactions(id),
  PRIMARY KEY (group_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS group_manual_expenses (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  amount REAL NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goals (                -- savings goals created from a confirmed plan
  id TEXT PRIMARY KEY, item TEXT NOT NULL, price REAL NOT NULL, target_month TEXT NOT NULL,
  monthly_saving REAL NOT NULL, created_at TEXT NOT NULL
);
