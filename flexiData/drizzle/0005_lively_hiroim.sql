-- Restored migration.
--
-- `meta/_journal.json` and `meta/0005_snapshot.json` have referenced this tag
-- since the withdrawal feature landed, but the .sql file itself was never
-- committed. Drizzle's migrator therefore aborted with
-- `No file drizzle/0005_lively_hiroim.sql found in drizzle folder` and the
-- withdrawal schema never reached any database migrated from this folder:
--
--   POST /api/wallet/withdraw -> 500 Internal Server Error
--   [cause] relation "withdrawal_requests" does not exist (SQLSTATE 42P01)
--
-- The statements below are the exact 0004 -> 0005 delta described by
-- `meta/0005_snapshot.json`, in the order drizzle-kit emits it (types, table,
-- foreign keys, indexes). Everything here is additive: no table is dropped,
-- no column is removed and no row is rewritten, so it is safe to run against a
-- live database that already holds real wallets and ledger entries.
ALTER TYPE "tx_type" ADD VALUE 'withdrawal';--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('pending', 'processing', 'successful', 'failed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "withdrawal_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" varchar(40) NOT NULL,
	"user_id" integer NOT NULL,
	"wallet_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"fee" numeric(12, 2) NOT NULL,
	"net_amount" numeric(12, 2) NOT NULL,
	"destination_method" varchar(40) NOT NULL,
	"destination_details" jsonb NOT NULL,
	"status" "withdrawal_status" DEFAULT 'pending' NOT NULL,
	"admin_user_id" integer,
	"admin_rejection_reason" varchar(240),
	"provider_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_requests_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "withdrawal_requests_user_idx" ON "withdrawal_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "withdrawal_requests_wallet_idx" ON "withdrawal_requests" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "withdrawal_requests_status_idx" ON "withdrawal_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "withdrawal_requests_created_at_idx" ON "withdrawal_requests" USING btree ("created_at");
