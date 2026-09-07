-- Production Demo/Test-Money Cleanup — Wallet #4
-- READ-ONLY PLAN — DO NOT EXECUTE WITHOUT APPROVAL
-- Date: 2026-09-07 UTC
-- Constraints:
--   - Do NOT delete users or wallets
--   - Do NOT modify or delete genuine Paystack deposits
--   - Preserve every transaction where provider='paystack' and status='successful'
--   - Do NOT set all wallets to zero
--   - Remove ONLY historical demo/mock/test funding and its resulting demo balance
--   - Do NOT change database schema

-- ============================================================
-- 0. DIAGNOSTIC — READ ONLY (run first, before any change)
-- ============================================================
BEGIN READ ONLY;
SET TRANSACTION READ ONLY;

-- Wallet #4 stored
SELECT id, user_id, number, balance FROM wallets WHERE id = 4;

-- Ledger for wallet #4
SELECT id, ref, type, status, direction, amount, provider, created_at
FROM transactions
WHERE wallet_id = 4 AND status='successful'
ORDER BY created_at;

-- Paystack deposits (MUST be preserved)
SELECT ref, provider, amount, status, paystack_transaction_id
FROM deposit_requests
WHERE wallet_id = 4 AND provider='paystack' AND status='successful';

-- Mock/demo deposits (only these are eligible for cleanup, if any)
SELECT ref, provider, amount, status
FROM deposit_requests
WHERE wallet_id = 4 AND provider != 'paystack' AND status='successful';

-- Paystack transactions preserved count
SELECT COUNT(*) AS paystack_tx_preserved
FROM transactions
WHERE wallet_id = 4 AND provider='paystack' AND status='successful';

COMMIT;

-- ============================================================
-- 1. FULL SCAN — find every wallet with discrepancy
-- ============================================================
-- This uses the same reconciliation logic as src/lib/admin/reconciliation.ts
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
  w.balance AS stored_balance,
  COALESCE(l.calculated,0) AS ledger_balance,
  (w.balance - COALESCE(l.calculated,0)) AS difference,
  w.number
FROM wallets w
LEFT JOIN ledger l ON l.wallet_id = w.id
WHERE ABS(w.balance - COALESCE(l.calculated,0)) > 0.005
ORDER BY ABS(w.balance - COALESCE(l.calculated,0)) DESC;

-- ============================================================
-- 2. CLEANUP — Wallet #4 ONLY (exact change intended)
-- ============================================================
-- BEFORE: 1268.00, LEGIT: 1215.50 (1325.00 Paystack - 109.50 data), DEMO: 52.50, AFTER: 1215.50

BEGIN;

-- Lock wallet #4 row
SELECT id, balance FROM wallets WHERE id = 4 FOR UPDATE;

-- Primary fix: set balance to legitimate ledger value
-- Safety guard: only if balance is still 1268.00 (prevents double-apply or race)
UPDATE wallets
SET balance = '1215.50'
WHERE id = 4
  AND balance = '1268.00';

-- If you prefer arithmetic (idempotent, clamped):
-- UPDATE wallets
-- SET balance = GREATEST(0, balance - 52.50)::numeric
-- WHERE id = 4;

-- Verify after
SELECT id, balance AS after_balance FROM wallets WHERE id = 4;

COMMIT;

-- ============================================================
-- 3. OPTIONAL — Park legacy mock/demo rows IF they exist (NOT for Paystack)
-- ============================================================
-- These are ONLY executed if diagnostic in section 0 found mock rows.
-- They are identical to scripts/cleanup-demo-deposits.ts logic.
-- NEVER run for provider='paystack'.

-- Example template (replace DP-DEMO-XYZ with actual mock ref if found):
-- BEGIN;
-- UPDATE deposit_requests
-- SET status='failed',
--     completed_at = NOW(),
--     verified_at = NOW(),
--     paystack_gateway_response = 'Demo deposit reversed by cleanup (no real payment was taken).',
--     updated_at = NOW()
-- WHERE ref = 'DP-DEMO-XYZ'
--   AND provider != 'paystack'
--   AND status='successful';
--
-- UPDATE transactions
-- SET status = 'reversed',
--     refunded_at = NOW(),
--     provider_status = 'reversed',
--     provider_message = 'Demo deposit reversed by cleanup (no real payment was taken).'
-- WHERE ref = 'DP-DEMO-XYZ'
--   AND type='deposit'
--   AND status='successful'
--   AND (provider IS NULL OR provider != 'paystack');
-- COMMIT;

-- ============================================================
-- 4. POST-VERIFICATION — READ ONLY
-- ============================================================
BEGIN READ ONLY;
SET TRANSACTION READ ONLY;

SELECT id, balance FROM wallets WHERE id = 4; -- Expect 1215.50

SELECT
  COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) FILTER (WHERE status='successful'),0) AS in_total,
  COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) FILTER (WHERE status='successful'),0) AS out_total,
  COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) FILTER (WHERE status='successful'),0) AS ledger_balance
FROM transactions WHERE wallet_id = 4;

-- Ensure Paystack untouched
SELECT COUNT(*) AS paystack_deposits FROM deposit_requests WHERE wallet_id=4 AND provider='paystack' AND status='successful';
SELECT COALESCE(SUM(amount),0) AS paystack_total FROM deposit_requests WHERE wallet_id=4 AND provider='paystack' AND status='successful';
-- Expected: count and sum same as before (1325.00)

SELECT COUNT(*) AS paystack_tx FROM transactions WHERE wallet_id=4 AND provider='paystack' AND status='successful';

COMMIT;
