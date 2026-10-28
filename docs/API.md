# API Documentation

Base URL: `http://localhost:3000/api` · All bodies are JSON (`Content-Type: application/json`).

Amounts are JSON **numbers** with at most 2 decimal places, `0 < amount ≤ 1,000,000,000`.
Strings such as `"10"` are rejected.

## Error format (every error, every endpoint)

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient balance for this debit.",
    "details": { "balance": 100, "requested": 150 }
  }
}
```

`details` is optional. Validation errors list every bad field at once:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": { "fields": [
      { "field": "type", "message": "type must be either \"credit\" or \"debit\"." },
      { "field": "amount", "message": "amount must be greater than 0." }
    ] }
  }
}
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing/invalid field, unknown field, client tried to set `balance` |
| 400 | `INVALID_REQUEST_BODY` | Malformed JSON or body is not a JSON object |
| 400 | `INVALID_PAGINATION` | `page`/`limit` not a positive integer, or `limit` > 100 |
| 400 | `INVALID_QUERY` | `type` filter is not `credit` / `debit` |
| 404 | `ACCOUNT_NOT_FOUND` | Unknown account id (also unknown source/destination in a transfer) |
| 404 | `TRANSACTION_NOT_FOUND` | Unknown transaction id |
| 404 | `ROUTE_NOT_FOUND` | No such route |
| 405 | `METHOD_NOT_ALLOWED` | e.g. `PUT/PATCH/DELETE` on a transaction (immutable). Includes an `Allow` header |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on that account. `details.transaction` is the original. **Nothing changed** |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 100 KB |
| 422 | `INSUFFICIENT_BALANCE` | Debit/transfer exceeds balance. **Nothing changed** |
| 500 | `INTERNAL_ERROR` | Unexpected failure. **Nothing was saved** (rolled back) |

---

## 1. Create account — `POST /accounts`

Body: `{ "name": "Alice" }` (1–100 chars, trimmed). The balance **cannot** be supplied.

`201 Created`
```json
{ "id": "b3f1…", "name": "Alice", "balance": 0, "created_at": "2026-10-27T11:52:03.120Z" }
```

## 2. Add transaction — `POST /accounts/:id/transactions`

(also available as `POST /transactions` with `account_id` in the body)

| Field | Type | Rules |
|---|---|---|
| `type` | string | `"credit"` or `"debit"` |
| `amount` | number | > 0, ≤ 2 decimals |
| `reference_id` | string | required, 1–100 chars, unique **per account** |
| `description` | string | optional, ≤ 255 chars |

`201 Created`
```json
{
  "transaction": {
    "id": "9d2c…", "account_id": "b3f1…", "type": "credit", "amount": 50,
    "description": "Top-up", "reference_id": "INV-2", "balance_after": 150,
    "transfer_id": null, "created_at": "2026-10-27T11:53:10.004Z"
  },
  "account": { "id": "b3f1…", "name": "Alice", "balance": 150, "created_at": "…" }
}
```

Behaviour:
* **credit** → balance + amount · **debit** → balance − amount
* debit larger than the balance → `422 INSUFFICIENT_BALANCE`, balance unchanged
* repeated `reference_id` on the same account → `409 DUPLICATE_TRANSACTION`, no new row, balance unchanged
* the same `reference_id` on a different account is allowed

## 3. Get balance — `GET /accounts/:id/balance`

`200` → `{ "account_id": "b3f1…", "balance": 150 }` · unknown id → `404 ACCOUNT_NOT_FOUND`

## 4. Transaction history — `GET /accounts/:id/transactions`

| Query | Default | Notes |
|---|---|---|
| `type` | *(both)* | `credit` or `debit` |
| `page` | `1` | positive integer |
| `limit` | `10` | 1–100 |

Always sorted **latest first** (`created_at DESC`, ties broken by insertion order).

`200`
```json
{
  "data": [ { "id": "…", "type": "debit", "amount": 30, "balance_after": 120, "…": "…" } ],
  "pagination": { "current_page": 1, "page_size": 10, "total_records": 12, "total_pages": 2 }
}
```
A page beyond the last returns `data: []` with correct pagination metadata.

## 5. Data integrity

* `PUT / PATCH / DELETE /accounts/:id/transactions[/:txId]` → `405 METHOD_NOT_ALLOWED` (`Allow: GET`).
* `GET /accounts/:id/transactions/:txId` → a single transaction.
* `GET /accounts/:id/verify` → recomputes the balance from the transaction log:
  ```json
  { "account_id": "b3f1…", "consistent": true, "stored_balance": 100,
    "computed_balance": 100, "transaction_count": 4 }
  ```

## 9. Transfer (bonus) — `POST /transfers`

```json
{ "from_account_id": "A…", "to_account_id": "B…", "amount": 30,
  "reference_id": "T-1", "description": "Rent share" }
```

`201 Created`
```json
{
  "transfer": { "id": "…", "from_account_id": "A…", "to_account_id": "B…", "amount": 30,
                "reference_id": "T-1", "description": "Rent share" },
  "from_account": { "id": "A…", "name": "A", "balance": 70, "created_at": "…" },
  "to_account":   { "id": "B…", "name": "B", "balance": 80, "created_at": "…" },
  "transactions": [ { "type": "debit", "…": "…" }, { "type": "credit", "…": "…" } ]
}
```

* Both legs are ordinary transactions (visible in history, tagged with the same `transfer_id`),
  and use the supplied `reference_id` on **each** account → a retried transfer is rejected with `409`.
* Source = destination → `400`; missing account → `404`; insufficient funds → `422`.
* Debit + credit + transfer record are **one atomic DB transaction**: any failure rolls back everything.

## Utility

* `GET /health` → `{ "status": "ok" }`
* `GET /accounts?page=&limit=` → paginated account list (used by the UI)
* `GET /accounts/:id` → one account
