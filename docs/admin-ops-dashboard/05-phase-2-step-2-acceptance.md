# Phase 2, Step 2 — Failed Data-Delivery Support Workflow: Acceptance Report

**Status:** complete and verified. **Phase 2, Step 2 only** — nothing further in
Phase 2 (auto-refunds, reversals, balance corrections, delivery retries, support
cases, admin management) has been started.
Branch `arena/01a073eb-flexidata`, base commit `7abbc38` (current `main`, includes
the merged Phase 2 Step 1, PR #28).

This step turns the **failed/stuck data-delivery queue** — which Step 1 of the
phase only let admins *see* — into a safe, closed-loop **support workflow**:

1. **Mark delivery resolved** — the admin personally confirmed the customer got
   the data (e.g. via a provider dashboard) and records that fact.
2. **Mark for refund review** — records that finance should look at refunding.
   **This action never moves money.** There is no safe, reusable, idempotent
   refund workflow anywhere in the codebase (the only existing refund path is the
   wallet-channel provider callback in `src/lib/checkout.ts`, which is not
   reusable for Paystack-checkout orders and would require changing payment
   logic — explicitly out of bounds). Refund review is therefore an
   **audit-recorded review state**, nothing more.

Both actions are confirmation-gated, server-validated, audited, replay-safe, and
cannot touch wallets, deposits, Paystack, the financial ledger, or delivery
retry. No auto-refund, no auto-retry, no fabricated delivery, no arbitrary
status changes were added anywhere.

---

## 1. What was built

| Area | Files |
|---|---|
| Schema (approved, minimal) | `flexiData/src/db/schema.ts` (`adminAuditLogs.targetRef`, widened `action` CHECK, 2 indexes), `drizzle/0003_support_workflow.sql` + journal/snapshot meta |
| Support-action engine | `flexiData/src/lib/support-actions.ts` (eligibility, normalisation, transactional apply, replay-safe audit, refusal taxonomy) |
| Write endpoint | `flexiData/src/app/api/admin/orders/[ref]/support/route.ts` (Phase 0 gate → validation → action) |
| Admin reads | `flexiData/src/lib/admin/queries-operations.ts` (`hasSupportSchema`, `loadSupportStateByRef`, `isAttentionRowActionable`, attention + data-view enrichment, wallet/checkout queue hygiene), `queries.ts` (account-actions scope unchanged, null-safe support fields), `types.ts` (`supportAction`, `supportNote`, `actionable` on attention + order rows) |
| UI | `flexiData/src/components/admin/order-support-actions.tsx` (typed-confirmation modal — the only new browser-side writer), `explorer.tsx` (refresh tick after an action), `explorers.tsx` (Support column/notes on the data view), `src/app/admin/attention/page.tsx`, `src/app/admin/data/page.tsx` |
| Queue hygiene (defect found and fixed during verification) | checkout-ledger **mirror rows no longer double-list** the same order in the wallet attention queue (`not exists` on `checkout_orders.ref`), guarded by the same capability probe as everything else |
| Verification | `flexiData/scripts/verify-admin-phase2-step2.ts` (new, 158 checks), `scripts/verify-admin-phase1.ts` + `verify-admin-phase2.ts` (write-surface invariants updated to allowlist exactly the two sanctioned admin action files), `scripts/schema-sim.ts` (`target_ref`), `package.json` (`verify:admin-support`) |

Nothing in `src/lib/paystack.ts`, `src/lib/checkout.ts` (except the doc-comment
above its parking logic: untouched code), the wallet, deposit, refund, referral,
points, pricing or provider modules was modified — verified mechanically
(section 6).

## 2. The approved minimal schema change

A schema change **was** required, and per the standing rule the work stopped and
the options were presented first. **`extend_audit` was approved**: one migration,
`0003_support_workflow.sql`, touching **only `admin_audit_logs`** — never a
financial table.

```sql
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "admin_audit_logs_action_check";
ALTER TABLE "admin_audit_logs" ADD COLUMN "target_ref" varchar(40);
CREATE INDEX "admin_audit_logs_ref_idx" ON "admin_audit_logs" USING btree ("target_ref");
CREATE UNIQUE INDEX "admin_audit_logs_order_action_idx"
  ON "admin_audit_logs" ("target_ref", "action")
  WHERE "target_ref" IS NOT NULL
    AND "action" IN ('delivery_resolved', 'refund_review');
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_action_check"
  CHECK ("action" IN ('suspend', 'activate', 'delivery_resolved', 'refund_review'));
```

Why each piece exists:

- **`target_ref`** — the audit row must record *which order* was acted on
  (customer id, action, timestamp and reason were already columns; the order
  reference is the missing target).
- **The widened CHECK** — the action value stays enumerable and constrained; the
  two new values are the only additions. `suspend`/`activate` semantics from
  Step 1 are unchanged (a harness check asserts they remain permitted).
- **The partial unique index** — *the database itself* guarantees at most one
  `(order, action)` support audit record, which is the no-duplicate-on-replay
  guarantee (requirement 4). It is partial so it can never constrain
  deposit/suspend history.
- **The plain index** — keeps the queue's "has this order already been acted on?"
  enrichment O(index) rather than a scan.

No status columns were invented: `delivery_resolved` reuses the existing
`checkout_orders.order_status = 'fulfilled'` + `fulfillment_status = 'delivered'`
transitions that the payment-callback path already writes on real delivery, and
`fulfilled_at` (only if still null — an actual provider timestamp is never
overwritten). `refund_review` writes **no order column at all**.

## 3. The workflow

**Who acts:** an operator who already passes the Phase 0 gate everywhere else.

**Where:** `/admin/attention` (the Needs-Attention queue) and `/admin/data`
(Data Operations explorer). Action buttons render only on rows that are
Paystack-checkout orders still in an actionable state. Wallet-ledger and deposit
queue items stay read-only by design — acting on them would mean mutating the
financial ledger, which is out of bounds.

**How (per action):**

1. Admin clicks *Mark delivered* or *Refund review* on a queue/detail row.
2. A modal restates the target order (ref, customer, amount, network/product,
   status, failure note) and requires **typing the exact order reference** to
   enable the confirm button (same ceremony as Step 1's suspend switch). A
   free-text reason (≤ 240 chars) is optional and encouraged.
3. The browser sends `POST /api/admin/orders/<ref>/support` with
   `{ action, orderRef: <typed echo>, confirm: true, reason }`.
4. The server re-checks everything against the **live row** — the browser's view
   of the world is never trusted (a stale tab gets a clean 409, not a bogus
   write).
5. The view refreshes automatically (`refreshToken` tick → re-`GET`
   `/api/admin/attention`), so the row's queue presence and recorded support
   state reflect the write immediately.

**Mark delivered** writes `order_status='fulfilled'`,
`fulfillment_status='delivered'`, `fulfilled_at=now()` (only when null) inside
one transaction with one `delivery_resolved` audit row. `payment_status`,
amounts, `provider_status`/`provider_message` and every other column are left
exactly as the provider last reported them — the recorded fact is
"*an admin confirmed delivery*", never a fake provider response.

**Mark for refund review** writes **only** one `refund_review` audit row.
`checkout_orders` is byte-identical afterwards (a harness check compares the
whole row before/after). The order remains in the attention queue, still
actionable, until someone actually marks it delivered — review does not
suppress the finding.

## 4. The API

### `POST /api/admin/orders/[ref]/support`

Body: `{ "action": "delivery_resolved" | "refund_review", "confirm": true,
"orderRef": "<ref, echoed exactly>", "reason": "≤240 chars" | omitted }`

| Situation | Response |
|---|---|
| Valid, applied | `200 {ok:true, ref, action, changed:true, orderStatus}` |
| Valid, already recorded (replay of `refund_review`; second admin races) | `200 {ok:true, …, changed:false}` — one audit row total, guaranteed by the unique index (driver errors are matched through the `DrizzleQueryError` cause chain, so a duplicate insert can never surface as a 500) |
| Bad/missing `action`, `confirm` not exactly `true`, echoed `orderRef` mismatch, malformed ref | `400` with a named error |
| Ref matches no checkout order (incl. wallet `FD-…` and deposit refs — they are **not** order refs) | `404` |
| Order not in an eligible state (nothing captured, already fulfilled, fresh in-flight) | `409 order-not-actionable` / `order-already-resolved` |
| Database lacks migration 0003 | `500` fail-closed: *"Support actions are unavailable because the database is missing the support workflow schema."* Reads degrade gracefully instead (support columns render `—`) |
| Anything other than a gated admin (anonymous, non-admin, spoofed `adminUserId` in body, revoked mid-session) | the Phase 0 denial: `404`, byte-identical to anonymous |

### Eligibility (read model = write model, one function)

`isSupportableOrder()` is shared by the queue's `actionable` flag and the
endpoint's guard — the UI can never offer what the API would refuse. Approved
scope (**"failed_and_stuck"**): the order's payment was actually captured
**and** it is either `fulfillment_failed` (parked: "Support will fulfil or
refund this order"), or has been `paid`/`fulfilling` for more than the 2-hour
STUCK window. Unpaid, failed-payment (nothing captured — auto-handled by the
checkout), fresh, fulfilled and refunded orders are never actionable.

## 5. Security model

- **Phase 0 gate re-enforced on every request**: `requireAdminApi()` is the
  first statement in the route — signed session cookie, live sessions row,
  `users.is_admin`, `ADMIN_EMAILS`. None of it weakened anywhere; a revocation
  mid-session drops support calls to 404 immediately (tested).
- **Denials are 404s, indistinguishable from anonymous access** (tested
  byte-for-byte, headers and body).
- **No admin spoofing**: the acting admin is `gate.context.admin.userId`. A
  body-supplied `adminUserId` is ignored — the audit row records the gate's
  admin (tested).
- **Explicit confirmation is server-enforced**, not just modal UI:
  `confirm === true` **and** an exact echo of the target ref, both required.
- **Targeted by ref, bounded**: refs are trimmed/capped/charset-checked before
  any query (malformed → 400 with zero queries), parameterised everywhere;
  the endpoint acts on exactly one order and lists nothing.
- **Secrets never exposed**: queue/detail payloads and audit reasons carry no
  tokens, keys, password material, full provider payloads or secrets (a regex
  sweep runs over the serialized attention payload).
- **Replay safety**: no mutation + no duplicate audit on replay, enforced at the
  database level (partial unique index), with a clean `changed:false` API result.

## 6. Financial safety — guarantees, not promises

The step's core risk is a support tool drifting into money territory. These are
mechanically checked, not asserted in prose:

1. **Byte-identical financial state.** Before the first support call and after
   the whole live-test sweep, `wallets`, `transactions`, `deposit_requests`,
   `provider_float_balances`, `agent_profiles`, `bundle_plans`,
   `scheduled_topups`, `price_alerts`, `users`, `sessions` are serialized and
   compared — identical (every customer row too).
2. **Money columns on `checkout_orders` are immutable under these actions**: a
   dedicated SQL snapshot of every money/payment column (amounts, currency,
   `payment_status`, `paystack_*` ids, `refunded_at` …) matches before/after;
   `refund_review` additionally leaves the **entire order row** identical.
3. **No refund primitive exists in the write path.** `src/lib/support-actions.ts`
   and the route were scanned: no import of the refund/payment/wallet modules and
   no statement that can set a money column (the module's only writes are the
   guarded status UPDATE and the audit INSERT). The Step 1 harness invariant was
   **widened, not weakened**: exactly two admin write surfaces are allowlisted
   (`customer-actions.tsx`/status route, `order-support-actions.tsx`/support
   route) and a source-level scan proves there is no third — including "no
   `refunded` string anywhere in the two new files".
4. **Delivery cannot be fabricated**: `fulfilled_at` is only backfilled when
   null; `provider_status`/`provider_message` are never rewritten; and
   `verify()`/the callback flow still early-returns on already-fulfilled orders,
   so the provider remains the source of truth.
5. **Queue hygiene fix (found by this harness)**: the `transactions` mirror row
   that the checkout flow writes for visibility made every parked order appear
   **twice** (checkout queue + wallet queue) and — worse — would keep flagging
   "charged but not delivered" forever even after support resolved the order,
   because the mirror is not updated by support actions. The wallet attention
   query now excludes ledger rows that mirror a `checkout_orders` ref. The
   mirror row itself is left untouched (it is a provider-attempt record; this
   dashboard never edits the ledger) — it is simply not re-listed as separate
   work.

## 7. Verification — exact results

New suite `flexiData/scripts/verify-admin-phase2-step2.ts`
(`npm run verify:admin-support`) — **158/158 checks passed**
(31 pure-function + 31 source-level + 96 live-database). The live section boots a
throwaway `embedded-postgres` cluster, applies the full journal (0000→0003) and
the real seed, imports the **actual route handlers**, and covers, among others:

| Requirement | Evidence |
|---|---|
| Admin sees failed/stuck orders | parked `fulfillment_failed`, stuck >2h `paid`/`fulfilling`, failed-payment, charged wallet orders and stale deposits all appear in `/api/admin/attention` with customer, ref, network/product, amount, status, failure note, timestamps; fresh in-flight and unpaid orders do not |
| Non-admin gets 404 | anonymous, logged-in non-admin, spoofed-admin-in-body — every denial 404 and byte-identical to anonymous |
| No spoofing | action succeeds using the gated admin; audit records that admin, not the body's |
| Confirmation required (both actions) | missing `confirm`, `confirm:"yes"`, ref-echo mismatch, unknown actions → 400 with nothing written |
| Wrong order ids | wallet/deposit refs and unknown refs → 404; malformed → 400; ineligible states → 409; every refusal wrote nothing (tables re-hashed) |
| No duplicate audit on replay | `refund_review` replay → `200 changed:false`, one row; `delivery_resolved` replay → `409 already resolved`, one row, `fulfilled_at` not re-touched |
| Wallet balances unchanged | byte-identical snapshots, wallet *and* checkout-money checks (section 6) |
| Prior phase tests | all pass — see below |

Existing suites, after the changes:

| Suite | Result |
|---|---|
| `npm run verify:admin-phase2` (Step 1, write-surface invariant widened) | **65/65** |
| `npm run verify:admin-phase1` (read-only guarantees, write scan allowlisted) | **222/222** |
| `npm run verify:admin-access` (Phase 0 gate) | **40/40** |
| `npm run verify:security-fixes` | **27/27** |
| `npm run verify:auth-flow` | **37/37** |
| `npm run verify:signup` | **24/24** |
| `npm run verify:seed-resilience` | **6/6 scenarios** |
| `npm run verify:schema-baseline` | **6/6 flows healthy** |
| `npm run verify:demo-deposit-cleanup` | **19/19** |
| `npm run verify:schema-compat` | **4/5** — identical to the base commit (the pre-existing "health: schema legacy" pair; verified by re-running under `git stash`) |
| `npm run typecheck` / `npm run lint` / `npm run build` | all clean (build with dummy env) |

How to reproduce locally: `npm run verify:admin-support` (boots its own
throwaway cluster when `embedded-postgres` is installed, otherwise skips the live
section loudly — it never connects to a database it was not told to use).

## 8. Known limitations (disclosed)

- **Refund review does not refund.** Deliberate: no safe reusable refund path
  exists, and building one means changing money logic. A reviewed order stays in
  the queue with a visible "refund review recorded" state until a human settles
  it out-of-band and closes it with *mark delivered* or a real (future,
  separately-approved) refund tool.
- `delivery_resolved` trusts the confirming admin, exactly as Step 1's suspend
  does. Mitigations: typed confirmation, one immutable audit row per order+action
  (who/when/why), no path to fabricate provider fields. Cross-checking a provider
  dashboard is operational policy, not code.
- Pre-0003 databases: support columns read as `—`, no buttons render, and the
  endpoint fails closed with an actionable 500 message — reads never break.
- Replay of `delivery_resolved` answers `409 already resolved` (idempotent for
  the audit guarantee: one row, no re-touch) while `refund_review` replay is a
  benign `changed:false` — the two actions intentionally differ because marking
  delivered twice is a signal something is wrong, recording a review again is not.
- The support trail is keyed by order ref in `admin_audit_logs`; an order's
  audit history appears in both admin views but is not (yet) a dedicated
  per-order timeline page — that belongs to a later step.
- No auto-retry was added anywhere; parked orders are still never retried
  (unchanged behavior, still asserted by the Step 1/2 harnesses).

## 9. Stop point

Phase 2, Step 2 ends here. The next step ("Step 3") would be the *real* refund
execution path — it requires touching payment/refund logic and must be scoped,
approved, and safety-reviewed separately. Balance corrections, reversals,
support cases and admin management also remain un-started. The Phase 0 gate,
Step 1's suspend/activate, and every pre-existing flow are untouched and green.
