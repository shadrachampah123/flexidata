# Phase 1 — Admin & Operations Dashboard (READ-ONLY): Acceptance Report

**Status:** complete and verified. **Phase 2 not started.**
Branch `arena/01a06e8b-flexidata`, base commit `22209a1`.

Phase 1 is an **observation layer**. Every screen and every endpoint under
`/admin` and `/api/admin/*` reads. Nothing in this phase can move money, change a
balance, refund an order, retry a delivery, or create a support case.

---

## 1. What was built

| Area | Files |
|---|---|
| Read-only execution layer | `src/lib/admin/db.ts` — `withReadOnlyTx()` |
| Masking / formatting | `src/lib/admin/redact.ts`, `src/lib/admin/format.ts` |
| Reconciliation rules | `src/lib/admin/reconciliation.ts` |
| Filter parsing | `src/lib/admin/filters.ts` |
| Query layer | `src/lib/admin/queries.ts`, `src/lib/admin/queries-operations.ts` |
| API helpers / view types | `src/lib/admin/api.ts`, `src/lib/admin/types.ts` |
| API (12 handlers) | `src/app/api/admin/{overview,wallets,wallets/[id],transactions,transactions/[ref],data,attention,payments,reconciliation,users,users/[id],me}` |
| Pages (11) | `src/app/admin/{page,wallets,wallets/[id],transactions,transactions/[ref],data,attention,payments,reconciliation,users,users/[id]}` |
| UI primitives / shell | `src/components/admin/{ui,nav,page-head,explorer,explorers}.tsx`, `src/app/admin/layout.tsx` |
| Verification harness | `scripts/verify-admin-phase1.ts` (210 checks) |

Modified outside that set: `package.json` (one `scripts` entry) only.
**No migration. No schema change. No index. No change to any wallet, deposit,
payment, purchase or delivery code path.**

### Screens

1. **`/admin` — Overview.** Customer and money totals, ledger state, delivery and
   funding state, provider float, and a "Needs attention" panel that is rendered
   *above* the statistics and ordered by operational urgency (money already taken
   and a customer waiting ranks above a statistical mismatch).
2. **`/admin/wallets`** — search, stored balance, ledger-derived balance, credits,
   debits, reversals, last movement, discrepancy flag.
3. **`/admin/wallets/[id]`** — `Stored wallet balance` / `Calculated balance` /
   `Difference` / `Status: Requires investigation`, plus the transactions that
   contributed to the sum and a list of legitimate explanations to rule out first.
4. **`/admin/transactions`** and **`/admin/transactions/[ref]`** — filter by ref,
   customer, wallet, type, direction, status, provider, date and amount.
5. **`/admin/data`** — two channels (`wallet-funded` and `Paystack checkout`) with
   payment status, wallet-debit status, provider, provider reference, delivery
   status and bucket counts.
6. **`/admin/attention`** — the parked-order backlog, i.e. the orders
   `src/lib/checkout.ts:541` leaves at `fulfillment_failed` with
   *"Support will fulfil or refund this order."* Until now that queue was only
   visible through `psql`.
7. **`/admin/payments`** — deposit activity including whether the matching wallet
   credit exists.
8. **`/admin/reconciliation`** — stored vs calculated per wallet with the number of
   transactions examined and the last relevant transaction.
9. **`/admin/users`** and **`/admin/users/[id]`** — search plus identity, account
   status, wallet, recent activity and delivery status.

Masking is applied in every list (emails and phone numbers); a deliberately opened
single record shows the real values, one account at a time.

---

## 2. The read-only guarantee (three independent layers)

1. **The database is the authority.** Every admin read runs inside a transaction
   opened with `access mode: read only` *and* `SET TRANSACTION READ ONLY`.
   PostgreSQL then rejects any INSERT / UPDATE / DELETE / DDL / sequence advance
   with SQLSTATE `25006`. The harness proves this by bypassing the JS guard
   entirely and issuing a raw `UPDATE wallets SET balance = …` — the server
   refuses it.
2. **The executor refuses writes in application code.** `assertReadOnlyStatement()`
   inspects every statement before it is sent; anything that is not a read or
   transaction control raises `AdminReadOnlyViolation`. This turns a would-be
   write into a loud failure instead of a database error.
3. **There is no write surface to call.** No admin module imports a drizzle
   mutation API, no admin API route accepts anything but `GET`, and no admin
   component issues a non-GET request. The harness asserts all three by source
   inspection, and a before/after snapshot of every financial table proves that
   browsing the dashboard changed nothing.

### The rule that decides whether a ledger row moved money

`moneyMovedSql()` in `src/lib/admin/reconciliation.ts` is the single source of
truth. A row counts when it is **successful**, or **pending/failed but charged**,
**not refunded**, **not** a Paystack checkout order mirrored into the ledger, and
(**charged** or one of `transfer` / `redemption` / `conversion`, which move cash
without ever setting `charged_at`).

The same fragment feeds the overview's discrepancy tile, `/admin/wallets` and
`/admin/reconciliation`, so those three screens cannot disagree. Where the schema
lacks a column the rule needs, the figure is labelled an **estimate** and a
difference is reported as *unknown* — never as zero.

### Labels, deliberately

- **Stored wallet balance** = the authoritative figure on the wallet row.
- **Calculated / expected balance** = the diagnostic comparison. It is never
  written back, and the UI never presents it as a second ledger.

---

## 3. Verification

```bash
npm run verify:admin-phase1     # 210 checks — the Phase 1 harness
npm run verify:admin-access     # 40 checks — the Phase 0 gate, unchanged
npm run typecheck && npm run lint && npm run build
```

The harness runs in three layers, and sections D–G need a real PostgreSQL: it
uses `DATABASE_URL` when `FLEXIDATA_ADMIN_TEST_DB=1` is also set (CI), otherwise
it boots a throwaway cluster through the optional `embedded-postgres` package
(`npm i --no-save embedded-postgres`), otherwise it skips the live sections with
a warning. It never touches a database it was not explicitly handed.

| Section | What it proves |
|---|---|
| A | masking, filter parsing and the reconciliation classifier (pure functions) |
| B | the statement guard refuses writes and allows reads, including a comment-smuggled write |
| C | every handler calls `requireAdminApi()` first; every page re-checks the gate; no write API anywhere under `src/lib/admin`; no non-GET request from the UI; no migration or schema change |
| D | PostgreSQL itself rejects UPDATE / INSERT / DELETE / DDL inside the admin transaction (`25006`), and every admin read really runs with `transaction_read_only = on` |
| E | hand-computed expectations on seeded fixtures (overview counts, wallet maths, buckets, attention queue, payment credit states, masking) |
| F | a snapshot of every financial table is byte-identical before and after all reads |
| G | anonymous → 404, ordinary customer → 404 (byte-identical body), authorized admin → 200, for all 11 endpoints; revoking `is_admin` kills a live session immediately; the snapshot is still unchanged afterwards |

Existing suites, all run against this branch:

| Suite | Result |
|---|---|
| `verify:admin-access` (Phase 0) | 40/40 |
| `verify:security-fixes` | 27/27 |
| `verify:auth-flow` | 37/37 |
| `verify:seed-resilience` | 6/6 |
| `verify:schema-baseline` | 6/6 |
| `verify:demo-deposit-cleanup` | 19/19 |
| `verify:schema-compat` | 4/5 — **pre-existing**, identical at the base commit (the in-memory simulator cannot emulate "legacy" mode); unrelated to Phase 1 |
| `verify:signup` | requires a real `DATABASE_URL`; not runnable here (pre-existing) |

End-to-end, against a seeded throwaway database and the dev server: all 11 pages
and all 11 endpoints return **200** for an authorized admin and **404** for a
signed-in non-admin, and every customer page still returns 200.

---

## 4. Performance notes

- Every list is server-side filtered, sorted and paginated; the browser never
  receives an unpaginated table. Each page renders page 1 as a Server Component
  (it works with JavaScript disabled) and hands it to a client explorer that
  pages and filters with `GET` requests to the matching endpoint.
- Aggregates are single-pass SQL (`count(*)`, `sum`, `filter (where …)`) with
  correlated subqueries rather than per-row application loops, so there is no
  N+1 read.
- **No index was added and no schema change was made.** Every filter maps onto
  the columns the existing schema already indexes or scans (`transactions.ref`,
  `wallets.number`, `checkout_orders.order_status`, timestamps). The attention
  queue caps each of its three sources at 200 rows (oldest first) so it stays a
  work queue rather than a bulk export.

**Recommendation, for a later phase and not done here:** if the ledger grows past
roughly a million rows, the wallet search (`ILIKE '%term%'`) and the
reconciliation scan will want a trigram index on `transactions.ref` /
`wallets.number` and a composite index on `(wallet_id, created_at)`. That is a
schema change and was deliberately left out of Phase 1.

---

## 5. Known limitations (disclosed)

- **Wallet discrepancies are a diagnosis, not a verdict.** The classifier never
  names a culprit. The UI lists the rows that were summed and the legitimate
  explanations to rule out first (direct database correction, pre-gateway rows,
  the blocked airtime-conversion read-modify-write, mirrored checkout orders,
  in-place callback refunds, points-vs-cash).
- **The 200-row cap per attention source** means a backlog larger than 200 in one
  source is truncated; the queue is capped by design and the UI says so.
- **Provider payloads are never displayed.** They are free-form third-party
  responses and the dashboard has no need to show them.
- **Delivery states on a pre-gateway database** read "Not available" rather than
  zero — a zero would read as "all clear".

---

## 6. Stop point

Phase 1 is complete and read-only, as approved. **Phase 2 has not been started**
and will not be without explicit approval. Anything that writes — refunds,
reversals, balance corrections, retry/fulfil/resend, support-case handling, kill
switches, admin management — is out of scope for this phase and was deliberately
not built, including behind a flag.
