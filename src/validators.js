'use strict';

const { errors } = require('./errors');
const { MAX_AMOUNT, hasValidPrecision } = require('./money');

const TYPES = ['credit', 'debit'];
const MAX_NAME = 100;
const MAX_REFERENCE = 100;
const MAX_DESCRIPTION = 255;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function assertBody(body) {
  if (!isPlainObject(body)) throw errors.invalidBody();
  return body;
}

function rejectUnknown(body, allowed, problems) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      problems.push({ field: key, message: `Unknown field "${key}".` });
    }
  }
}

function checkString(body, field, problems, { required, max, defaultValue }) {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) problems.push({ field, message: `${field} is required.` });
    return defaultValue;
  }
  if (typeof value !== 'string') {
    problems.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    problems.push({ field, message: `${field} must not be empty.` });
    return undefined;
  }
  if (trimmed.length > max) {
    problems.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function checkAmount(body, field, problems) {
  const value = body[field];
  if (value === undefined || value === null) {
    problems.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push({ field, message: `${field} must be a number.` });
    return undefined;
  }
  if (value <= 0) {
    problems.push({ field, message: `${field} must be greater than 0.` });
    return undefined;
  }
  if (value > MAX_AMOUNT) {
    problems.push({ field, message: `${field} must not exceed ${MAX_AMOUNT}.` });
    return undefined;
  }
  if (!hasValidPrecision(value)) {
    problems.push({ field, message: `${field} must have at most 2 decimal places.` });
    return undefined;
  }
  return value;
}

function finish(problems, value) {
  if (problems.length) throw errors.validation(problems);
  return value;
}

/** POST /accounts */
function validateCreateAccount(rawBody) {
  const body = assertBody(rawBody);
  const problems = [];

  if ('balance' in body) {
    problems.push({
      field: 'balance',
      message: 'balance cannot be set by the client. The initial balance is always 0.',
    });
  }
  rejectUnknown(body, ['name', 'balance'], problems);
  const name = checkString(body, 'name', problems, { required: true, max: MAX_NAME });

  return finish(problems, { name });
}

/**
 * POST /accounts/:id/transactions  (or POST /transactions with account_id in the body)
 * `pathAccountId` is the id taken from the URL when present.
 */
function validateTransaction(rawBody, pathAccountId) {
  const body = assertBody(rawBody);
  const problems = [];
  rejectUnknown(body, ['account_id', 'type', 'amount', 'description', 'reference_id'], problems);

  let accountId = pathAccountId;
  if (body.account_id !== undefined) {
    if (typeof body.account_id !== 'string' || body.account_id.trim() === '') {
      problems.push({ field: 'account_id', message: 'account_id must be a non-empty string.' });
    } else if (pathAccountId && body.account_id !== pathAccountId) {
      problems.push({
        field: 'account_id',
        message: 'account_id in the body does not match the account in the URL.',
      });
    } else {
      accountId = body.account_id;
    }
  } else if (!pathAccountId) {
    problems.push({ field: 'account_id', message: 'account_id is required.' });
  }

  let type;
  if (body.type === undefined || body.type === null) {
    problems.push({ field: 'type', message: 'type is required (credit or debit).' });
  } else if (typeof body.type !== 'string' || !TYPES.includes(body.type)) {
    problems.push({ field: 'type', message: 'type must be either "credit" or "debit".' });
  } else {
    type = body.type;
  }

  const amount = checkAmount(body, 'amount', problems);
  const referenceId = checkString(body, 'reference_id', problems, {
    required: true,
    max: MAX_REFERENCE,
  });
  const description = checkString(body, 'description', problems, {
    required: false,
    max: MAX_DESCRIPTION,
    defaultValue: '',
  });

  return finish(problems, { accountId, type, amount, referenceId, description });
}

/** POST /transfers */
function validateTransfer(rawBody) {
  const body = assertBody(rawBody);
  const problems = [];
  rejectUnknown(
    body,
    ['from_account_id', 'to_account_id', 'amount', 'reference_id', 'description'],
    problems
  );

  const fromId = checkString(body, 'from_account_id', problems, { required: true, max: 100 });
  const toId = checkString(body, 'to_account_id', problems, { required: true, max: 100 });
  if (fromId && toId && fromId === toId) {
    problems.push({
      field: 'to_account_id',
      message: 'Source and destination accounts must be different.',
    });
  }
  const amount = checkAmount(body, 'amount', problems);
  const referenceId = checkString(body, 'reference_id', problems, {
    required: true,
    max: MAX_REFERENCE,
  });
  const description = checkString(body, 'description', problems, {
    required: false,
    max: MAX_DESCRIPTION,
    defaultValue: '',
  });

  return finish(problems, { fromId, toId, amount, referenceId, description });
}

function parsePositiveInt(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** ?page=1&limit=10 */
function parsePagination(query) {
  const problems = [];
  let page = 1;
  let limit = DEFAULT_LIMIT;

  if (query.page !== undefined) {
    const p = parsePositiveInt(query.page);
    if (p === null) problems.push({ field: 'page', message: 'page must be a positive integer.' });
    else page = p;
  }
  if (query.limit !== undefined) {
    const l = parsePositiveInt(query.limit);
    if (l === null || l > MAX_LIMIT) {
      problems.push({
        field: 'limit',
        message: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      });
    } else limit = l;
  }
  if (problems.length) throw errors.invalidPagination(problems);
  return { page, limit };
}

/** ?type=credit|debit (optional) */
function parseTypeFilter(query) {
  if (query.type === undefined || query.type === '') return null;
  if (typeof query.type !== 'string' || !TYPES.includes(query.type)) {
    throw errors.invalidQuery([
      { field: 'type', message: 'type must be either "credit" or "debit".' },
    ]);
  }
  return query.type;
}

module.exports = {
  validateCreateAccount,
  validateTransaction,
  validateTransfer,
  parsePagination,
  parseTypeFilter,
  TYPES,
};
