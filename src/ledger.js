'use strict';

const crypto = require('node:crypto');
const { errors } = require('./errors');
const { toMinor, toMajor } = require('./money');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const formatAccount = (row) => ({
  id: row.id,
  name: row.name,
  balance: toMajor(row.balance),
  created_at: row.created_at,
});

const formatTransaction = (row) => ({
  id: row.id,
  account_id: row.account_id,
  type: row.type,
  amount: toMajor(row.amount),
  description: row.description,
  reference_id: row.reference_id,
  balance_after: toMajor(row.balance_after),
  transfer_id: row.transfer_id,
  created_at: row.created_at,
});

/**
 * Domain service. All money-moving operations run inside a SQLite
 * transaction (BEGIN IMMEDIATE), so "insert transaction + update balance"
 * is a single atomic unit, and concurrent writers are serialised.
 */
function createLedger(db) {
  const q = {
    insertAccount: db.prepare(
      'INSERT INTO accounts (id, name, balance, created_at) VALUES (?, ?, 0, ?)'
    ),
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    listAccounts: db.prepare(
      'SELECT * FROM accounts ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?'
    ),
    countAccounts: db.prepare('SELECT COUNT(*) AS n FROM accounts'),
    setBalance: db.prepare('UPDATE accounts SET balance = ? WHERE id = ?'),

    findByRef: db.prepare('SELECT * FROM transactions WHERE account_id = ? AND reference_id = ?'),
    getTx: db.prepare('SELECT * FROM transactions WHERE id = ? AND account_id = ?'),
    insertTx: db.prepare(
      `INSERT INTO transactions
         (id, account_id, type, amount, description, reference_id, balance_after, transfer_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    listTx: db.prepare(
      `SELECT * FROM transactions
        WHERE account_id = @accountId AND (@type IS NULL OR type = @type)
        ORDER BY created_at DESC, seq DESC
        LIMIT @limit OFFSET @offset`
    ),
    countTx: db.prepare(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE account_id = @accountId AND (@type IS NULL OR type = @type)`
    ),
    sumTx: db.prepare(
      `SELECT COALESCE(SUM(CASE type WHEN 'credit' THEN amount ELSE -amount END), 0) AS total,
              COUNT(*) AS n
         FROM transactions WHERE account_id = ?`
    ),

    insertTransfer: db.prepare(
      `INSERT INTO transfers (id, from_account_id, to_account_id, amount, reference_id, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
  };

  const requireAccount = (id) => {
    const row = q.getAccount.get(id);
    if (!row) throw errors.accountNotFound(id);
    return row;
  };

  /** Core write path. MUST be called inside a transaction. */
  function applyTransaction(accountId, { type, amount, description, referenceId, transferId }) {
    const account = requireAccount(accountId);

    const existing = q.findByRef.get(accountId, referenceId);
    if (existing) throw errors.duplicate(formatTransaction(existing));

    const minor = toMinor(amount);
    const newBalance = type === 'credit' ? account.balance + minor : account.balance - minor;
    if (newBalance < 0) throw errors.insufficientBalance(toMajor(account.balance), amount);

    const id = uuid();
    try {
      q.insertTx.run(
        id, accountId, type, minor, description, referenceId, newBalance, transferId || null, now()
      );
    } catch (err) {
      // Safety net: the UNIQUE(account_id, reference_id) constraint caught a race.
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const dup = q.findByRef.get(accountId, referenceId);
        if (dup) throw errors.duplicate(formatTransaction(dup));
      }
      throw err;
    }
    q.setBalance.run(newBalance, accountId);

    return q.getTx.get(id, accountId);
  }

  const addTransactionTx = db.transaction((accountId, input) => {
    const row = applyTransaction(accountId, input);
    return {
      transaction: formatTransaction(row),
      account: formatAccount(q.getAccount.get(accountId)),
    };
  });

  const transferTx = db.transaction((input) => {
    const from = requireAccount(input.fromId);
    const to = requireAccount(input.toId);

    const transferId = uuid();
    q.insertTransfer.run(
      transferId, from.id, to.id, toMinor(input.amount), input.referenceId, input.description, now()
    );

    const debit = applyTransaction(from.id, {
      type: 'debit',
      amount: input.amount,
      description: input.description || `Transfer to ${to.name}`,
      referenceId: input.referenceId,
      transferId,
    });
    const credit = applyTransaction(to.id, {
      type: 'credit',
      amount: input.amount,
      description: input.description || `Transfer from ${from.name}`,
      referenceId: input.referenceId,
      transferId,
    });

    return {
      transfer: {
        id: transferId,
        from_account_id: from.id,
        to_account_id: to.id,
        amount: input.amount,
        reference_id: input.referenceId,
        description: input.description,
      },
      from_account: formatAccount(q.getAccount.get(from.id)),
      to_account: formatAccount(q.getAccount.get(to.id)),
      transactions: [formatTransaction(debit), formatTransaction(credit)],
    };
  });

  return {
    createAccount(name) {
      const id = uuid();
      q.insertAccount.run(id, name, now());
      return formatAccount(q.getAccount.get(id));
    },

    getAccount(id) {
      return formatAccount(requireAccount(id));
    },

    listAccounts({ page, limit }) {
      const total = q.countAccounts.get().n;
      const rows = q.listAccounts.all(limit, (page - 1) * limit);
      return { data: rows.map(formatAccount), pagination: paginate(page, limit, total) };
    },

    getBalance(id) {
      const account = requireAccount(id);
      return { account_id: account.id, balance: toMajor(account.balance) };
    },

    addTransaction(accountId, input) {
      return addTransactionTx.immediate(accountId, input);
    },

    getTransaction(accountId, transactionId) {
      requireAccount(accountId);
      const row = q.getTx.get(transactionId, accountId);
      if (!row) throw errors.transactionNotFound(transactionId);
      return formatTransaction(row);
    },

    listTransactions(accountId, { page, limit, type }) {
      requireAccount(accountId);
      const params = { accountId, type: type || null };
      const total = q.countTx.get(params).n;
      const rows = q.listTx.all({ ...params, limit, offset: (page - 1) * limit });
      return { data: rows.map(formatTransaction), pagination: paginate(page, limit, total) };
    },

    transfer(input) {
      return transferTx.immediate(input);
    },

    /** Recompute the balance from the transaction log and compare to the stored balance. */
    verify(accountId) {
      const account = requireAccount(accountId);
      const { total, n } = q.sumTx.get(accountId);
      return {
        account_id: account.id,
        consistent: total === account.balance,
        stored_balance: toMajor(account.balance),
        computed_balance: toMajor(total),
        transaction_count: n,
      };
    },
  };
}

function paginate(page, limit, total) {
  return {
    current_page: page,
    page_size: limit,
    total_records: total,
    total_pages: Math.ceil(total / limit),
  };
}

module.exports = { createLedger };
