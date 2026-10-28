'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let baseUrl;
let db;

before(async () => {
  const app = createApp({ dbFile: ':memory:', silent: true });
  db = app.locals.db;
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

// ── helpers ───────────────────────────────────────────────────────────────
async function call(method, path, body, { raw } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json, headers: res.headers };
}

const newAccount = async (name = 'Test User') => (await call('POST', '/api/accounts', { name })).body;
const tx = (accountId, type, amount, ref, extra = {}) =>
  call('POST', `/api/accounts/${accountId}/transactions`, {
    type,
    amount,
    reference_id: ref,
    description: `${type} ${amount}`,
    ...extra,
  });
const balanceOf = async (id) => (await call('GET', `/api/accounts/${id}/balance`)).body.balance;
const txCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(id).n;

const assertErrorShape = (res, status, code) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code);
  assert.equal(typeof res.body.error.message, 'string');
};

// ── 1. Create account ─────────────────────────────────────────────────────
describe('1. Create account', () => {
  test('creates an account with id, name, balance 0 and a system timestamp', async () => {
    const res = await call('POST', '/api/accounts', { name: 'Asha' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Asha');
    assert.equal(res.body.balance, 0);
    assert.ok(res.body.id);
    assert.ok(!Number.isNaN(Date.parse(res.body.created_at)));
  });

  test('trims the name', async () => {
    const res = await call('POST', '/api/accounts', { name: '   Meera   ' });
    assert.equal(res.body.name, 'Meera');
  });

  test('ids are unique', async () => {
    const a = await newAccount('A');
    const b = await newAccount('A');
    assert.notEqual(a.id, b.id);
  });

  test('name is required', async () => {
    assertErrorShape(await call('POST', '/api/accounts', {}), 400, 'VALIDATION_ERROR');
  });

  test('blank / non-string / too-long names are rejected', async () => {
    assertErrorShape(await call('POST', '/api/accounts', { name: '   ' }), 400, 'VALIDATION_ERROR');
    assertErrorShape(await call('POST', '/api/accounts', { name: 42 }), 400, 'VALIDATION_ERROR');
    assertErrorShape(
      await call('POST', '/api/accounts', { name: 'x'.repeat(101) }),
      400,
      'VALIDATION_ERROR'
    );
  });

  test('client cannot set the initial balance', async () => {
    const res = await call('POST', '/api/accounts', { name: 'Sneaky', balance: 1000 });
    assertErrorShape(res, 400, 'VALIDATION_ERROR');
    assert.equal(res.body.error.details.fields[0].field, 'balance');
  });

  test('client cannot set id or created_at either (unknown fields)', async () => {
    const res = await call('POST', '/api/accounts', { name: 'X', id: 'my-id', created_at: '2000-01-01' });
    assertErrorShape(res, 400, 'VALIDATION_ERROR');
  });

  test('malformed JSON and non-object bodies -> INVALID_REQUEST_BODY', async () => {
    assertErrorShape(
      await call('POST', '/api/accounts', undefined, { raw: '{ not json' }),
      400,
      'INVALID_REQUEST_BODY'
    );
    assertErrorShape(await call('POST', '/api/accounts', [1, 2]), 400, 'INVALID_REQUEST_BODY');
  });
});

// ── 2. Add transaction ────────────────────────────────────────────────────
describe('2. Add transaction (credit / debit / duplicates)', () => {
  test('credit increases the balance (100 + 50 = 150)', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 100, 'c1');
    const res = await tx(acc.id, 'credit', 50, 'c2');
    assert.equal(res.status, 201);
    assert.equal(res.body.transaction.type, 'credit');
    assert.equal(res.body.transaction.amount, 50);
    assert.equal(res.body.transaction.balance_after, 150);
    assert.equal(res.body.account.balance, 150);
    assert.equal(await balanceOf(acc.id), 150);
  });

  test('debit decreases the balance (100 - 30 = 70)', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 100, 'c1');
    const res = await tx(acc.id, 'debit', 30, 'd1');
    assert.equal(res.status, 201);
    assert.equal(await balanceOf(acc.id), 70);
  });

  test('transaction has all required fields', async () => {
    const acc = await newAccount();
    const res = await tx(acc.id, 'credit', 10, 'ref-x', { description: 'hello' });
    const t = res.body.transaction;
    assert.ok(t.id);
    assert.equal(t.account_id, acc.id);
    assert.equal(t.type, 'credit');
    assert.equal(t.amount, 10);
    assert.equal(t.description, 'hello');
    assert.equal(t.reference_id, 'ref-x');
    assert.ok(!Number.isNaN(Date.parse(t.created_at)));
  });

  test('debit with insufficient balance is rejected and balance is unchanged (100 - 150)', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 100, 'c1');
    const res = await tx(acc.id, 'debit', 150, 'd1');
    assertErrorShape(res, 422, 'INSUFFICIENT_BALANCE');
    assert.equal(res.body.error.details.balance, 100);
    assert.equal(await balanceOf(acc.id), 100);
    assert.equal(txCount(acc.id), 1, 'rejected debit must not be stored');
  });

  test('debit of the exact balance is allowed and leaves 0', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 40, 'c1');
    assert.equal((await tx(acc.id, 'debit', 40, 'd1')).status, 201);
    assert.equal(await balanceOf(acc.id), 0);
  });

  test('debit on an empty account is rejected', async () => {
    const acc = await newAccount();
    assertErrorShape(await tx(acc.id, 'debit', 0.01, 'd1'), 422, 'INSUFFICIENT_BALANCE');
  });

  test('decimal amounts are exact (no floating point drift)', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 0.1, 'a');
    await tx(acc.id, 'credit', 0.2, 'b');
    assert.equal(await balanceOf(acc.id), 0.3);
    await tx(acc.id, 'debit', 0.3, 'c');
    assert.equal(await balanceOf(acc.id), 0);
  });

  test('POST /api/transactions works with account_id in the body', async () => {
    const acc = await newAccount();
    const res = await call('POST', '/api/transactions', {
      account_id: acc.id,
      type: 'credit',
      amount: 25,
      reference_id: 'body-ref',
    });
    assert.equal(res.status, 201);
    assert.equal(await balanceOf(acc.id), 25);
  });

  describe('duplicate reference_id', () => {
    test('same reference_id on the same account -> 409, no new tx, balance unchanged', async () => {
      const acc = await newAccount();
      const first = await tx(acc.id, 'credit', 100, 'dup-1');
      const again = await tx(acc.id, 'credit', 100, 'dup-1');
      assertErrorShape(again, 409, 'DUPLICATE_TRANSACTION');
      assert.equal(again.body.error.details.transaction.id, first.body.transaction.id);
      assert.equal(await balanceOf(acc.id), 100);
      assert.equal(txCount(acc.id), 1);
    });

    test('duplicate is detected even if type/amount differ', async () => {
      const acc = await newAccount();
      await tx(acc.id, 'credit', 100, 'dup-2');
      assertErrorShape(await tx(acc.id, 'debit', 5, 'dup-2'), 409, 'DUPLICATE_TRANSACTION');
      assert.equal(await balanceOf(acc.id), 100);
    });

    test('the same reference_id may be used on different accounts', async () => {
      const a = await newAccount('A');
      const b = await newAccount('B');
      assert.equal((await tx(a.id, 'credit', 10, 'shared')).status, 201);
      assert.equal((await tx(b.id, 'credit', 10, 'shared')).status, 201);
    });

    test('10 parallel requests with one reference_id create exactly one transaction', async () => {
      const acc = await newAccount();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => tx(acc.id, 'credit', 10, 'race-ref'))
      );
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 9);
      assert.equal(await balanceOf(acc.id), 10);
    });
  });
});

// ── 3. Balance ────────────────────────────────────────────────────────────
describe('3. Get account balance', () => {
  test('returns account_id and balance', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 12.5, 'c1');
    const res = await call('GET', `/api/accounts/${acc.id}/balance`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { account_id: acc.id, balance: 12.5 });
  });

  test('unknown account -> 404 ACCOUNT_NOT_FOUND', async () => {
    assertErrorShape(await call('GET', '/api/accounts/nope/balance'), 404, 'ACCOUNT_NOT_FOUND');
  });
});

// ── 4. History ────────────────────────────────────────────────────────────
describe('4. Transaction history (filter / pagination / sorting)', () => {
  let acc;
  beforeEach(async () => {
    acc = await newAccount('History');
    // 12 transactions: 8 credits, 4 debits, inserted in order r1..r12
    for (let i = 1; i <= 8; i++) await tx(acc.id, 'credit', 100, `r${i}`);
    for (let i = 9; i <= 12; i++) await tx(acc.id, 'debit', 10, `r${i}`);
  });

  test('returns both types by default, latest first', async () => {
    const res = await call('GET', `/api/accounts/${acc.id}/transactions?limit=100`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 12);
    assert.deepEqual(
      res.body.data.map((t) => t.reference_id),
      ['r12', 'r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4', 'r3', 'r2', 'r1']
    );
    const times = res.body.data.map((t) => t.created_at);
    assert.deepEqual([...times].sort().reverse(), times, 'created_at must be descending');
  });

  test('filters by credit / debit', async () => {
    const credits = await call('GET', `/api/accounts/${acc.id}/transactions?type=credit&limit=100`);
    assert.equal(credits.body.data.length, 8);
    assert.ok(credits.body.data.every((t) => t.type === 'credit'));
    assert.equal(credits.body.pagination.total_records, 8);

    const debits = await call('GET', `/api/accounts/${acc.id}/transactions?type=debit`);
    assert.equal(debits.body.data.length, 4);
    assert.ok(debits.body.data.every((t) => t.type === 'debit'));
  });

  test('default pagination metadata', async () => {
    const res = await call('GET', `/api/accounts/${acc.id}/transactions`);
    assert.deepEqual(res.body.pagination, {
      current_page: 1,
      page_size: 10,
      total_records: 12,
      total_pages: 2,
    });
    assert.equal(res.body.data.length, 10);
  });

  test('page 2 with limit 5 returns the right slice', async () => {
    const res = await call('GET', `/api/accounts/${acc.id}/transactions?page=2&limit=5`);
    assert.deepEqual(
      res.body.data.map((t) => t.reference_id),
      ['r7', 'r6', 'r5', 'r4', 'r3']
    );
    assert.deepEqual(res.body.pagination, {
      current_page: 2,
      page_size: 5,
      total_records: 12,
      total_pages: 3,
    });
  });

  test('a page beyond the last page returns an empty list with metadata', async () => {
    const res = await call('GET', `/api/accounts/${acc.id}/transactions?page=9&limit=5`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.pagination.total_pages, 3);
  });

  test('filter + pagination combine', async () => {
    const res = await call('GET', `/api/accounts/${acc.id}/transactions?type=credit&page=2&limit=3`);
    assert.deepEqual(
      res.body.data.map((t) => t.reference_id),
      ['r5', 'r4', 'r3']
    );
    assert.equal(res.body.pagination.total_pages, 3);
  });

  test('invalid pagination parameters -> 400 INVALID_PAGINATION', async () => {
    for (const q of ['page=0', 'page=-1', 'page=abc', 'limit=0', 'limit=101', 'limit=1.5', 'page=1e2']) {
      assertErrorShape(
        await call('GET', `/api/accounts/${acc.id}/transactions?${q}`),
        400,
        'INVALID_PAGINATION'
      );
    }
  });

  test('invalid type filter -> 400 INVALID_QUERY', async () => {
    assertErrorShape(
      await call('GET', `/api/accounts/${acc.id}/transactions?type=refund`),
      400,
      'INVALID_QUERY'
    );
  });

  test('unknown account -> 404', async () => {
    assertErrorShape(await call('GET', '/api/accounts/ghost/transactions'), 404, 'ACCOUNT_NOT_FOUND');
  });

  test('one account never sees another account’s transactions', async () => {
    const other = await newAccount('Other');
    await tx(other.id, 'credit', 1, 'only-other');
    const res = await call('GET', `/api/accounts/${acc.id}/transactions?limit=100`);
    assert.ok(res.body.data.every((t) => t.account_id === acc.id));
  });
});

// ── 5. Data integrity ─────────────────────────────────────────────────────
describe('5. Data integrity', () => {
  test('transactions cannot be edited or deleted through the API (405)', async () => {
    const acc = await newAccount();
    const { body } = await tx(acc.id, 'credit', 10, 'imm');
    const url = `/api/accounts/${acc.id}/transactions/${body.transaction.id}`;
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await call(method, url, method === 'DELETE' ? undefined : { amount: 999 });
      assertErrorShape(res, 405, 'METHOD_NOT_ALLOWED');
      assert.equal(res.headers.get('allow'), 'GET');
    }
    assertErrorShape(await call('DELETE', `/api/accounts/${acc.id}/transactions`), 405, 'METHOD_NOT_ALLOWED');
    assertErrorShape(await call('DELETE', `/api/accounts/${acc.id}`), 405, 'METHOD_NOT_ALLOWED');

    const after = await call('GET', url);
    assert.equal(after.body.amount, 10);
    assert.equal(await balanceOf(acc.id), 10);
  });

  test('the database itself refuses UPDATE / DELETE on transactions (triggers)', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 10, 'trg');
    assert.throws(() => db.prepare('UPDATE transactions SET amount = 1 WHERE account_id = ?').run(acc.id), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM transactions WHERE account_id = ?').run(acc.id), /immutable/);
    assert.equal(txCount(acc.id), 1);
  });

  test('database constraints block bad data even if the API were bypassed', async () => {
    const acc = await newAccount();
    const insert = (type, amount, ref, bal = 0) =>
      db
        .prepare(
          `INSERT INTO transactions (id, account_id, type, amount, description, reference_id, balance_after, created_at)
           VALUES (?, ?, ?, ?, '', ?, ?, ?)`
        )
        .run(`id-${Math.random()}`, acc.id, type, amount, ref, bal, new Date().toISOString());
    assert.throws(() => insert('refund', 1, 'x1'), /CHECK/);
    assert.throws(() => insert('credit', 0, 'x2'), /CHECK/);
    assert.throws(() => insert('credit', -5, 'x3'), /CHECK/);
    insert('credit', 1, 'x4', 1);
    assert.throws(() => insert('credit', 1, 'x4', 2), /UNIQUE/);
    assert.throws(() => db.prepare('UPDATE accounts SET balance = -1 WHERE id = ?').run(acc.id), /CHECK/);
    assert.throws(
      () => db.prepare('INSERT INTO transactions (id, account_id, type, amount, reference_id, balance_after, created_at) VALUES (?,?,?,?,?,?,?)')
        .run('orphan', 'no-such-account', 'credit', 1, 'o', 1, 'now'),
      /FOREIGN KEY/
    );
  });

  test('balance equals the result of all valid transactions (100+50-30-20 = 100)', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 100, 'a');
    await tx(acc.id, 'credit', 50, 'b');
    await tx(acc.id, 'debit', 30, 'c');
    await tx(acc.id, 'debit', 20, 'd');
    await tx(acc.id, 'debit', 9999, 'rejected'); // must not count
    await tx(acc.id, 'credit', 100, 'a'); // duplicate, must not count
    assert.equal(await balanceOf(acc.id), 100);

    const v = await call('GET', `/api/accounts/${acc.id}/verify`);
    assert.deepEqual(v.body, {
      account_id: acc.id,
      consistent: true,
      stored_balance: 100,
      computed_balance: 100,
      transaction_count: 4,
    });
  });

  test('balance_after on each transaction forms a correct running balance', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 100, 'a');
    await tx(acc.id, 'debit', 30, 'b');
    await tx(acc.id, 'credit', 5, 'c');
    const res = await call('GET', `/api/accounts/${acc.id}/transactions`);
    assert.deepEqual(res.body.data.map((t) => t.balance_after), [75, 70, 100]);
  });

  test('atomicity: if the balance update fails, the transaction row is rolled back too', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 100, 'seed');
    db.exec(`CREATE TRIGGER boom_balance BEFORE UPDATE OF balance ON accounts
             WHEN NEW.id = '${acc.id}' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    try {
      const res = await tx(acc.id, 'credit', 50, 'will-fail');
      assertErrorShape(res, 500, 'INTERNAL_ERROR');
    } finally {
      db.exec('DROP TRIGGER boom_balance');
    }
    assert.equal(await balanceOf(acc.id), 100);
    assert.equal(txCount(acc.id), 1, 'no orphan transaction may remain');
    // and the reference can be reused afterwards because nothing was persisted
    assert.equal((await tx(acc.id, 'credit', 50, 'will-fail')).status, 201);
  });

  test('concurrency: 20 parallel debits of 10 against a balance of 100 -> exactly 10 succeed, never overdrawn', async () => {
    const acc = await newAccount();
    await tx(acc.id, 'credit', 100, 'seed');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => tx(acc.id, 'debit', 10, `par-${i}`))
    );
    assert.equal(results.filter((r) => r.status === 201).length, 10);
    assert.equal(results.filter((r) => r.status === 422).length, 10);
    assert.equal(await balanceOf(acc.id), 0);
    assert.equal((await call('GET', `/api/accounts/${acc.id}/verify`)).body.consistent, true);
  });
});

// ── 7. Validations & 8. Error handling ────────────────────────────────────
describe('7/8. Validation & error handling', () => {
  let acc;
  beforeEach(async () => {
    acc = await newAccount('Validate');
  });

  test('transaction on a non-existent account -> 404 ACCOUNT_NOT_FOUND', async () => {
    assertErrorShape(await tx('does-not-exist', 'credit', 10, 'r'), 404, 'ACCOUNT_NOT_FOUND');
    const viaBody = await call('POST', '/api/transactions', {
      account_id: 'does-not-exist',
      type: 'credit',
      amount: 1,
      reference_id: 'r',
    });
    assertErrorShape(viaBody, 404, 'ACCOUNT_NOT_FOUND');
  });

  test('invalid transaction type', async () => {
    for (const type of ['refund', 'CREDIT', 5, null, '']) {
      const res = await call('POST', `/api/accounts/${acc.id}/transactions`, {
        type,
        amount: 10,
        reference_id: 'r',
      });
      assertErrorShape(res, 400, 'VALIDATION_ERROR');
      assert.ok(res.body.error.details.fields.some((f) => f.field === 'type'));
    }
  });

  test('invalid amounts', async () => {
    const bad = [0, -1, -0.01, '10', null, true, [], {}, 1.005, 1e12, Infinity];
    for (const amount of bad) {
      const res = await call('POST', `/api/accounts/${acc.id}/transactions`, {
        type: 'credit',
        amount,
        reference_id: 'r',
      });
      assertErrorShape(res, 400, 'VALIDATION_ERROR');
      assert.ok(
        res.body.error.details.fields.some((f) => f.field === 'amount'),
        `amount ${String(amount)} should fail on the amount field`
      );
    }
    assert.equal(await balanceOf(acc.id), 0);
  });

  test('missing amount', async () => {
    const res = await call('POST', `/api/accounts/${acc.id}/transactions`, { type: 'credit', reference_id: 'r' });
    assertErrorShape(res, 400, 'VALIDATION_ERROR');
  });

  test('reference_id is required (missing / blank / non-string)', async () => {
    for (const reference_id of [undefined, '', '   ', 7]) {
      const res = await call('POST', `/api/accounts/${acc.id}/transactions`, {
        type: 'credit',
        amount: 10,
        reference_id,
      });
      assertErrorShape(res, 400, 'VALIDATION_ERROR');
      assert.ok(res.body.error.details.fields.some((f) => f.field === 'reference_id'));
    }
  });

  test('all field errors are reported together', async () => {
    const res = await call('POST', `/api/accounts/${acc.id}/transactions`, { type: 'x', amount: -1 });
    const fields = res.body.error.details.fields.map((f) => f.field).sort();
    assert.deepEqual(fields, ['amount', 'reference_id', 'type']);
  });

  test('unknown fields and mismatching account_id are rejected', async () => {
    assertErrorShape(
      await tx(acc.id, 'credit', 10, 'r', { balance_after: 1_000_000 }),
      400,
      'VALIDATION_ERROR'
    );
    assertErrorShape(await tx(acc.id, 'credit', 10, 'r2', { account_id: 'someone-else' }), 400, 'VALIDATION_ERROR');
  });

  test('missing body / malformed JSON on transactions -> 400', async () => {
    assertErrorShape(await call('POST', `/api/accounts/${acc.id}/transactions`), 400, 'VALIDATION_ERROR');
    assertErrorShape(
      await call('POST', `/api/accounts/${acc.id}/transactions`, undefined, { raw: '{"type":' }),
      400,
      'INVALID_REQUEST_BODY'
    );
  });

  test('validation runs before the account lookup (bad body on unknown account -> 400)', async () => {
    assertErrorShape(await call('POST', '/api/accounts/ghost/transactions', {}), 400, 'VALIDATION_ERROR');
  });

  test('unknown routes return the standard JSON error', async () => {
    assertErrorShape(await call('GET', '/api/nope'), 404, 'ROUTE_NOT_FOUND');
    assertErrorShape(await call('GET', '/definitely-not-a-file'), 404, 'ROUTE_NOT_FOUND');
  });

  test('GET /api/accounts/:id returns the account; unknown -> 404', async () => {
    const res = await call('GET', `/api/accounts/${acc.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, acc.id);
    assertErrorShape(await call('GET', '/api/accounts/ghost'), 404, 'ACCOUNT_NOT_FOUND');
  });

  test('GET /api/accounts is paginated and validated', async () => {
    const res = await call('GET', '/api/accounts?limit=2');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length <= 2);
    assert.ok(res.body.pagination.total_records >= 1);
    assertErrorShape(await call('GET', '/api/accounts?page=0'), 400, 'INVALID_PAGINATION');
  });

  test('health check', async () => {
    assert.deepEqual((await call('GET', '/api/health')).body, { status: 'ok' });
  });

  test('the web UI is served at /', async () => {
    const res = await fetch(baseUrl + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Folio/);
  });
});

// ── 9. Transfers ──────────────────────────────────────────────────────────
describe('9. Money transfer (bonus)', () => {
  let a;
  let b;
  const transfer = (body) => call('POST', '/api/transfers', body);

  beforeEach(async () => {
    a = await newAccount('Account A');
    b = await newAccount('Account B');
    await tx(a.id, 'credit', 100, 'seed-a');
    await tx(b.id, 'credit', 50, 'seed-b');
  });

  test('moves money: A 100→70, B 50→80', async () => {
    const res = await transfer({
      from_account_id: a.id,
      to_account_id: b.id,
      amount: 30,
      reference_id: 't1',
      description: 'rent share',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.from_account.balance, 70);
    assert.equal(res.body.to_account.balance, 80);
    assert.equal(await balanceOf(a.id), 70);
    assert.equal(await balanceOf(b.id), 80);

    const [debit, credit] = res.body.transactions;
    assert.equal(debit.type, 'debit');
    assert.equal(debit.account_id, a.id);
    assert.equal(credit.type, 'credit');
    assert.equal(credit.account_id, b.id);
    assert.equal(debit.transfer_id, res.body.transfer.id);
    assert.equal(credit.transfer_id, res.body.transfer.id);
    assert.equal(debit.description, 'rent share');

    for (const id of [a.id, b.id]) {
      assert.equal((await call('GET', `/api/accounts/${id}/verify`)).body.consistent, true);
    }
  });

  test('insufficient funds -> 422 and BOTH balances unchanged', async () => {
    const res = await transfer({ from_account_id: a.id, to_account_id: b.id, amount: 100.01, reference_id: 't2' });
    assertErrorShape(res, 422, 'INSUFFICIENT_BALANCE');
    assert.equal(await balanceOf(a.id), 100);
    assert.equal(await balanceOf(b.id), 50);
    assert.equal(txCount(a.id), 1);
    assert.equal(txCount(b.id), 1);
  });

  test('missing source or destination account -> 404, nothing changes', async () => {
    assertErrorShape(
      await transfer({ from_account_id: 'ghost', to_account_id: b.id, amount: 1, reference_id: 't3' }),
      404,
      'ACCOUNT_NOT_FOUND'
    );
    assertErrorShape(
      await transfer({ from_account_id: a.id, to_account_id: 'ghost', amount: 1, reference_id: 't4' }),
      404,
      'ACCOUNT_NOT_FOUND'
    );
    assert.equal(await balanceOf(a.id), 100);
    assert.equal(txCount(a.id), 1);
  });

  test('validation: same account, bad amount, missing fields', async () => {
    assertErrorShape(
      await transfer({ from_account_id: a.id, to_account_id: a.id, amount: 1, reference_id: 't5' }),
      400,
      'VALIDATION_ERROR'
    );
    assertErrorShape(
      await transfer({ from_account_id: a.id, to_account_id: b.id, amount: 0, reference_id: 't6' }),
      400,
      'VALIDATION_ERROR'
    );
    assertErrorShape(await transfer({}), 400, 'VALIDATION_ERROR');
    assertErrorShape(await transfer({ from_account_id: a.id, to_account_id: b.id, amount: 5 }), 400, 'VALIDATION_ERROR');
  });

  test('repeating a transfer reference_id -> 409 and no double transfer', async () => {
    const body = { from_account_id: a.id, to_account_id: b.id, amount: 10, reference_id: 't7' };
    assert.equal((await transfer(body)).status, 201);
    assertErrorShape(await transfer(body), 409, 'DUPLICATE_TRANSACTION');
    assert.equal(await balanceOf(a.id), 90);
    assert.equal(await balanceOf(b.id), 60);
  });

  test('rollback: debit succeeds but credit fails (reference already used on destination) -> whole transfer undone', async () => {
    await tx(b.id, 'credit', 1, 'clash'); // B now has 'clash'; A does not
    const transfersBefore = db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n;
    const res = await transfer({ from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 'clash' });
    assertErrorShape(res, 409, 'DUPLICATE_TRANSACTION');
    assert.equal(await balanceOf(a.id), 100, 'source must not be debited');
    assert.equal(await balanceOf(b.id), 51);
    assert.equal(txCount(a.id), 1, 'no partial debit row may remain');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n, transfersBefore);
  });

  test('rollback: a failure while crediting the destination undoes the debit (no partial transfer)', async () => {
    db.exec(`CREATE TRIGGER boom_dest BEFORE UPDATE OF balance ON accounts
             WHEN NEW.id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    try {
      const res = await transfer({ from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 't8' });
      assertErrorShape(res, 500, 'INTERNAL_ERROR');
    } finally {
      db.exec('DROP TRIGGER boom_dest');
    }
    assert.equal(await balanceOf(a.id), 100);
    assert.equal(await balanceOf(b.id), 50);
    assert.equal(txCount(a.id), 1);
    assert.equal(txCount(b.id), 1);
    // reference is free again
    assert.equal(
      (await transfer({ from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 't8' })).status,
      201
    );
  });

  test('opposite parallel transfers never deadlock or corrupt balances', async () => {
    const jobs = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(transfer({ from_account_id: a.id, to_account_id: b.id, amount: 5, reference_id: `ab-${i}` }));
      jobs.push(transfer({ from_account_id: b.id, to_account_id: a.id, amount: 5, reference_id: `ba-${i}` }));
    }
    const results = await Promise.all(jobs);
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(await balanceOf(a.id), 100);
    assert.equal(await balanceOf(b.id), 50);
  });
});
