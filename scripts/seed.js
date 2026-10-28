'use strict';

/**
 * Seeds demo data so the UI has something to show:  npm run seed
 * Safe to run more than once (it simply adds another set of accounts).
 */
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('../src/db');
const { createLedger } = require('../src/ledger');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ledger.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = openDb(file);
const ledger = createLedger(db);
const stamp = Date.now().toString(36);

const tx = (account, type, amount, description, n) =>
  ledger.addTransaction(account.id, {
    type,
    amount,
    description,
    referenceId: `SEED-${stamp}-${n}`,
  });

const asha = ledger.createAccount('Asha Raman');
const kiran = ledger.createAccount('Kiran Studio LLP');
const meera = ledger.createAccount('Meera Joseph');

tx(asha, 'credit', 85000, 'Salary — October', 1);
tx(asha, 'debit', 18500, 'House rent', 2);
tx(asha, 'debit', 2340.5, 'Groceries & household', 3);
tx(asha, 'credit', 1200, 'Refund — online order', 4);
tx(asha, 'debit', 999, 'Streaming + cloud subscriptions', 5);

tx(kiran, 'credit', 250000, 'Client invoice #1042', 1);
tx(kiran, 'credit', 120000, 'Client invoice #1043', 2);
tx(kiran, 'debit', 64000, 'Contractor payouts', 3);

ledger.transfer({
  fromId: kiran.id,
  toId: meera.id,
  amount: 15000,
  referenceId: `SEED-${stamp}-T1`,
  description: 'Design sprint payment',
});
tx(meera, 'debit', 4200, 'Co-working desk', 6);

console.log('Seeded 3 accounts with demo transactions.');
db.close();
