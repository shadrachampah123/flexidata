/** Public guidance only. Never performs a migration or changes readiness. */
export const SCHEMA_RECOVERY =
  "Stop and follow docs/part-6.4-production-readiness.md: inspect schema drift and obtain an approved, targeted recovery plan. " +
  "Do not use drizzle-kit push or drizzle-kit migrate in production. No general guarded runner exists for this schema.";
export const AUDIT_RECOVERY =
  "Follow docs/part-6.4-production-readiness.md and the guarded npm run migrate:admin-audit-actions procedure for migration 0007. " +
  "Review its dry-run report and approval requirements before applying; stop on drift. Do not use drizzle-kit push or drizzle-kit migrate in production.";
export const PURCHASE_RECOVERY =
  "Follow docs/part-6.4-production-readiness.md and the guarded npm run migrate:purchase-attempts procedure for migration 0011. " +
  "Review its dry-run report and approval requirements before applying; an existing drifted table requires investigation, not reapplication. " +
  "Data purchases remain fail-closed. Do not use drizzle-kit push or drizzle-kit migrate in production.";
