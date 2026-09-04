# FlexiData — Admin & Operations Dashboard: Codebase Assessment

**Status:** Inspection only. No code has been changed, no migrations created, no database touched.
**Date:** 2026-09-04
**Branch:** `arena/01a06e5e-flexidata`
**Scope of inspection:** full repository (`README.md`, `.github/workflows/`, `flexiData/**`).

---

## Executive summary

Three findings dominate everything else:

1. **There is no admin functionality of any kind today.** Not a route, not a component, not a
   library function, not a permission check. The dashboard is a genuine greenfield addition, which
   is the best possible starting position — nothing has to be un-built.
2. **`users.is_admin` already exists in the schema and the database, but is dead code.** It is
   declared in `src/db/schema.ts:82`, shipped in migration `0000` line 194, mapped in
   `src/lib/schema-compat.ts:75` — and **read by nothing**. It is not even selected into the
   `AuthUser` object. So a flag exists, but no enforcement, no provisioning path, and no
   trustworthiness. It must be treated as *unverified* until a server-side gate is written.
3. **The money layer is unusually disciplined and must not be disturbed.** Balances move only via
   atomic SQL arithmetic (`balance = balance ± x`) guarded by conditional `WHERE` clauses, inside
   single database transactions that also write the ledger row. Paystack settlement is
   verify-only, idempotent and triple-locked against mock credit in production. The correct design
   posture for the admin dashboard is to **read this layer and never reach into it** — and, when
   financial actions eventually arrive, to imitate its patterns rather than bypass them.

The rest of this document answers A–M, identifies the safest implementation location, and closes
with a phased plan that puts a read-only dashboard and reconciliation tooling in front of any
financial control.

---

## A. Current application architecture

### Repository shape

```
/                             repo root
├── README.md                 (34 KB — operational runbook, deposit/Paystack docs, migration notes)
├── .github/workflows/
│   └── paystack-e2e.yml      manual Paystack TEST-mode E2E (Postgres service + local stub)
└── flexiData/                the application
    ├── drizzle/              2 SQL migrations + meta snapshots
    ├── scripts/              13 verification / read-only reporting scripts (tsx)
    └── src/
        ├── app/              Next.js App Router (pages + /api route handlers)
        ├── components/       ~30 React components (mix of server & "use client")
        ├── db/               index.ts (pg Pool + drizzle), schema.ts
        ├── lib/              business logic (~6,300 lines)
        └── proxy.ts          Edge auth gate (Next 16's renamed `middleware.ts`)
```

### Stack

| Concern | Choice |
|---|---|
| Framework | **Next.js 16.3.3**, App Router, React 19.2.6, RSC-first |
| Language | TypeScript 5.9.3, `strict: true`, `noEmit`, path alias `@/*` → `./src/*` |
| Styling | Tailwind CSS v4 (via `@tailwindcss/postcss`), no UI component library |
| Icons | `lucide-react` |
| ORM | **Drizzle ORM 0.45.2** on `drizzle-orm/node-postgres` |
| Database | PostgreSQL via `pg` 8.20 `Pool` (max 5, 10s connect timeout), pool cached on `globalThis` in dev |
| Migrations | `drizzle-kit` 0.31.10 (`db:generate`, `db:migrate`); `drizzle.config.ts` has hardened env loading and refuses to migrate a localhost DB on CI/Vercel |
| Auth | **Hand-rolled** — no NextAuth/Clerk/Lucia |
| Payments | Paystack (server-only client) |
| Deployment target | Vercel + Neon (per README) |

### Layering

```
Browser
  │
  ├─ Page routes ──▶ src/proxy.ts (Edge: HMAC cookie check only, no DB)
  │                     │
  │                     ▼
  │                  src/app/layout.tsx ──▶ AppChrome (client) ──▶ SideNav + BottomNav
  │                     │
  │                     ▼
  │                  Server Component page ──▶ requireSession() ──▶ src/lib/data.ts ──▶ Drizzle
  │
  └─ /api/** ──────▶ (proxy EXPLICITLY skips these) ──▶ route handler
                        │
                        ├─ requireAccount()            src/lib/api-auth.ts
                        ├─ business lib                src/lib/{deposits,checkout,payments,data-gateway,...}
                        └─ Drizzle ──▶ PostgreSQL
```

Every route handler declares `export const dynamic = "force-dynamic"`.

### The schema-compatibility subsystem (important context)

`src/lib/schema-compat.ts` (1,006 lines) introspects `information_schema` at runtime, caches the
result (`DATA_API_SCHEMA_PROBE_MS`, default 60s), and lets the app degrade gracefully when the
deployed database lags the code — building explicit column lists for `INSERT`s instead of letting
Drizzle name columns that do not exist. `src/lib/seed.ts` complements this with **self-healing
additive DDL** (`repairCheckoutOrdersSchema`, `repairDepositRequestsSchema`, `repairReferrerIndex`)
invoked from `ensureSeeded()` and `/api/health`.

Consequence for the dashboard: **admin queries must be written defensively too.** A hard-coded
`SELECT` naming a column the deployed database lacks would make the admin dashboard the one part
of the app that white-screens on a lagging schema. Reuse `getSchemaCapabilities()` /
`withSchemaFallback()`.

---

## B. Existing authentication and role system

All in `src/lib/auth.ts` (565 lines), `src/lib/session.ts`, `src/lib/api-auth.ts`, `src/proxy.ts`.

### Credentials

- Password hashing: **scrypt** (`scryptSync`, 16-byte hex salt, 64-byte derived key), stored as
  `scrypt:<salt>:<hash>`; verification via `timingSafeEqual`.
- `AUTH_SECRET` (≥16 chars) is mandatory; `assertAuthSecretConfigured()` is called *before* a user
  row is created so a missing secret cannot orphan an account.

### Sessions — a deliberate two-cookie design

| Cookie | Contents | Flags | Who reads it |
|---|---|---|---|
| `fd_session` | raw 32-byte base64url token | `httpOnly`, `secure` in prod, `sameSite=lax`, 30 days | Server only. DB stores **SHA-256** of it (`sessions.token_hash`), so a DB leak is not replayable. |
| `fd_auth` | `base64url({uid, sid, exp}) + "." + HMAC-SHA256` | same flags | **Edge middleware only** (`src/proxy.ts`), for a cheap DB-free gate. |

- `src/proxy.ts` verifies the `fd_auth` HMAC + `exp` using Web Crypto. It **never touches the
  database**, so a *revoked* session still passes the Edge. This is documented and intentional —
  Server Components and API routes re-check against the `sessions` table.
- Matcher: `/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest|robots.txt|sitemap.xml).*)`.
  **`/api/` is explicitly short-circuited** (`if (pathname.startsWith("/api/")) return next()`).
- Behaviour: signed-in + on an auth page → redirect `/`; signed-out + on any other page →
  redirect `/login?next=…`.

### The three authorization helpers that exist today

| Helper | File | Used by | On failure |
|---|---|---|---|
| `getCurrentUser()` | `src/lib/auth.ts` | everything | returns `null` |
| `requireSession()` | `src/lib/session.ts` | Server Component pages | `redirect("/login")` |
| `requireAccount()` | `src/lib/api-auth.ts` | every money-moving API route | JSON `401 {code:"unauthenticated"}` |

`requireAccount()` returns `{ ok, userId, wallet }` — resolving the wallet server-side is what keeps
every route on the caller's own money.

### The `AuthUser` shape — note the omission

```ts
type AuthUser = {
  id; name; email; phone; referralCode; referredBy;
  notifyPromos; notifyTx; isAgent;   // ← isAgent comes from wallets.is_agent
};                                   // ← there is NO isAdmin field
```

`getAuthUserById()` does not select `users.is_admin`. Nothing downstream can see it.

### Other auth surface

- Password reset: `password_resets`, SHA-256-hashed token, 1-hour TTL, single-use via `used_at`.
  No account enumeration (unknown email returns `null` silently).
- Session management for users: `listSessions`, `deleteSessionById`, `destroyOtherSessions`,
  exposed at `/api/account/sessions`.
- **Test seam:** `getCurrentUser()` honours `FLEXIDATA_TEST_USER_ID` whenever
  `NODE_ENV !== "production"`. See §L-4 — this becomes a serious concern once `/admin` exists.

### Roles

**There is no role system.** No roles table, no permissions, no scopes, no RBAC helpers. A grep for
`role|permission|rbac` across `src/` returns only HTML ARIA `role="option"` attributes.

---

## C. Existing admin / super-admin roles

**None functionally. One dormant flag.**

| Artefact | Location | Status |
|---|---|---|
| `users.is_admin boolean NOT NULL DEFAULT false` | `src/db/schema.ts:82` | declared |
| `"is_admin" boolean DEFAULT false NOT NULL` | `drizzle/0000_...sql:194` | shipped to DB |
| `isAdmin: "is_admin"` | `src/lib/schema-compat.ts:75` | drift-mapping only |
| test fixtures set `is_admin: false` | `scripts/schema-*.ts`, `verify-security-fixes.ts` | fixtures only |

Exhaustive grep confirms **no read, no write, no check** anywhere in `src/app/**`,
`src/components/**` or the rest of `src/lib/**`. There is also **no provisioning path**: nothing in
registration, settings or any API can set `is_admin = true`. Today the only way to create an admin
is a manual `UPDATE` in psql.

### Do not confuse "agent" with "admin"

`wallets.is_agent`, `wallets.agent_tier` and the `agent_profiles` table are a **customer loyalty
tier** (referrals, commission, volume), self-served through `POST /api/agent/register` and shown at
`/agent`. It carries zero elevated privilege and must never be conflated with administrative access.

---

## D. Existing wallet implementation

### Table

```
wallets
  id             serial PK
  user_id        integer  → users.id  ON DELETE CASCADE   ⚠ NULLABLE, ⚠ NOT UNIQUE
  name           varchar(120)
  number         varchar(20) UNIQUE      ← the phone number; used as the P2P transfer address
  balance        numeric(12,2) NOT NULL DEFAULT '0'
  points         integer NOT NULL DEFAULT 0
  is_agent       boolean NOT NULL DEFAULT false
  agent_tier     varchar(40)
  referral_code  varchar(20)
  created_at     timestamptz NOT NULL DEFAULT now()
```

One wallet per user is a **convention, not a constraint** — `getWalletRowForUser()`
(`src/lib/data.ts`) does `.where(eq(wallets.userId, userId)).limit(1)` and throws
`WalletNotFoundError` if absent. Duplicate or orphaned (`user_id IS NULL`) wallets are physically
possible. That is a reconciliation *finding*, not something the dashboard should silently repair.

### Every place `wallets.balance` is mutated

| Site | Operation | Concurrency safety |
|---|---|---|
| `src/lib/deposits.ts` → `settleAtomic()` | `balance = balance + amount` | ✅ inside the tx that claims the deposit and writes the ledger row |
| `src/app/api/purchase/route.ts` (data) | `balance = balance - cost` with `WHERE balance >= cost` | ✅ conditional UPDATE = no overdraft |
| `src/app/api/purchase/route.ts` (data, provider failed) | `balance = balance + cost` | ✅ SQL arithmetic |
| `src/app/api/purchase/route.ts` (airtime) | `balance = balance - cost` with `WHERE balance >= cost` | ✅ |
| `src/app/api/wallet/transfer/route.ts` | debit sender + credit recipient | ✅ conditional |
| `src/app/api/rewards/redeem/route.ts` | `points = points - cost`, `balance = balance + credit`, `WHERE points >= cost` | ✅ conditional |
| `src/app/api/purchase/callback/route.ts` | refund / charge / point clawback | ✅ guarded by `refunded_at IS NULL` etc. |
| `src/app/api/convert/route.ts` | ⚠ `.set({ balance: newBalance.toFixed(2) })` — **read-modify-write** | ❌ but the whole route is hard-blocked with 503 in production |

**There is currently no endpoint anywhere that sets a wallet balance to an operator-supplied
value.** Preserving that property is the single most important constraint on this project.

---

## E. Existing transaction / ledger implementation

### Table

```
transactions
  id, ref varchar(40) UNIQUE, wallet_id integer NOT NULL      ⚠ no FK
  type    tx_type   ENUM(data, airtime, conversion, deposit, transfer, redemption, referral)
  status  tx_status ENUM(successful, pending, failed, reversed)
  fulfillment_status fulfillment_status ENUM(queued, submitted, processing, delivered, failed, refunded)
  direction direction ENUM(in, out)
  title, subtitle, amount numeric(12,2), points integer
  network, recipient
  provider, provider_product_code, provider_reference, provider_status, provider_message
  fulfillment_attempts integer
  charged_at, fulfilled_at, refunded_at, last_provider_sync_at  (timestamptz)
  provider_payload jsonb, provider_response jsonb
  created_at
```

### Character of the ledger — read this before building reconciliation

- It is an **append-mostly journal, not a double-entry ledger.** There is no `balance_after`
  column, no running balance, no per-entry idempotency key beyond the unique `ref`, and **no
  foreign key to `wallets`**.
- `wallets.balance` is the authoritative figure; `transactions` is a parallel record. They are kept
  consistent by being written in the same transaction — which means **reconciliation is a real,
  meaningful check**, not a formality.
- Writes go through `insertTransactionRow()` (`src/lib/data.ts`), which routes to a schema-compat
  `INSERT` when gateway columns are missing. `settleAtomic()` inlines the same logic because its
  insert must share the balance transaction's connection.

### Nuances any reconciliation engine must encode

1. **Failed rows still carry an amount.** A failed purchase writes `amount = cost`,
   `subtitle = "… • Not charged"`, `charged_at = NULL`. `charged_at IS NULL` is the discriminator
   for "no money moved" — *not* `status`.
2. **Refunds are marked in place**, via `refunded_at` + `status = 'reversed'` (or `'failed'` on a
   legacy enum), not as a separate contra entry.
3. **Transfers produce two rows** (sender `out`, recipient `in`) sharing related refs.
4. **`points` and cash are independent quantities** on the same row; `redemption` rows can move
   points down and cash up simultaneously.
5. **Deposits share `ref` with `deposit_requests.ref`**, which is the natural join key.
6. **Checkout orders (`checkout_orders`) only become `transactions` rows once fulfilled** — an
   order that is paid but not fulfilled exists in `checkout_orders` and *not* in the ledger.

So the reconciliation formula is roughly
`balance ?= Σ(in, charged) − Σ(out, charged) + Σ(credits from redemption/referral)` — with the
explicit expectation that legitimate mismatches exist and must be **classified, never auto-corrected**.

### Prior art to reuse

`scripts/report-wallet-audit.ts` is already a hardened read-only auditor: it refuses non-`SELECT`
statements, blocks write/DDL keywords by regex, sets `application_name`, and uses a read-only
transaction. **This is the exact discipline the Phase 1/2 admin query layer should adopt.**
`scripts/report-paystack-transactions.ts` is a second precedent.

---

## F. Existing Paystack integration and webhook handling

### `src/lib/paystack.ts` — the single server-only client

- `import "server-only"` → importing it from a client component is a build error.
- **One** accessor for the key, `paystackSecretKey()`. It is never logged, never serialised into an
  error, never returned.
- TEST vs LIVE is derived purely from the key prefix. **A `sk_live_` key is refused unless
  `PAYSTACK_LIVE_MODE=true`** — going live is a deliberate two-variable action.
- `paystackInitializeTransaction()` — rejects non-integer/non-positive `amountSubunits`.
- `paystackVerifyTransaction()` — **the only source of truth for "the customer has paid."**
  Normalises status; anything unknown maps to `pending`, never `success`.
- `isValidPaystackWebhookSignature()` — HMAC-SHA512 of the raw body, `timingSafeEqual`.
- Error surface is scrubbed: only Paystack's public `message` + HTTP status.

### `src/lib/payments.ts` — funding gateway resolution

`paymentsProvider()` returns `paystack | mock`. **Production lockout** (`productionLockoutReason()`):
in `NODE_ENV=production`, `PAYMENTS_PROVIDER=mock` or a missing Paystack key **throws** rather than
falling back to simulated credit.

### `POST /api/payments/webhook`

1. If Paystack is unconfigured → ack and ignore (signatures can't be verified, so trust nothing).
2. Verify `x-paystack-signature` **before parsing the body**; invalid → `401`.
3. Only `charge.success` / `charge.failed` / `charge.abandoned` are acted on.
4. The payload is used **only to extract a reference.** Settlement always re-verifies against
   Paystack's verify API → replayed webhooks are harmless.
5. Routes to `reconcileCheckoutOrder(ref)` or `reconcileDeposit(ref)`. Responses never echo payload.

### `POST /api/payments/verify`

Owner-scoped (`requireAccount()` + `deposit.walletId !== auth.wallet.id` → identical `404` for
"not yours" and "not found"), safe to poll, delegates to the same idempotent `reconcileDeposit`.

### `src/lib/deposits.ts` — the deposit state machine

`createDepositRequest()` records the attempt (with integer pesewas) **before** calling Paystack, so
a redirect can never be orphaned. `reconcileDeposit()` requires **all four** of: `status=success`,
matching reference, **exact** `amount_subunits`, matching currency. Any mismatch parks the row as
`failed` with an audit note and **never credits**. `settleAtomic()` is the choke point: a single
conditional `UPDATE` claims the row (`pending|abandoned|failed → successful`), and only the winner
increments the balance and inserts the ledger row, in one transaction.

`deposit_requests` and `checkout_orders` each carry a **unique index on `paystack_transaction_id`**
(migration `0001`) as defence in depth against one Paystack transaction settling two rows.

The production lock is enforced at **three** independent layers: `/api/wallet/fund` (before auth),
`createDepositRequest()`, and `settleAtomic()` itself.

---

## G. Existing data purchase and delivery flow

There are **two independent purchase pipelines**.

### Pipeline 1 — Wallet-funded: `POST /api/purchase`

```
requireAccount()
  → validate network + recipient
  → kind="data":
      resolve plan server-side from bundle_plans (never trust client price)
      atomic conditional debit  (WHERE balance >= cost)
      ensureProviderFloatCapacity(network, cost)
      submitDataBundleOrder()          ← src/lib/data-gateway.ts
      on failure → atomic refund, ledger row marked "Not charged"
      insertTransactionRow() with fulfillment_status + provider_* + jsonb payloads
      upsert/project provider float
      creditReferralReward() on success
  → kind="airtime":
      ⚠ rollLocalStatus() — Math.random(): 88% successful / 8% pending / 4% failed.
        Airtime has NO real provider integration.
```

### Pipeline 2 — Paystack pay-as-you-go: `POST /api/checkout`

Uses `checkout_orders` (no wallet balance involved):

```
awaiting_payment ─▶ paid ─▶ fulfilling ─▶ fulfilled
       │                         └─────▶ fulfillment_failed
       ├──▶ payment_failed
       └──▶ abandoned
```

Settled by `/api/checkout/verify` or the webhook → `reconcileCheckoutOrder()`, all via conditional
`UPDATE`s so a duplicate can never pay twice or submit the bundle twice.

**`src/lib/checkout.ts:541` is the operational gap that justifies this whole project:**

> *"The order stays parked as `fulfillment_failed` and is NEVER auto-retried: the gateway may have
> accepted the submission before the error, and a retry could deliver the bundle twice. Support
> resolves these manually."*
>
> `providerMessage`: *"The data provider could not be reached after payment. Support will fulfil or
> refund this order."*

Today "support resolves these manually" means *psql*. **There is no queue, no list, no tooling.**

### Delivery status model

- Wallet purchases → `transactions.fulfillment_status`
  (`queued|submitted|processing|delivered|failed|refunded`).
- Checkout orders → `checkout_orders.order_status` + `.fulfillment_status`.
- `src/lib/fulfillment.ts` is a **pure** module (`buildTrackingInfo`) turning ledger fields into
  stages, progress %, ETA and human labels. It has no DB dependency and no captured clock — the
  admin UI can reuse it verbatim.
- `GET /api/track/[ref]` — owner-scoped live tracker.

### Provider callback: `POST /api/purchase/callback`

Authenticated by HMAC-SHA256 of the raw body in `x-data-api-signature` (or
`x-webhook-signature` / `x-flexidata-signature`), with a legacy plain-secret header / bearer still
accepted. `DATA_API_WEBHOOK_SECRET` is **required in production** — without it every callback is
rejected. Applies refunds and point clawbacks under conditional guards
(`refunded_at IS NULL`, …) so a redelivered callback cannot refund twice.

### `src/lib/data-gateway.ts`

Provider abstraction (`DATA_API_PROVIDER=mock` or a configured HTTP aggregator), float-balance
tracking in `provider_float_balances` with `low_balance_threshold`, and typed errors
(`DataProviderConfigError` → 503, `DataProviderFloatError` → 503, `DataProviderRequestError` → 502).
**Provider float is an excellent Phase 1 dashboard tile** — it already models a low-balance alert.

---

## H. Existing user / account structure

```
users ──1:1(convention)──▶ wallets ──1:1──▶ agent_profiles      (agent_profiles.wallet_id UNIQUE)
  │                          │
  │                          ├──▶ transactions      (wallet_id, no FK)
  │                          ├──▶ deposit_requests  (wallet_id, no FK)
  │                          └──▶ scheduled_topups  (wallet_id, no FK)
  ├──▶ sessions          (FK, ON DELETE CASCADE)
  ├──▶ password_resets   (FK, ON DELETE CASCADE)
  ├──▶ checkout_orders   (user_id + wallet_id, no FK)
  └──▶ users.referred_by (self-reference, plain index — deliberately not unique)
```

- Registration (`registerUser()` in `src/lib/accounts.ts`) creates **user + wallet + agent profile
  in one transaction**, so a committed user always has a wallet.
- `is_admin` is never set at registration.
- Only **three** foreign keys exist in the entire schema: `sessions.user_id`,
  `password_resets.user_id`, `wallets.user_id`. Everything else joins on bare integers.
- Referrals: `users.referral_code` / `referred_by` / `referral_rewarded_at`, paid once via
  `src/lib/referrals.ts`.

---

## I. Existing audit logging

**There is no audit log.** No audit table, no admin action log, no security event log, no
append-only trail of who did what.

What *does* exist is **per-row forensic data**, which is a good foundation:

| Source | What it captures |
|---|---|
| `deposit_requests` | `paystack_transaction_id`, `paystack_channel`, `paystack_gateway_response`, `initiated_at`/`paid_at`/`verified_at`/`completed_at`, `provider_payload` jsonb |
| `checkout_orders` | same Paystack trail + `provider_reference`/`status`/`message` + full timestamp set |
| `transactions` | `provider_*` fields, `fulfillment_attempts`, `charged_at`/`fulfilled_at`/`refunded_at`/`last_provider_sync_at`, `provider_payload` + `provider_response` jsonb |
| `sessions` | `ip`, `user_agent`, `last_seen_at`, `created_at` — a login trail, unused for security review |
| stdout | `console.error` / `console.warn` on every money-safety refusal (mismatch, lockout, float, replay) |
| `scripts/report-wallet-audit.ts`, `report-paystack-transactions.ts` | offline read-only forensic reports |

Note that the codebase is scrupulous about **not** logging secrets — the CI workflow even fails the
build if the Paystack key appears in any captured log. Any admin audit log must uphold that.

**Gap:** nothing records an *actor*. That is fine today, because no human can take an
administrative action. The moment the dashboard can, an actor-attributed append-only log becomes a
hard prerequisite — see Phase 3.

---

## J. Existing routes / API endpoints

### Pages (all gated by `src/proxy.ts` to *signed-in*, no finer authorization)

`/` `/data` `/airtime` `/convert` `/rewards` `/wallet` `/agent` `/history` `/schedule` `/settings`
`/more` `/alerts` `/track/[ref]` `/checkout/complete`
Auth shell (no session required): `/login` `/register` `/forgot-password` `/reset-password`

**There is no `/admin` and no `/api/admin`.** Both namespaces are free.

### API routes

| Route | Method | Auth | Relevance to admin dashboard |
|---|---|---|---|
| `/api/auth/register` | POST | public | Users (H) |
| `/api/auth/login` | POST | public | ⚠ no rate limiting |
| `/api/auth/logout` | POST | session | |
| `/api/auth/me` | GET | session | shape to mirror for `/api/admin/me` |
| `/api/auth/forgot-password` | POST | public | ⚠ no rate limiting |
| `/api/auth/reset-password` | POST | token | |
| `/api/account/profile` | PATCH | session | |
| `/api/account/password` | POST | session | |
| `/api/account/notifications` | PATCH | session | |
| `/api/account/sessions` | GET/DELETE | session | session-revocation pattern to reuse for admins |
| `/api/wallet/fund` | POST | session + prod lock | **Deposits (4)** |
| `/api/wallet/deposit` | GET | session, owner-scoped | read-only deposit status — good model |
| `/api/wallet/transfer` | POST | session | **Wallets (3)** |
| `/api/payments/verify` | POST | session, owner-scoped | **Paystack (4)** |
| `/api/payments/webhook` | POST | **HMAC-SHA512 signature** | **Paystack (4)** |
| `/api/checkout` | POST | session | **Purchases (5)** |
| `/api/checkout/verify` | POST | session, owner-scoped | **Purchases (5)** |
| `/api/purchase` | POST | session | **Purchases (5)** |
| `/api/purchase/callback` | POST | **HMAC-SHA256 signature** | **Delivery (6,7)** |
| `/api/track/[ref]` | GET | session, owner-scoped | **Delivery (6,7)** — reuse `buildTrackingInfo` |
| `/api/convert` | POST | session, 503 in prod | |
| `/api/rewards/redeem` | POST | session | |
| `/api/schedule` | POST/DELETE | session | |
| `/api/agent/register` | POST | session | not an admin role |
| `/api/health` | GET | **public** | ⚠ see §L-11: runs DDL and leaks config posture |

---

## K. Existing database tables relevant to the admin dashboard

11 tables, 7 enums (`tx_type`, `tx_status`, `fulfillment_status`, `direction`, `deposit_status`,
`checkout_payment_status`, `checkout_order_status`).

| Table | Feeds dashboard section | Notes |
|---|---|---|
| `users` | 1, 2, 13 | holds the dormant `is_admin` |
| `sessions` | 2, 11, 14 | ip/UA/last-seen — a login-activity view for free |
| `password_resets` | 2, 11 | reset-abuse signal |
| `wallets` | 1, 3, 8 | ⚠ `user_id` nullable + non-unique |
| `transactions` | 1, 5, 6, 7, 8, 9, 12 | the ledger; ⚠ no FK to wallets |
| `deposit_requests` | 1, 4, 8, 12 | full Paystack audit columns, indexed on wallet + status |
| `checkout_orders` | 1, 5, 6, 7, 9, 12 | indexed on user + order_status; **holds the `fulfillment_failed` queue** |
| `provider_float_balances` | 1, 11 | already has `low_balance_threshold` → alert source |
| `bundle_plans` | 5, 12 | pricing/margin (`price` vs `retail_price`) |
| `price_alerts` | ❌ **not** section 11 | **customer-facing marketing banners** shown by `AlertsBell`. Do **not** repurpose for system alerts. |
| `scheduled_topups` | 5 | recurring orders |
| `agent_profiles` | 2 | customer tier, not a role |

### Tables that would be needed and do not exist

| Dashboard requirement | Table needed | Phase |
|---|---|---|
| 10. Customer issues / support cases | `support_cases`, `support_case_notes` | 4 |
| 11. System alerts | `system_alerts` (distinct from `price_alerts`) | 2 (derived) → 3 (persisted) |
| 13. Admin users and roles | `admin_roles`, `admin_role_assignments` | 3 |
| 14. Admin audit logs | `admin_audit_logs` (append-only) | 3 |
| 9. Refunds / reversals | `wallet_adjustments` (request + approval, maker–checker) | 5 |
| 15. Emergency / system controls | `system_controls` | 6 |

Per your instruction, **no migrations are created now.** They are staged into Phases 3–6, each
strictly additive, each requiring your explicit approval.

---

## L. Security concerns to address before building the dashboard

Ordered by severity for this project.

### L-1 — `is_admin` is dormant, unenforced and unprovisioned 🔴
A flag nobody checks is not an authorization system. Before any `/admin` page exists there must be
(a) a server-side gate that reads it from the database on every request, and (b) a **deliberate,
non-API provisioning path** (a CLI script, run by an operator against the database). There must
never be an HTTP endpoint that grants admin.

**Recommendation:** require **two** independent signals in Phase 0 — `users.is_admin = true`
**AND** the user's email present in an `ADMIN_EMAILS` server-side allowlist. Compromising the
database alone, or the environment alone, is then not enough.

### L-2 — Never put the admin claim in the `fd_auth` cookie 🔴
`fd_auth` is a 30-day, HMAC-signed, self-contained envelope. An `isAdmin` claim inside it would be
**unrevocable for 30 days** — demoting an admin, or an admin leaving, would not take effect.
Authorization must be resolved from the database on every admin request.

### L-3 — The Edge gate cannot be the admin gate 🔴
`src/proxy.ts` (a) never touches the database so it cannot see revocation or `is_admin`, and (b)
**explicitly skips `/api/**`**. Therefore:
- `proxy.ts` may only fail *closed* (unauthenticated → `/login`).
- **Every single `/api/admin/**` handler must call the admin gate itself, first thing.** There is no
  middleware safety net for API routes in this app.

### L-4 — `FLEXIDATA_TEST_USER_ID` is an impersonation seam 🔴
```ts
if (process.env.NODE_ENV !== "production" && process.env.FLEXIDATA_TEST_USER_ID) {
  return getAuthUserById(Number(process.env.FLEXIDATA_TEST_USER_ID));
}
```
Any deployment not running with `NODE_ENV=production` (previews, staging, a misconfigured host) can
be fully impersonated by setting one environment variable — and once `/admin` exists, that becomes
**admin impersonation with no cookie and no session row**. Harden before shipping the dashboard:
have the admin gate refuse to honour the seam, or require an additional explicit
`FLEXIDATA_TEST_ALLOW_ADMIN=1`.

### L-5 — No CSRF defence beyond `sameSite=lax` 🟠
`lax` blocks cross-site form POSTs, which covers the common case, but there is no token and no
`Origin`/`Sec-Fetch-Site` validation anywhere. Admin mutations (Phases 4–6) should require
`content-type: application/json`, a same-origin `Origin`/`Sec-Fetch-Site` check, and `POST`.

### L-6 — No rate limiting or lockout anywhere 🟠
Grep for `rate.?limit|throttle` → zero hits. `/api/auth/login` and `/api/auth/forgot-password` are
unthrottled. Admin login, admin search and any admin export must be throttled — an admin credential
is worth far more than a customer one.

### L-7 — No step-up / 2FA, and a 30-day session TTL 🟠
30 days is reasonable for a customer, excessive for an administrator. Admin sessions should have a
much shorter effective window, and Phase 5 financial actions should require password re-entry
(step-up) at minimum.

### L-8 — Referential-integrity gaps make admin joins fragile 🟡
`transactions`, `deposit_requests`, `checkout_orders`, `scheduled_topups`, `agent_profiles` have
**no FK to `wallets`/`users`**. Admin queries must use `LEFT JOIN` and render orphans explicitly.
Do **not** add FKs (that is a migration and could fail on existing data) — instead surface orphans
as reconciliation findings.

### L-9 — `wallets.user_id` is nullable and non-unique 🟡
Duplicate or userless wallets are possible, and `getWalletRowForUser()` silently picks one. This is
a first-class reconciliation check for Phase 2. The dashboard must **report** it, not repair it.

### L-10 — Raw provider payloads may contain PII/credentials 🟡
`transactions.provider_payload` / `provider_response` and `deposit_requests.provider_payload` are
free-form jsonb from external systems. **Never dump them raw into the admin UI.** Whitelist fields;
put the raw blob behind an explicit, audited "reveal" action (Phase 3+).

### L-11 — `/api/health` is public, runs DDL, and leaks posture 🟡
It executes `repairCheckoutOrdersSchema()` (additive DDL) unauthenticated, and returns payments
provider, Paystack test/live mode, schema-drift details and email-transport status. No secrets leak,
but it is a reconnaissance surface. **Do not change it as part of this project** — instead give the
admin dashboard its own richer, gated diagnostics view, and flag the public endpoint for a separate
hardening decision.

### L-12 — PII aggregation is itself a new risk 🟡
The dashboard concentrates emails, phone numbers, balances and transaction histories on one screen.
Mitigations: mask by default (`024••••567`, `k•••@gmail.com`) with an audited reveal; no bulk CSV
export in Phase 1; log every list/detail view once audit logging exists.

### L-13 — Never surface secrets 🟡
`PAYSTACK_SECRET_KEY`, `DATA_API_KEY/SECRET/TOKEN`, `AUTH_SECRET`, `DATABASE_URL` must never reach
an admin response. `paystackMode()` (`"test" | "live" | "unconfigured"`) is safe and is the
correct thing to display.

### L-14 — Patterns not to copy 🟡
`/api/convert` uses a read-modify-write balance update, and airtime fulfilment uses `Math.random()`.
Both are dev-only, but they generate ledger rows that will look like discrepancies in non-production
reconciliation runs. The reconciliation engine should be aware of them; the admin code should never
imitate them.

---

## M. Recommended architecture for the Admin & Operations Dashboard

### Guiding principles

1. **Additive only.** New namespaces (`/admin`, `/api/admin`, `src/lib/admin`) with no collisions.
   Exactly **one** existing file needs a one-line change in Phase 1 (see below).
2. **Read-only until proven.** Phases 1–2 are physically incapable of writing — enforced by a
   `SET TRANSACTION READ ONLY` wrapper, not by discipline alone.
3. **Authorize on the server, at every layer.** Layout gate → route-handler gate → query-layer
   assertion. Hiding UI is never the control.
4. **Money moves only the way it already moves.** New ledger row + atomic SQL arithmetic + one
   transaction. Never an assignment to `wallets.balance`.

### Layered authorization (defence in depth)

```
Layer 0  src/proxy.ts            unauthenticated → /login   (already true; fail-closed only)
Layer 1  src/app/admin/layout.tsx    await requireAdmin()  → notFound() for non-admins
Layer 2  every /api/admin/** handler  await requireAdminApi() as the FIRST statement
Layer 3  src/lib/admin/queries.ts    every function takes an AdminContext that ONLY the gate can mint
Layer 4  src/lib/admin/db.ts         read-only transaction wrapper (Phases 1–2)
```

**Return `notFound()` (404), not 403,** for non-admins hitting `/admin` — no oracle telling a
curious customer that an admin panel exists.

### Proposed file layout (all new)

```
flexiData/src/
├── app/
│   ├── admin/
│   │   ├── layout.tsx              requireAdmin() + admin chrome (server component)
│   │   ├── page.tsx                1. Overview
│   │   ├── users/page.tsx          2. Users & accounts
│   │   ├── wallets/page.tsx        3. Wallets & balances
│   │   ├── deposits/page.tsx       4. Deposits & Paystack
│   │   ├── purchases/page.tsx      5. Data purchases
│   │   ├── deliveries/page.tsx     6+7. Delivery status & failed/pending queues
│   │   ├── reconciliation/page.tsx 8. Wallet reconciliation
│   │   ├── alerts/page.tsx         11. System alerts
│   │   ├── reports/page.tsx        12. Reports
│   │   └── (later) refunds/, support/, admins/, audit/, controls/
│   └── api/admin/
│       ├── overview/route.ts
│       ├── users/route.ts
│       ├── wallets/route.ts
│       ├── deposits/route.ts
│       ├── orders/route.ts
│       └── reconciliation/route.ts
├── components/admin/               admin-only UI (nav, data table, filters, status pills, money cell)
└── lib/admin/
    ├── auth.ts                     getAdminUser, requireAdmin, requireAdminApi, AdminContext
    ├── db.ts                       withReadOnlyTx() — SET TRANSACTION READ ONLY
    ├── queries.ts                  SELECT-only, schema-compat aware, paginated
    ├── reconciliation.ts           PURE functions: rows in → classified discrepancies out
    ├── redact.ts                   phone/email masking
    ├── audit.ts                    (Phase 3) append-only writer
    └── types.ts
```

### The one existing file that must change (Phase 1)

`src/components/app-chrome.tsx` currently renders `SideNav` + `BottomNav` for every non-auth route.
It already has the exact mechanism needed — a list of routes that get a bare shell:

```ts
const AUTH_ROUTES = ["/login", "/register", "/forgot-password", "/reset-password"];
```

Adding `/admin` to that bare-shell check is a **one-line, additive, trivially revertible** change
that keeps customer navigation out of the admin area and admin navigation out of the customer
bundle. No other existing file needs to be modified in Phase 1.

*(Rejected alternative: restructuring the app into `(app)` / `(admin)` route groups with separate
root layouts. It is architecturally cleaner but requires moving every existing page — precisely the
kind of disruption you ruled out.)*

Optionally, `src/proxy.ts` may later get an additive fail-closed branch for `/admin`. It is not
required — the existing rule already redirects signed-out visitors to `/login`.

### Files that must NOT be touched

`src/db/schema.ts` · `drizzle/**` · `src/lib/deposits.ts` · `src/lib/checkout.ts` ·
`src/lib/payments.ts` · `src/lib/paystack.ts` · `src/lib/data-gateway.ts` · `src/lib/auth.ts`\* ·
`src/app/api/purchase/**` · `src/app/api/payments/**` · `src/app/api/wallet/**` ·
`src/app/api/checkout/**`

\* One narrowly-scoped exception is likely needed in Phase 0: teaching `getAuthUserById()` to select
`users.is_admin`, or (preferred) adding a **separate** `getAdminFlag(userId)` query in
`src/lib/admin/auth.ts` so `src/lib/auth.ts` is not modified at all. The second option keeps the
"do not touch existing auth" constraint intact and is what I would recommend.

### Financial-action model (Phase 5 — design fixed now, built later)

- **No endpoint ever accepts a target balance.** The only admin-initiated money primitive is
  *"create an adjustment transaction of amount X, in direction D, with reason R, referencing
  original ref F."*
- Implementation mirrors `settleAtomic()`: one `db.transaction`, an idempotency claim on a derived
  unique `transactions.ref` (e.g. `ADJ-<originalRef>-<seq>`), `balance = balance ± amount` in SQL,
  ledger insert, audit insert — all or nothing.
- **Maker–checker:** admin A creates a `wallet_adjustments` request (no money moves); admin B, a
  different user, approves it (money moves). Amount caps per role.
- Every adjustment is reversible only by another adjustment. Nothing is ever deleted or edited.

---

## Safest place to implement — direct answer

> **`flexiData/src/app/admin/` (UI) + `flexiData/src/app/api/admin/` (JSON) +
> `flexiData/src/lib/admin/` (logic), with the admin gate living in `src/lib/admin/auth.ts`.**

Why this is the safest location in *this specific* codebase:

1. **Both namespaces are completely unused.** No `/admin` page, no `/api/admin` route, no `admin`
   directory anywhere. Zero collision risk with existing functionality.
2. **The Edge gate already covers `/admin` for free.** `proxy.ts`'s matcher is a catch-all, and its
   "signed-out → `/login`" rule applies to `/admin` today, before a line is written. The baseline is
   already fail-closed.
3. **`/api/admin/**` is correctly *excluded* from the Edge gate**, which forces each handler to gate
   itself — the right posture for API authorization, and consistent with how every existing money
   route already calls `requireAccount()` explicitly.
4. **`src/lib/admin/` mirrors the established convention.** All business logic lives in flat modules
   under `src/lib/`; a subdirectory is a natural, non-invasive extension, and `@/lib/admin/...`
   resolves through the existing tsconfig path alias.
5. **It touches one existing line.** Only `app-chrome.tsx` needs the `/admin` bare-shell entry, using
   a mechanism that already exists for the auth routes.
6. **There is proven read-only precedent to copy.** `scripts/report-wallet-audit.ts` already
   demonstrates the exact safety discipline (SELECT-only assertions, write/DDL keyword rejection,
   read-only transaction) that Phase 1's query layer should adopt.
7. **The customer app is untouched at runtime.** Admin pages are separate route segments; admin
   components never enter the customer bundle; no existing library, route or table is modified.

---

## Phased implementation plan

**Nothing below is implemented. Each phase is a separate, reviewable change set, and Phases 3+ each
require your explicit approval before any migration is written.**

### Phase 0 — Access control foundation (no dashboard) 🔒
*Goal: make "who is an admin" a real, enforced, revocable answer — before there is anything to see.*

- `src/lib/admin/auth.ts`: `getAdminUser()`, `requireAdmin()` (RSC → `notFound()`),
  `requireAdminApi()` (→ `404` JSON), `AdminContext` (unforgeable outside the gate).
- Authorization requires **both** `users.is_admin = true` (read fresh from the DB every request)
  **and** email ∈ `ADMIN_EMAILS` allowlist.
- Neutralise the `FLEXIDATA_TEST_USER_ID` seam for admin paths (L-4).
- **Provisioning:** `scripts/grant-admin.ts` — an operator-run CLI that flips `is_admin` for one
  named email and prints an explicit confirmation. No HTTP path grants admin, ever.
- A single smoke route (`/api/admin/me`) to prove the gate, plus
  `scripts/verify-admin-access.ts` asserting: anonymous → 404, normal user → 404, `is_admin` without
  allowlist → 404, allowlist without `is_admin` → 404, both → 200.
- **No migration. No schema change. No UI.**
- ✅ *Done when:* a normal user cannot distinguish `/admin` from a non-existent page, verified by script.

### Phase 1 — Read-only dashboard 👁 *(requirements 1–7)*
*Goal: total visibility, structurally incapable of changing anything.*

- `src/lib/admin/db.ts` → `withReadOnlyTx()` wrapping every query in
  `SET TRANSACTION READ ONLY` — the database itself refuses writes.
- `src/lib/admin/queries.ts` — SELECT-only, paginated, `LEFT JOIN`-defensive (L-8),
  schema-compat-aware, PII masked by default (L-12).
- Pages:
  1. **Overview** — users, wallets, total balance held, deposits (today/7d/30d), purchase volume,
     delivery success rate, in-flight orders, provider float vs threshold, Paystack mode.
  2. **Users & accounts** — search by email/phone/referral code; detail: wallet, sessions
     (ip/UA/last-seen), referral tree, order history.
  3. **Wallets & balances** — sortable list, ledger drill-down. **Display only.**
  4. **Deposits & Paystack** — `deposit_requests` filtered by status, with the full Paystack audit
     trail; highlight the "verification mismatch" parked rows.
  5. **Data purchases** — unified view over `transactions` (wallet-funded) + `checkout_orders`
     (pay-as-you-go).
  6. **Delivery status** — reuse `buildTrackingInfo()` from `src/lib/fulfillment.ts` verbatim.
  7. **Failed / pending / successful queues** — *the highest-value screen*: the
     `checkout_orders.order_status = 'fulfillment_failed'` backlog that `src/lib/checkout.ts:541`
     currently leaves to psql, plus stale `pending` orders and parked deposits.
- **No migration. No writes. No exports.**
- ✅ *Done when:* an operator can answer "what is broken and for whom" without opening a SQL client.

### Phase 2 — Reconciliation & monitoring 🔍 *(requirements 8, 11, 12 — still read-only)*
*Goal: detect and classify discrepancies. Never correct them.*

- `src/lib/admin/reconciliation.ts` — **pure** functions (rows in → findings out), unit-testable,
  encoding the §E nuances: `charged_at IS NULL` means no money moved; `refunded_at` marks a
  reversal; transfers are two rows; points ≠ cash.
- Checks: wallet balance vs derived ledger sum · settled deposits with no ledger row (and vice
  versa) · orphan `wallet_id`s (L-8) · duplicate/userless wallets (L-9) · orders paid but never
  fulfilled · `transactions` vs `checkout_orders` divergence · `paystack_transaction_id` collisions.
- Every finding is **classified** (`expected` / `investigate` / `critical`) with an explanation and
  drill-down. **No "fix" button exists in this phase.**
- **System alerts (11)** — derived at read time in Phase 2 (float below threshold, failure-rate
  spike, stuck-order age, deposit mismatch count). Explicitly **separate** from `price_alerts`,
  which is customer marketing (§K).
- **Reports (12)** — on-screen only: daily volume, revenue (`price` vs `retail_price` margin),
  delivery SLA, deposit conversion, top plans. **CSV export deferred to Phase 3**, so it can be
  audited from day one.
- **No migration. Still zero writes.**
- ✅ *Done when:* every discrepancy in the production database is either explained or flagged, and
  the reconciliation logic is covered by unit tests.

### Phase 3 — Audit logging & admin RBAC 📋 *(requirements 13, 14)* — **first migration; needs approval**
*Goal: before any admin can change anything, everything an admin does is recorded.*

- **Additive migration only:** `admin_roles`, `admin_role_assignments`, `admin_audit_logs`
  (append-only: actor, role, action, target type/id, before/after JSON, ip, user_agent, request id,
  timestamp; `REVOKE UPDATE, DELETE` on the log table).
- Roles: `viewer` (Phase 1–2 read), `support` (Phase 4 cases), `finance` (Phase 5 proposals),
  `approver` (Phase 5 approvals), `superadmin`. `is_admin` + allowlist remains the outer gate;
  roles refine it.
- **Retro-apply:** log Phase 1–2 activity too — PII reveals, list views, report generation, CSV
  exports (now enabled).
- Shorter admin session window + step-up re-auth scaffolding (L-7).
- Rate limiting on admin auth and search (L-6); `Origin`/`Sec-Fetch-Site` checks (L-5).
- ✅ *Done when:* no admin-reachable code path can execute without writing an audit row, verified by
  a test that fails if a handler is added without one.

### Phase 4 — Support & case management 🎫 *(requirement 10)* — low-risk writes, **no money**
- Additive migration: `support_cases`, `support_case_notes`.
- Create a case from any order/deposit/user; assign, comment, status, resolve; link by `ref`.
- **These are the first writes in the project — and they deliberately touch no financial table.**
  This is the rehearsal for Phase 5's guardrails on a low-stakes surface.
- ✅ *Done when:* the `fulfillment_failed` backlog from Phase 1 can be worked as a tracked queue.

### Phase 5 — Controlled financial actions 💰 *(requirement 9)* — **highest risk; strictest gate**
- Additive migration: `wallet_adjustments` (request/approval, maker–checker).
- **Hard rules, non-negotiable:**
  - No API accepts a target balance. The only primitive is an **adjustment transaction**.
  - Money moves exactly as `settleAtomic()` does: one `db.transaction`, idempotency claim on a
    derived unique `transactions.ref`, `balance = balance ± amount` in SQL, ledger insert, audit
    insert — atomically.
  - **Two distinct admins** required: proposer ≠ approver. Per-role amount caps.
  - Step-up re-authentication on approval.
  - Every adjustment references its original transaction and a reason code.
  - Reversal of a mistake is a *new* adjustment. Nothing is edited or deleted.
- Paystack refunds (if introduced) go through Paystack's API and are reconciled by the **existing**
  verify path — the admin dashboard never marks a payment refunded on its own authority.
- ✅ *Done when:* an adversarial test suite proves no sequence of admin requests can set an arbitrary
  balance, double-apply an adjustment, or move money with a single admin.

### Phase 6 — Emergency & system controls 🚨 *(requirement 15)*
- Additive migration: `system_controls` (key, enabled, reason, actor, timestamp).
- Kill switches: pause wallet funding · pause data purchases · pause a specific network · pause
  checkout · maintenance banner.
- **Fail-safe defaults:** an unreadable/missing control table means *normal operation* for reads and
  *blocked* for money movement — never the reverse.
- Every toggle is audited with a mandatory reason; auto-expiry with re-confirmation.
- Consumed by existing routes via a **single additive guard call** — no rewrite of payment or
  delivery logic.
- ✅ *Done when:* an operator can stop money movement in one click, and the audit log says who,
  when and why.

### Requirement → phase map

| # | Requirement | Data available today? | Phase |
|---|---|---|---|
| 1 | Dashboard overview | ✅ all tables | 1 |
| 2 | Users and accounts | ✅ `users`, `sessions`, `agent_profiles` | 1 |
| 3 | Wallets and balances | ✅ `wallets` | 1 (read-only) |
| 4 | Deposits & Paystack | ✅ `deposit_requests` (full audit cols) | 1 |
| 5 | Data purchases | ✅ `transactions` + `checkout_orders` | 1 |
| 6 | Data delivery status | ✅ `fulfillment_status` + `buildTrackingInfo` | 1 |
| 7 | Failed/pending/successful | ✅ `checkout_orders.order_status` | 1 |
| 8 | Reconciliation | ✅ derivable | 2 |
| 9 | Refunds / reversals | ⚠ needs `wallet_adjustments` | 5 |
| 10 | Support cases | ❌ needs new tables | 4 |
| 11 | System alerts | ⚠ derivable; `price_alerts` is NOT this | 2 → 3 |
| 12 | Reports | ✅ derivable | 2 (export in 3) |
| 13 | Admin users & roles | ⚠ only dormant `is_admin` | 0 → 3 |
| 14 | Admin audit logs | ❌ nothing exists | 3 |
| 15 | Emergency controls | ❌ needs new table | 6 |

---

## Recommended next step

Approve **Phase 0** only. It is small, self-contained, adds no tables and no UI, and it converts
`is_admin` from a dormant flag into an enforced, revocable, script-provisioned control — with a
verification script proving a normal user cannot tell `/admin` exists. Everything afterwards depends
on that gate being right.
