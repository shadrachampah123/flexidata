CREATE INDEX "price_alerts_active_idx" ON "price_alerts" USING btree ("active");--> statement-breakpoint
CREATE INDEX "scheduled_topups_wallet_id_idx" ON "scheduled_topups" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "transactions_wallet_id_idx" ON "transactions" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "transactions_wallet_created_idx" ON "transactions" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_wallet_status_idx" ON "transactions" USING btree ("wallet_id","status");--> statement-breakpoint
CREATE INDEX "transactions_wallet_ref_idx" ON "transactions" USING btree ("wallet_id","ref");--> statement-breakpoint
CREATE INDEX "wallets_user_id_idx" ON "wallets" USING btree ("user_id");