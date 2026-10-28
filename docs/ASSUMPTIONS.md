# Assumptions & Design Decisions

1. **Stack** — Node.js + Express with SQLite (`better-sqlite3`). SQLite keeps the project runnable with
   a single `npm install` (no DB server) while still giving real relational constraints, triggers and ACID transactions.

2. **Money as integers** — amounts are stored as integer minor units (paise) and exposed as decimals.
   Amounts must have ≤ 2 decimal places and be JSON numbers (not strings). Maximum per transaction: 1,000,000,000.
   Currency is not modelled (the UI displays ₹ only as a presentation choice).

3. **IDs** — accounts, transactions and transfers use server-generated UUID v4 values. Clients cannot choose ids or timestamps.

4. **Client-supplied `balance`** — treated as a validation error (`400`) rather than silently ignored, so a
   client never believes it set a balance.

5. **Unknown fields** are rejected (`400`) to avoid silently accepting typos or attempts to set server-controlled fields.

6. **Duplicate `reference_id`** — responds `409 DUPLICATE_TRANSACTION` and includes the original transaction in
   `details.transaction`. The check is by `(account_id, reference_id)` only: a repeated reference is a duplicate
   even if `type`/`amount` differ. It is enforced both in code and by a `UNIQUE` constraint.

7. **Insufficient balance** → `422 Unprocessable Entity` (request is well-formed but violates a business rule).
   Validation problems are `400`, missing resources `404`, duplicates `409`.

8. **Validation before lookup** — a malformed body is reported as `400` even if the account id is also unknown.

9. **Immutability** — transactions cannot be updated or deleted: the API exposes no such routes (`405`), and
   database triggers reject `UPDATE`/`DELETE` on the `transactions` table. Accounts also cannot be edited or
   deleted via the API (only created); their balance changes solely through transactions.

10. **Balance storage** — the balance is stored on the account (fast reads) and every transaction records
    `balance_after`. `GET /accounts/:id/verify` recomputes it from the log to prove consistency.

11. **Ordering** — history is `created_at DESC`; rows created in the same millisecond are ordered by insertion
    sequence, so "latest first" is fully deterministic.

12. **Pagination** — `page` ≥ 1, `limit` 1–100 (default 10). Out-of-range pages return an empty list with
    accurate metadata (`total_pages` is `0` when there are no records). Non-numeric/zero/negative/decimal values → `400`.

13. **Concurrency** — write operations run in `BEGIN IMMEDIATE` transactions; SQLite serialises writers, so two
    simultaneous debits can never overdraw an account and two identical `reference_id`s can never both succeed.

14. **Transfers** — implemented as two linked ordinary transactions (a debit and a credit sharing a `transfer_id`)
    in one atomic DB transaction. The supplied `reference_id` is used on both accounts, which makes transfers
    idempotent per source account; if the destination already used that reference the whole transfer is rejected
    and rolled back. Transferring to the same account is rejected. A transfer's `description` is optional
    (defaults to "Transfer to/from <name>").

15. **Authentication/authorisation** is out of scope for this assignment, so the API is open.

16. **Error responses** share one shape (`{ error: { code, message, details? } }`); unexpected errors never leak
    internals (`500 INTERNAL_ERROR`, nothing persisted).

17. **Extras beyond the brief** (kept small and optional): `GET /accounts` (list), `GET /accounts/:id`,
    `GET /accounts/:id/transactions/:txId`, `GET /accounts/:id/verify`, `GET /health`, `POST /transactions`
    alias, the web UI, and the seed script.
