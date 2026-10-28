'use strict';

/**
 * Money is stored as integer minor units (paise/cents) to avoid floating point drift.
 * The API accepts/returns decimal numbers with at most 2 decimal places.
 */
const MAX_AMOUNT = 1_000_000_000; // 1 billion per transaction

const toMinor = (major) => Math.round(major * 100);
const toMajor = (minor) => minor / 100;

/** True when `n` is a finite number with at most 2 decimal places. */
function hasValidPrecision(n) {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

module.exports = { MAX_AMOUNT, toMinor, toMajor, hasValidPrecision };
