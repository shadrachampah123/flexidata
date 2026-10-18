# Parts 6.5A / 6.5B verification record

Historical verification base: `938313e1e4f353adb4571c5e081fe5ffdee114f6`.
The current checkpoint is `main` at `9175fb6b0e32246dca850b65a34be183a1400f0e`; current Parts 6.5B–6.9 status and recheck evidence are recorded in [the evidence matrix](production-readiness-evidence-2026-10-18.md).
All commands below ran from `flexiData/` and exited **0** on 2026-10-18.

| Command | Result |
| --- | --- |
| `npm run verify:health-recovery` | 5/5 route scenarios: current, missing, legacy, drifted, unknown |
| `npm run verify:purchase-lifecycle` | 25/25 real PostgreSQL scenarios, including concurrent no-reference hold invariant |
| `npm run verify:purchase-attempts-migration` | 10/10 real PostgreSQL migration-applier scenarios |
| `npm run lint` | pass, no diagnostics |
| `npm run typecheck` | pass, no diagnostics |
| `npm run build` | pass, fake CI-only database URL |
| `npm run verify:schema-compat` | 5/5 scenarios |
| `npm run verify:seed-resilience` | 6/6 scenarios |
| `npm run verify:security-fixes` | 27/27 checks |
| `npm run verify:data-provider-safety` | 39 checks, 0 failures |
| `npm run verify:reloadly` | 30/30 checks |
| `npm run verify:production-readiness` | 8/8 checks; live fulfillment LOCKED |
| `npm run verify:auth-flow` | 37/37 checks |
| `npm run verify:admin-access` | 40/40 checks |
| `npm run verify:withdrawals-disabled` | 76 checks, 0 failures (DB-free phase) |
| `npm run verify:withdrawal-lifecycle` | 81/81 checks |
| `npm run verify:demo-deposit-cleanup` | 19/19 checks, 2/2 scenarios |

Database tests used a newly initialized local PostgreSQL **18.4** instance,
loopback port 55432, exact database `purchase_lifecycle_test`, with synthetic
provider results and blocked external fetch. The disposable database was recreated
between suites. The existing migration was applied **only in that disposable
instance** by test harnesses. No new migration was authored. No production URL,
production database access, production writes, provider/payment calls, purchases,
scheduler/poller activation, deployment, or persisted environment changes occurred.
Test subprocess environment values and synthetic fixture purchases are test-only.

The full applicable CI suite was run locally. Live-app, external-provider and
Paystack E2E phases were deliberately not run. Passing hold-invariant tests do
not validate a manual-resolution workflow: that implementation remains blocked
by the facts and policy gates documented in the 6.5B runbook.

Remote CI status is reported in the PR/session handoff, not inferred from these
local passes. Do not merge or deploy without separate authorization.
