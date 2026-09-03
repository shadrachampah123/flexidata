CREATE TYPE "public"."checkout_order_status" AS ENUM('awaiting_payment', 'payment_failed', 'abandoned', 'paid', 'fulfilling', 'fulfilled', 'fulfillment_failed');--> statement-breakpoint
CREATE TYPE "public"."checkout_payment_status" AS ENUM('pending', 'successful', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'successful', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('queued', 'submitted', 'processing', 'delivered', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."tx_status" AS ENUM('successful', 'pending', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."tx_type" AS ENUM('data', 'airtime', 'conversion', 'deposit', 'transfer', 'redemption', 'referral');--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_id" integer NOT NULL,
	"tier" varchar(40) DEFAULT 'Starter' NOT NULL,
	"referral_code" varchar(20) NOT NULL,
	"referrals" integer DEFAULT 0 NOT NULL,
	"commission" numeric(12, 2) DEFAULT '0' NOT NULL,
	"volume" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_wallet_id_unique" UNIQUE("wallet_id"),
	CONSTRAINT "agent_profiles_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "bundle_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"network" varchar(10) NOT NULL,
	"category" varchar(40) NOT NULL,
	"label" varchar(80) NOT NULL,
	"provider_product_code" varchar(80) NOT NULL,
	"validity" varchar(60) NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"retail_price" numeric(10, 2) NOT NULL,
	"badge" varchar(20),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkout_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" varchar(40) NOT NULL,
	"user_id" integer NOT NULL,
	"wallet_id" integer NOT NULL,
	"customer_email" varchar(160) NOT NULL,
	"customer_phone" varchar(20) NOT NULL,
	"network" varchar(10) NOT NULL,
	"category" varchar(40) NOT NULL,
	"plan_label" varchar(80) NOT NULL,
	"provider_product_code" varchar(80) NOT NULL,
	"recipient" varchar(20) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"amount_subunits" integer NOT NULL,
	"currency" varchar(8) DEFAULT 'GHS' NOT NULL,
	"payment_status" "checkout_payment_status" DEFAULT 'pending' NOT NULL,
	"order_status" "checkout_order_status" DEFAULT 'awaiting_payment' NOT NULL,
	"fulfillment_status" "fulfillment_status" DEFAULT 'queued' NOT NULL,
	"paystack_transaction_id" varchar(40),
	"paystack_channel" varchar(40),
	"paystack_gateway_response" varchar(240),
	"provider_reference" varchar(120),
	"provider_status" varchar(80),
	"provider_message" varchar(240),
	"paid_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_orders_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "deposit_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" varchar(40) NOT NULL,
	"wallet_id" integer NOT NULL,
	"provider" varchar(40) DEFAULT 'mock' NOT NULL,
	"method" varchar(40) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"amount_subunits" integer DEFAULT 0 NOT NULL,
	"currency" varchar(8) DEFAULT 'GHS' NOT NULL,
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"provider_reference" varchar(120),
	"paystack_transaction_id" varchar(40),
	"paystack_channel" varchar(40),
	"paystack_gateway_response" varchar(240),
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"provider_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_requests_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "price_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"network" varchar(10) NOT NULL,
	"title" varchar(140) NOT NULL,
	"body" varchar(240) NOT NULL,
	"tag" varchar(20) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_float_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_code" varchar(40) NOT NULL,
	"network" varchar(10) NOT NULL,
	"currency" varchar(8) DEFAULT 'GHS' NOT NULL,
	"available_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reserved_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"low_balance_threshold" numeric(12, 2) DEFAULT '0' NOT NULL,
	"last_reference" varchar(40),
	"last_status" varchar(80),
	"notes" varchar(240),
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_topups" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_id" integer NOT NULL,
	"network" varchar(10) NOT NULL,
	"plan_label" varchar(80) NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"recipient" varchar(20) NOT NULL,
	"day_of_month" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"user_agent" varchar(240),
	"ip" varchar(64),
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" varchar(40) NOT NULL,
	"wallet_id" integer NOT NULL,
	"type" "tx_type" NOT NULL,
	"status" "tx_status" NOT NULL,
	"fulfillment_status" "fulfillment_status" DEFAULT 'queued' NOT NULL,
	"direction" "direction" NOT NULL,
	"title" varchar(140) NOT NULL,
	"subtitle" varchar(200) DEFAULT '' NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"network" varchar(10),
	"recipient" varchar(20),
	"provider" varchar(40),
	"provider_product_code" varchar(80),
	"provider_reference" varchar(120),
	"provider_status" varchar(80),
	"provider_message" varchar(240),
	"fulfillment_attempts" integer DEFAULT 0 NOT NULL,
	"charged_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"last_provider_sync_at" timestamp with time zone,
	"provider_payload" jsonb,
	"provider_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"email" varchar(160) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"referral_code" varchar(20) NOT NULL,
	"referred_by" integer,
	"referral_rewarded_at" timestamp with time zone,
	"email_verified_at" timestamp with time zone,
	"notify_promos" boolean DEFAULT true NOT NULL,
	"notify_tx" boolean DEFAULT true NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"name" varchar(120) NOT NULL,
	"number" varchar(20) NOT NULL,
	"balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"is_agent" boolean DEFAULT false NOT NULL,
	"agent_tier" varchar(40),
	"referral_code" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_orders_user_idx" ON "checkout_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "checkout_orders_status_idx" ON "checkout_orders" USING btree ("order_status");--> statement-breakpoint
CREATE INDEX "deposit_requests_wallet_idx" ON "deposit_requests" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "deposit_requests_status_idx" ON "deposit_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_float_balances_provider_network_idx" ON "provider_float_balances" USING btree ("provider_code","network");--> statement-breakpoint
CREATE INDEX "users_referred_by_idx" ON "users" USING btree ("referred_by");