'use strict';

/**
 * Application error carrying an HTTP status and a machine-readable code.
 * Every error response in the API has the same shape:
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  validation: (fields) =>
    new AppError(400, 'VALIDATION_ERROR', 'Request validation failed.', { fields }),
  invalidBody: (message = 'Request body must be a valid JSON object.') =>
    new AppError(400, 'INVALID_REQUEST_BODY', message),
  invalidPagination: (fields) =>
    new AppError(400, 'INVALID_PAGINATION', 'Invalid pagination parameters.', { fields }),
  invalidQuery: (fields) =>
    new AppError(400, 'INVALID_QUERY', 'Invalid query parameters.', { fields }),
  accountNotFound: (accountId) =>
    new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.', { account_id: accountId }),
  transactionNotFound: (transactionId) =>
    new AppError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.', {
      transaction_id: transactionId,
    }),
  insufficientBalance: (balance, amount) =>
    new AppError(422, 'INSUFFICIENT_BALANCE', 'Insufficient balance for this debit.', {
      balance,
      requested: amount,
    }),
  duplicate: (transaction) =>
    new AppError(
      409,
      'DUPLICATE_TRANSACTION',
      'A transaction with this reference_id already exists for this account. No changes were made.',
      { transaction }
    ),
  methodNotAllowed: (allowed, message) =>
    new AppError(405, 'METHOD_NOT_ALLOWED', message || 'Method not allowed.', { allowed }),
};

module.exports = { AppError, errors };
