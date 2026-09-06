ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_action_check";--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "target_ref" varchar(40);--> statement-breakpoint
CREATE INDEX "admin_audit_logs_ref_idx" ON "admin_audit_logs" USING btree ("target_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_audit_logs_order_action_idx" ON "admin_audit_logs" USING btree ("target_ref","action") WHERE "admin_audit_logs"."target_ref" is not null and "admin_audit_logs"."action" in ('delivery_resolved', 'refund_review');--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_action_check" CHECK ("admin_audit_logs"."action" in ('suspend', 'activate', 'delivery_resolved', 'refund_review'));