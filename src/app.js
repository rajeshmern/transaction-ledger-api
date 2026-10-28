'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { createLedger } = require('./ledger');
const { buildRouter } = require('./routes');
const { AppError, errors } = require('./errors');

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'ledger.db');

function createApp({ dbFile = process.env.DB_PATH || DEFAULT_DB, silent = false } = {}) {
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const db = openDb(dbFile);
  const ledger = createLedger(db);

  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.ledger = ledger;

  app.use(express.json({ limit: '100kb' }));
  app.use('/api', buildRouter(ledger));
  app.use('/api', (req, res, next) =>
    next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl}.`))
  );

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res, next) =>
    next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl}.`))
  );

  // Centralised error handler -> one consistent error shape.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let appErr = err;

    if (!(err instanceof AppError)) {
      if (err && err.type === 'entity.parse.failed') {
        appErr = errors.invalidBody('Request body contains malformed JSON.');
      } else if (err && err.type === 'entity.too.large') {
        appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      } else if (err && err.status >= 400 && err.status < 500) {
        appErr = errors.invalidBody('Request could not be processed.');
      } else {
        if (!silent) console.error(err);
        appErr = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. No changes were saved.');
      }
    }

    const body = { error: { code: appErr.code, message: appErr.message } };
    if (appErr.details !== undefined) body.error.details = appErr.details;
    res.status(appErr.status).json(body);
  });

  return app;
}

module.exports = { createApp };
