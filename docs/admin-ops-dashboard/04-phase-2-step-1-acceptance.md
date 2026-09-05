# Phase 2, Step 1 — Customer Management (suspend / activate + audit): Acceptance Report

**Status:** complete and verified. **Phase 2, Step 1 only** — nothing further in
Phase 2 (refunds, reversals, balance corrections, retry/fulfil/resend, support
cases, admin management) has been started.
Branch `arena/01a07358-flexidata`, base commit `55b67fb` (current `main`).

This step adds the **first and only** write action to the Admin Dashboard: a
controlled, explicitly-confirmed customer **suspend / activate** switch with a
full audit trail. Everything else in the dashboard remains read-only, and no
money, wallet, deposit, payment or data-delivery code path was modified.

> Note on the file name: the previous phase was written up as
> `03-phase-1-acceptance.md`, so this report is `04-…` to keep the sequence in
> the `docs/admin-ops-dashboard/` directory unambiguous.

---

## 1. What was built

| Area | Files |
|---|---|
| Schema + migration | `src/db/schema.ts` (`users.status`, `adminAuditLogs`), `drizzle/0002_customer_management.sql` + journal/snapshot meta |
| Capability / degrade layer | `src/lib/schema-compat.ts` — tracks `users.status`, watches `admin_audit_logs` |
| Suspension enforcement | `src/lib/auth.ts` (`AuthUser.suspended`), `src/lib/api-auth.ts` (`requireAccount()` → 403) |
| Write surface | `src/lib/customer-management.ts` (`setCustomerStatus`), `src/app/api/admin/users/[id]/status/route.ts` |
| Admin reads | `src/lib/admin/queries.ts` (status + audit history in list/detail), `src/lib/admin/types.ts` |
| UI | `src/components/admin/customer-actions.tsx` (confirmation modal), `src/components/admin/explorers.tsx` (Status column), `src/app/admin/users/[id]/page.tsx`, `src/app/admin/layout.tsx` |
| Verification | `scripts/verify-admin-phase2.ts` (65 checks), `scripts/schema-sim.ts` (simulator extended), `scripts/verify-admin-phase1.ts` (updated invariants), `package.json` (`verify:admin-phase2`) |

The customer list now shows **Status** (Active / Suspended) alongside the
existing name / email / phone / registration columns, and search still works by
name / email / phone. The customer detail page now shows the account status
pill, the suspend/activate control, and an **Account actions** audit-history
panel (acting admin, action, reason, timestamp). Passwords and password hashes
are never selected, exposed or returned — unchanged from Phase 1.

---

## 2. The approved minimal schema change

This is the only schema change in this step, and it was pre-approved: it is
**required** because the existing `users` table had no account-status column and
there was no table to record who suspended whom. The generated migration is
`drizzle/0002_customer_management.sql`:

- `users.status` — `varchar(20) NOT NULL DEFAULT 'active'`
  with `CHECK (status in ('active','suspended'))`.
- `admin_audit_logs` —
  `id serial PK`, `admin_user_id int NOT NULL` (FK → `users`, `ON DELETE restrict`),
  `target_user_id int NOT NULL` (FK → `users`, `ON DELETE restrict`),
  `action varchar(40) NOT NULL` with `CHECK (action in ('suspend','activate'))`,
  `reason varchar(240)` (nullable), `created_at timestamptz DEFAULT now() NOT NULL`,
  plus btree indexes on `admin_user_id` and `target_user_id`.

**No financial table is touched.** The migration adds a column to `users` and
creates `admin_audit_logs` only; `wallets`, `transactions`, `deposit_requests`,
`checkout_orders`, `provider_float_balances`, `agent_profiles`, `bundle_plans`
and the rest are untouched. The Phase 1 harness now asserts this by scanning the
migration for any `CREATE/ALTER TABLE` against those financial tables.

The application degrades gracefully when the migration has not yet been applied:
the customer-management capability layer reports the schema as missing, the UI
hides the suspend/activate control (and marks the status "Not available"), and a
status change attempt returns a clear 500 instead of a raw SQL error. The
migration has not been applied to any real/production database — the verification
harness applies it to a throwaway cluster it boots itself.

---

## 3. The write surface and API

`POST /api/admin/users/[id]/status` — the only new endpoint, and the only write.

Request body (JSON):

```json
{ "action": "suspend" | "activate", "confirm": true, "reason": "optional ≤ 240 chars" }
```

Behaviour, top to bottom:

1. `requireAdminApi()` is the **first statement** — the full Phase 0 gate runs
   before anything else (see §4).
2. The path `id` must be a positive integer.
3. `action` must be `suspend` or `activate`; **`confirm: true` is required** —
   without the literal confirmation the API refuses with 400, independently of
   the UI.
4. `setCustomerStatus` (`src/lib/customer-management.ts`) performs a
   **conditional UPDATE + audit INSERT in one transaction**:
   - refuses `user-not-found` (404), `admin-account` on suspend (400 — one admin
     cannot lock every operator out), and `schema-drift` (500) when the
     customer-management schema is absent;
   - the UPDATE is `WHERE status <> next`, so replaying the same action changes
     nothing and writes **no duplicate audit row**;
   - the acting admin is always `gate.context.admin.userId`, never a value from
     the request body.

The only browser write surface is `src/components/admin/customer-actions.tsx`: a
modal that requires the admin to type/confirm the action, and which POSTs only to
this endpoint with `confirm: true`. Admins and pre-migration accounts hide the
control.

---

## 4. Security model

- **Phase 0 gate, unchanged and re-run per request.** The new endpoint is gated
  by the exact same `requireAdminApi()` used everywhere else: valid signed
  `fd_auth`, a live session row, `users.is_admin = true`, and email ∈
  `ADMIN_EMAILS`. A failed check returns the **same 404** as anonymous access
  (byte-identical, so the existence of an admin endpoint is not leaked).
- **The browser is never trusted for the admin identity.** The acting admin is
  resolved server-side from the gate context; a spoofed `adminUserId` in the body
  is ignored (the harness proves a spoofed body still acts and records the real
  admin).
- **Explicit confirmation** is enforced at two layers (UI modal + API `confirm`).
- **No caching** on the status route (`force-dynamic`).
- Every admin page still re-checks the gate server-side before rendering; no
  read-only Phase 0/Phase 1 capability was removed.

---

## 5. Suspension enforcement — block actions, allow login/read

As approved: a suspended customer can still sign in and view their own account,
but every money/data action is blocked.

- `AuthUser` now carries `suspended` (schema-degrade aware: `false` when the
  schema lacks `status`).
- `requireAccount()` (`src/lib/api-auth.ts`) returns **403 `account_suspended`**
  (with `no-store`) for a suspended account.
- Concretely, this blocks the authenticated customer action routes that use
  `requireAccount()`: wallet deposit/fund, purchase, checkout, wallet transfer,
  convert, rewards redeem, schedule, and agent register.
- Login/read paths (account page, history, profile) are intentionally left open.
- If the migration has not been applied, enforcement degrades to open (status
  unknown ⇒ not suspended) rather than locking everyone out.

The harness proves the block end-to-end by calling a real action route as a
suspended customer (403) and confirming it works again after activation.

---

## 6. Financial safety — explicit confirmation

**No wallet balance mutation, deposit mutation, transaction reversal, refund,
payment retry, data-delivery retry, or direct financial-ledger modification was
made.** The only tables this step writes are `users` (the `status` column, plus
the standard `updated_at` timestamp on the changed row) and `admin_audit_logs`.
`Paystack` code, `checkout`, `purchase` callbacks, wallet maths and delivery logic
were not modified.

This is asserted three ways in the harness:

- source inspection of `customer-management.ts` (imports only `users` and
  `adminAuditLogs` from the schema; no financial identifier),
- the migration diff touches no financial table,
- **C4: a byte-for-byte snapshot of every financial table is identical before
  and after the full suspend/activate sweep.**

---

## 7. Verification

```bash
npm run verify:admin-phase2   # 65 checks — the Phase 2 harness
npm run verify:admin-access   # 40 checks — the Phase 0 gate, unchanged
npm run verify:admin-phase1   # 217 checks — Phase 1 invariants, updated
npm run typecheck && npm run lint && npm run build
```

The Phase 2 harness runs in three layers: pure-function checks, source-level
guarantees, and live database checks. The live sections boot a throwaway
PostgreSQL cluster through the optional `embedded-postgres` package (installed
`--no-save`; it applies migration `0002` to that throwaway database and never
touches one it was not handed).

| Section | What it proves |
|---|---|
| A | `parseId` / `parseSearch` (pure functions) |
| B | status route authorizes first, is never cached, never trusts a browser admin id, requires `confirm`; the only browser write surface is `customer-actions.tsx`; every admin handler/page is gated; the migration touches no financial table |
| C1 | `loadUsers` lists/masks/searches (name/email/phone) and exposes status; `loadUserDetail` returns identity, wallet, status, and (empty) action history |
| C2 | anonymous → 404, ordinary customer → 404, authorized admin → 200, for users list, user detail, and the status POST |
| C3 | suspend without `confirm` → 400; invalid action/id → 400; suspend flips exactly the right customer (admin and the other customer untouched); exactly one audit record with the real admin, target, action, reason and timestamp; replay writes no duplicate; spoofed admin id ignored; suspending an admin → 400; activate restores the status and appends the second audit row |
| C4 | financial tables byte-identical after the suspend/activate sweep |
| C5 | `requireAccount` refuses a suspended account with 403 `account_suspended`; a real action route returns 403 for a suspended customer; activation restores access; financial tables unchanged |

Full results on this branch:

| Suite | Result |
|---|---|
| `verify:admin-phase2` | **65/65** |
| `verify:admin-access` (Phase 0) | **40/40** |
| `verify:admin-phase1` | **217/217** (was 210; +7 assertions for the Phase 2 migration/write-surface invariants) |
| `verify:security-fixes` | 27/27 |
| `verify:auth-flow` | 37/37 |
| `verify:seed-resilience` | 6/6 |
| `verify:schema-baseline` | 6/6 |
| `verify:demo-deposit-cleanup` | 19/19 |
| `verify:schema-compat` | 4/5 — **pre-existing**, identical at the base commit (in-memory simulator cannot emulate "legacy" mode); unrelated to Phase 2 |
| `npm run typecheck` (`tsc --noEmit`) | pass |
| `npm run lint` (`eslint .`) | pass |
| `npm run build` (`next build`) | pass (requires `DATABASE_URL` set at build time — a pre-existing module-load guard in `src/db/index.ts`, not a regression) |

---

## 8. Known limitations (disclosed)

- **Login/read remain open for suspended customers by design** (approved).
  Money/data actions are the enforcement point; a fully locked-out experience is
  out of scope for this step.
- **The migration is not applied to any live database yet.** Until it is, the
  suspend/activate control is hidden and enforcement degrades to open.
- **Audit reason is optional and clamped to 240 chars** — a free-text field, not
  a structured taxonomy.
- **Admin self-protection** only covers suspend (activation stays allowed), so an
  administrator account can never be permanently locked out by mistake.

---

## 9. Stop point

Phase 2, Step 1 is complete and verified as specified. Anything beyond the
customer suspend/activate switch and its audit trail — refunds, reversals,
balance corrections, retry/fulfil/resend, support-case handling, kill switches,
admin management — remains out of scope and was deliberately not built.
