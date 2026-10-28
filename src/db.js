'use strict';

const Database = require('better-sqlite3');

/**
 * Schema notes (data integrity lives in the database, not just in application code):
 *  - balances can never go negative            -> CHECK (balance >= 0)
 *  - amounts are always positive               -> CHECK (amount > 0)
 *  - type is only credit/debit                 -> CHECK (type IN (...))
 *  - reference_id unique per account           -> UNIQUE (account_id, reference_id)
 *  - transactions are append-only (immutable)  -> BEFORE UPDATE / DELETE triggers abort
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id               TEXT PRIMARY KEY,
  from_account_id  TEXT NOT NULL REFERENCES accounts(id),
  to_account_id    TEXT NOT NULL REFERENCES accounts(id),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  reference_id     TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  CHECK (from_account_id <> to_account_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  type           TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  description    TEXT NOT NULL DEFAULT '',
  reference_id   TEXT NOT NULL CHECK (length(trim(reference_id)) > 0),
  balance_after  INTEGER NOT NULL CHECK (balance_after >= 0),
  transfer_id    TEXT REFERENCES transfers(id),
  created_at     TEXT NOT NULL,
  UNIQUE (account_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_tx_account_type_seq ON transactions (account_id, type, seq DESC);
CREATE INDEX IF NOT EXISTS idx_tx_account_created  ON transactions (account_id, created_at DESC, seq DESC);

CREATE TRIGGER IF NOT EXISTS transactions_no_update
BEFORE UPDATE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS transactions_no_delete
BEFORE DELETE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are immutable');
END;
`;

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
