'use strict';

const express = require('express');
const { errors } = require('./errors');
const {
  validateCreateAccount,
  validateTransaction,
  validateTransfer,
  parsePagination,
  parseTypeFilter,
} = require('./validators');

/** Responds 405 (with an Allow header) for any method not listed. */
const only = (allowed, message) => (req, res, next) => {
  res.set('Allow', allowed.join(', '));
  next(errors.methodNotAllowed(allowed, message));
};

const IMMUTABLE_MSG =
  'Transactions are immutable: they cannot be edited or deleted once created.';

function buildRouter(ledger) {
  const router = express.Router();

  router.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ── Accounts ────────────────────────────────────────────────────────────
  router
    .route('/accounts')
    .post((req, res) => {
      const { name } = validateCreateAccount(req.body);
      res.status(201).json(ledger.createAccount(name));
    })
    .get((req, res) => {
      res.json(ledger.listAccounts(parsePagination(req.query)));
    })
    .all(only(['GET', 'POST']));

  router
    .route('/accounts/:id')
    .get((req, res) => res.json(ledger.getAccount(req.params.id)))
    .all(only(['GET'], 'Accounts cannot be modified or deleted through this API.'));

  router
    .route('/accounts/:id/balance')
    .get((req, res) => res.json(ledger.getBalance(req.params.id)))
    .all(only(['GET']));

  router
    .route('/accounts/:id/verify')
    .get((req, res) => res.json(ledger.verify(req.params.id)))
    .all(only(['GET']));

  // ── Transactions ────────────────────────────────────────────────────────
  const createTransaction = (req, res) => {
    const input = validateTransaction(req.body, req.params.id);
    const result = ledger.addTransaction(input.accountId, input);
    res.status(201).json(result);
  };

  router
    .route('/accounts/:id/transactions')
    .post(createTransaction)
    .get((req, res) => {
      const { page, limit } = parsePagination(req.query);
      const type = parseTypeFilter(req.query);
      res.json(ledger.listTransactions(req.params.id, { page, limit, type }));
    })
    .all(only(['GET', 'POST']));

  router.route('/transactions').post(createTransaction).all(only(['POST']));

  router
    .route('/accounts/:id/transactions/:txId')
    .get((req, res) => res.json(ledger.getTransaction(req.params.id, req.params.txId)))
    .all(only(['GET'], IMMUTABLE_MSG));

  // ── Transfers (bonus) ───────────────────────────────────────────────────
  router
    .route('/transfers')
    .post((req, res) => {
      const input = validateTransfer(req.body);
      res.status(201).json(ledger.transfer(input));
    })
    .all(only(['POST']));

  return router;
}

module.exports = { buildRouter };
