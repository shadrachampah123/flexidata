# Production Demo/Test-Money Cleanup — Review-Only Plan

**Date:** 2026-09-07 UTC
**Branch:** arena/01a0792c-flexidata
**Scope:** Remove ONLY historical demo/mock/test funding and its resulting demo balance. Preserve genuine Paystack money.
**Status:** READ-ONLY PLAN — NO CHANGES EXECUTED. Awaiting approval.

---

## 1. Constraints (from request)

- Do NOT delete users or wallets.
- Do NOT modify or delete genuine Paystack deposits.
- Preserve every transaction where `provider = 'paystack'` and `status = 'successful'`.
- Do NOT set all wallets to zero.
- Remove ONLY historical demo/mock/test funding and its resulting demo balance.
- Do NOT change the database schema.
- Do NOT deploy unrelated changes.

---

## 2. Wallet #4 — Facts Provided

- **Wallet ID:** 4
- **Current stored balance (`wallets.balance`):** GH₵1,268.00
- **Legitimate transaction-ledger balance:** GH₵1,215.50
- **Unexplained difference:** GH₵52.50
- **Successful live Paystack deposits total:** GH₵1,325.00
- **Successful data transactions total:** GH₵109.50

Verification:
```
1325.00 (Paystack in) - 109.50 (data out) = 1215.50 legitimate
1268.00 stored - 1215.50 legitimate = 52.50 demo/unexplained
```

**Classification:** The GH₵52.50 is NOT genuine Paystack money. It is unexplained historical/demo balance. It must be removed, but Paystack rows must stay untouched.

---

## 3. Diagnostic Queries (READ-ONLY, no writes)

These are the exact SELECTs I will run before any change, to confirm the production state and find every affected wallet.

### 3a. Wallet #4 current state
```sql
BEGIN READ ONLY;
SET TRANSACTION READ ONLY;

-- Wallet #4 stored balance
SELECT id, user_id, number, balance, points, created_at
FROM wallets WHERE id = 4;

-- Ledger-derived balance using SAME logic as admin reconciliation
-- moneyMoved: successful OR (pending/failed with charged_at NOT NULL), not refunded, not checkout-funded
SELECT
  wallet_id,
  COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END) FILTER (WHERE status='successful'),0) AS incoming_success,
  COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) FILTER (WHERE status='successful'),0) AS outgoing_success,
  COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE -amount END) FILTER (WHERE status='successful'),0) AS ledger_balance
FROM transactions
WHERE wallet_id = 4
GROUP BY wallet_id;

-- Detailed successful ledger for wallet 4
SELECT id, ref, type, status, direction, amount, provider, provider_reference, charged_at, refunded_at, created_at
FROM transactions
WHERE wallet_id = 4 AND status='successful'
ORDER BY created_at ASC;

-- Successful Paystack deposits for wallet 4 (MUST be preserved)
SELECT d.id, d.ref, d.wallet_id, d.provider, d.method, d.amount, d.status,
       d.paystack_transaction_id, d.paystack_channel, d.paid_at, d.verified_at,
       t.id AS tx_id, t.status AS tx_status, t.amount AS tx_amount
FROM deposit_requests d
LEFT JOIN transactions t ON t.ref = d.ref AND t.wallet_id = d.wallet_id
WHERE d.wallet_id = 4 AND d.provider='paystack' AND d.status='successful'
ORDER BY d.created_at ASC;

-- Mock/demo deposits for wallet 4 (these are the only ones eligible for parking)
SELECT id, ref, wallet_id, provider, amount, status, created_at
FROM deposit_requests
WHERE wallet_id = 4 AND provider != 'paystack' AND status='successful';

-- Check for transactions that are NOT Paystack successful (must remain untouched per rule, but listed for audit)
SELECT COUNT(*) AS paystack_successful_preserved
FROM transactions
WHERE wallet_id = 4 AND provider='paystack' AND status='successful';

COMMIT;
```

### 3b. Full scan — every wallet with discrepancy (to ensure we list ALL affected wallets)
```sql
-- Uses reconciliation logic from src/lib/admin/reconciliation.ts
WITH ledger AS (
  SELECT
    t.wallet_id,
    COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
      FILTER (WHERE 
        (t.status='successful' OR (t.status IN ('pending','failed') AND t.charged_at IS NOT NULL))
        AND t.refunded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM checkout_orders co WHERE co.ref = t.ref)
        AND (t.charged_at IS NOT NULL OR t.type IN ('transfer','redemption','conversion'))
      ),0) AS calculated
  FROM transactions t
  GROUP BY t.wallet_id
)
SELECT
  w.id AS wallet_id,
  w.balance::text AS stored_balance,
  COALESCE(l.calculated,0)::text AS ledger_balance,
  (w.balance - COALESCE(l.calculated,0))::text AS difference,
  w.number
FROM wallets w
LEFT JOIN ledger l ON l.wallet_id = w.id
WHERE ABS(w.balance - COALESCE(l.calculated,0)) > 0.005
ORDER BY ABS(w.balance - COALESCE(l.calculated,0)) DESC;
```

Expected result based on provided data: Only Wallet #4 shows +52.50 difference. If the full scan finds more, they will be added to the table below before execution.

---

## 4. Exact Changes Intended (NO EXECUTION YET)

### 4a. Primary correction — Wallet #4 balance only

**Goal:** Remove GH₵52.50 demo balance, set stored balance to legitimate ledger balance GH₵1,215.50.

**SQL — Option A (preferred, explicit set to legitimate value, with safety guard):**
```sql
-- Production demo cleanup — Wallet #4
BEGIN;

-- Safety: re-read with FOR UPDATE to prevent concurrent change
SELECT id, balance FROM wallets WHERE id = 4 FOR UPDATE;

-- 1. Correct wallet balance from 1268.00 -> 1215.50 (remove 52.50 demo)
--    WHERE clause ensures we only apply if balance is still the expected 1268.00
--    and we never set to zero, only to the ledger-derived legitimate value.
UPDATE wallets
SET balance = '1215.50'
WHERE id = 4
  AND balance = '1268.00';

-- Alternative idempotent arithmetic version (same result, clamped at 0, never negative):
-- UPDATE wallets
-- SET balance = GREATEST(0, balance - 52.50)::numeric
-- WHERE id = 4;

-- Verify
SELECT id, balance FROM wallets WHERE id = 4;

COMMIT;
```

**Resulting balance for Wallet #4:**
- Before: GH₵1,268.00
- After:  GH₵1,215.50
- Removed: GH₵52.50 demo

**Why this is safe:**
- No `DELETE` on users or wallets.
- No `UPDATE` or `DELETE` on `deposit_requests` where provider='paystack'.
- No `UPDATE` or `DELETE` on `transactions` where provider='paystack' AND status='successful'.
- No schema change.
- Not setting all wallets to zero — only Wallet #4 adjusted by exactly 52.50 to its legitimate ledger value.

### 4b. If mock/demo deposit_requests rows still exist (legacy)

If the full diagnostic finds `deposit_requests` with `provider != 'paystack'` AND `status='successful'` for any wallet, those will be parked as `failed` with audit note, and their matching ledger rows marked `reversed` — **exactly as the existing `cleanup-demo-deposits.ts` does**, which is proven safe by `verify:demo-deposit-cleanup`.

For Wallet #4 specifically, provided data says successful Paystack total is 1325 and data total is 109.50, implying NO mock deposit row explains the 52.50 (otherwise ledger would include it). Therefore we expect **zero** mock rows for Wallet #4, but we will still run the dry-run to confirm:

```bash
npx tsx scripts/cleanup-demo-deposits.ts --wallet 4
# DRY RUN only — no --apply
```

If it finds mock rows, the intended SQL for those would be (example for a hypothetical ref DP-DEMO-XYZ, NOT for Paystack):

```sql
-- Park demo deposit_requests (only if provider != 'paystack')
UPDATE deposit_requests
SET status='failed',
    completed_at = NOW(),
    verified_at = NOW(),
    paystack_gateway_response = 'Demo deposit reversed by cleanup (no real payment was taken).',
    updated_at = NOW()
WHERE ref = 'DP-DEMO-XYZ'
  AND provider != 'paystack'
  AND status='successful';

-- Mark demo ledger row reversed (only if type='deposit' and ref NOT in Paystack refs)
UPDATE transactions
SET status = 'reversed', -- or 'failed' on legacy enum
    refunded_at = NOW(),
    provider_status = 'reversed',
    provider_message = 'Demo deposit reversed by cleanup (no real payment was taken).'
WHERE ref = 'DP-DEMO-XYZ'
  AND type='deposit'
  AND status='successful'
  AND provider != 'paystack';
```

**These will NOT be executed for Wallet #4 unless diagnostic proves a mock row exists.** Paystack rows are explicitly excluded by `provider != 'paystack'` guard.

### 4c. Summary of affected wallets (based on provided info)

| Wallet ID | Stored Before | Ledger Legitimate | Demo to Remove | Stored After | Paystack Preserved? | Notes |
|-----------|---------------|-------------------|----------------|--------------|---------------------|-------|
| 4 | GH₵1,268.00 | GH₵1,215.50 | GH₵52.50 | GH₵1,215.50 | Yes — GH₵1,325.00 Paystack deposits untouched, GH₵109.50 data debits untouched | Core fix |
| (others) | TBD after full scan | TBD | TBD | TBD | Yes | Will be listed after diagnostic SELECT; if none, only #4 affected |

If the full scan in 3b finds other wallets with positive difference where stored > ledger and no Paystack explanation, they will be added to this table with identical correction pattern: `SET balance = ledger_balance` (or `balance - difference`, clamped at 0). No wallet will be set to zero unless its legitimate ledger is zero.

---

## 5. Verification After (READ-ONLY)

After approval and execution, run:

```sql
-- Post-cleanup verification for Wallet #4
SELECT id, balance FROM wallets WHERE id=4;
-- Expected: 1215.50

SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) FILTER (WHERE status='successful'),0)
FROM transactions WHERE wallet_id=4;
-- Expected: 1215.50

SELECT COUNT(*) FROM deposit_requests WHERE wallet_id=4 AND provider='paystack' AND status='successful';
-- Expected: unchanged, count and amounts identical to before

SELECT COUNT(*) FROM transactions WHERE wallet_id=4 AND provider='paystack' AND status='successful';
-- Expected: unchanged
```

And re-run:
```bash
npx tsx scripts/report-wallet-audit.ts   # for wallet #4
npx tsx scripts/report-paystack-transactions.ts
```

---

## 6. What is NOT being done

- No `DELETE FROM users` or `wallets`
- No `UPDATE wallets SET balance = 0`
- No modification of `deposit_requests` where provider='paystack'
- No modification of `transactions` where provider='paystack' AND status='successful'
- No schema migration
- No code deployment

---

## 7. Approval Gate

**STOP — Awaiting your approval.**

I have NOT executed anything. The only files created in this branch are this plan and the SQL file `flexiData/scripts/cleanup-wallet-4-demo.sql` which contains the same SQL as above.

Please reply "APPROVED" or specify adjustments. On approval, I will:

1. Run the diagnostic SELECTs (read-only) and share live results
2. Execute the exact UPDATE for Wallet #4 (and any other wallets you approve from the full scan)
3. Run post-verification and show final balances
