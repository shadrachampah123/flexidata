--> statement-breakpoint
UPDATE "checkout_orders" SET "paystack_transaction_id" = NULL WHERE "paystack_transaction_id" = '';--> statement-breakpoint
UPDATE "deposit_requests" SET "paystack_transaction_id" = NULL WHERE "paystack_transaction_id" = '';--> statement-breakpoint
-- If a prior bug attached the same Paystack transaction to more than one row,
-- keep the earliest record and neutralise the later duplicates before adding
-- the unique index. No rows are deleted; only duplicate audit identifiers are
-- cleared so the index can be created without failing existing data.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY "paystack_transaction_id" ORDER BY id ASC) AS rn
  FROM "checkout_orders"
  WHERE "paystack_transaction_id" IS NOT NULL
)
UPDATE "checkout_orders" AS d
SET "paystack_transaction_id" = NULL
FROM ranked AS r
WHERE d.id = r.id AND r.rn > 1;--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY "paystack_transaction_id" ORDER BY id ASC) AS rn
  FROM "deposit_requests"
  WHERE "paystack_transaction_id" IS NOT NULL
)
UPDATE "deposit_requests" AS d
SET "paystack_transaction_id" = NULL
FROM ranked AS r
WHERE d.id = r.id AND r.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_orders_paystack_transaction_id_idx" ON "checkout_orders" USING btree ("paystack_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_paystack_transaction_id_idx" ON "deposit_requests" USING btree ("paystack_transaction_id");
