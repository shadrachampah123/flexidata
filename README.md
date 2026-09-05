# FlexiData

A sleek, mobile-first **data bundle & airtime vending app** for Ghana — built around the
same feature set as Ghana's leading data-selling platforms (DataPlug, RemaData,
MyDataBundle, GetDataGH, DataSika): real user accounts, a funded wallet, instant MTN &
Telecel bundle delivery, referral rewards and a vendor/agent program.

## Features

- **Create account** — name, email, Ghanaian phone number and password, with optional
  referral code. Every account gets its own wallet starting at GH₵ 0.00.
- **Login** with email **or** phone number + password.
- **Forgot password** — a single-use, 1-hour reset link is emailed (in development the
  link is also returned by the API and logged to the console, so the flow is testable
  without an email provider).
- **Settings** — edit profile, change password, notification preferences, manage active
  devices/sessions, copy your referral code, and **log out**.
- **Wallet** — fund with [Paystack](https://paystack.com): pick MTN MoMo, Telecel Cash or
  card, pay on Paystack's hosted checkout, and the wallet is credited only after the
  server verifies the charge (see [Wallet deposits](#wallet-deposits-paystack)). Money
  can also be transferred to any other registered FlexiData user. A simulated instant
  MoMo deposit still exists for offline development demos (`PAYMENTS_PROVIDER=mock`) but
  is **hard-disabled in production**: there, deposits run only through verified Paystack
  charges, the fund API refuses any demo/mock request server-side, and the demo UI is
  removed from production builds.
- **Shop** — discounted MTN (UP2U, SME non-expiry, Corporate, Social) & Telecel bundles,
  airtime at 2% off, and airtime-to-cash conversion.
- **Order tracking** — every data/airtime order gets a live delivery tracker with an
  **estimated delivery countdown** ("Arriving in about 1m 20s"), a stage-by-stage
  timeline (placed → paid → sent to network → processing → delivered), and a progress
  bar. In-flight orders surface on the home screen under **Active deliveries**, on the
  purchase receipt ("Track this order"), and on each history row. The tracker reads the
  real fulfillment ledger (`fulfillment_status`, `charged_at`, `fulfilled_at`, provider
  references) and polls `GET /api/track/[ref]` — scoped to the owner's wallet — until the
  bundle lands, is refunded, or fails. See
  [`src/lib/fulfillment.ts`](flexiData/src/lib/fulfillment.ts) for the ETA model.
- **Rewards** — points on every purchase, redeemable for cash/airtime/data, plus a
  referral bonus when a friend you invited makes their first purchase.
- **Agent program** — activate a vendor profile with your own referral code, tiers and
  commission tracking.

> Data fulfillment runs against the mock provider in local development. Point the data
> gateway environment variables below at a real Ghanaian data-API aggregator for live
> MTN / Telecel delivery.

## Stack

- **Next.js 16** (App Router, Turbopack, `proxy.ts` route protection)
- **React 19**
- **Tailwind CSS 4**
- **Drizzle ORM** + **PostgreSQL**
- Zero-dependency auth: scrypt password hashing, HMAC-signed session cookies,
  server-side `sessions` table (Node `crypto` only)
- Self-hosted variable fonts (Manrope + Space Grotesk)

## Getting started

```bash
cd flexiData
npm install

# 1. Configure the environment
cp .env.example .env.local
#   - set DATABASE_URL to your Postgres
#   - set AUTH_SECRET to a long random string:
#       node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 2. Create the schema
npx drizzle-kit push    # targets DATABASE_URL from .env.local — see "Migrations"

# 3. Run the app (seeds the shared bundle catalog on first request)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `npm run dev`       | Start the dev server                 |
| `npm run build`     | Production build                     |
| `npm run start`     | Serve the production build           |
| `npm run lint`      | Run ESLint                           |
| `npm run typecheck` | Type-check with TypeScript           |
| `npm run verify:schema-compat` | Run the data-gateway schema fallback scenarios |
| `npm run verify:schema-baseline` | Probe a pre-gateway database for the fallback behaviour |
| `npm run verify:seed-resilience` | Check the shared catalog seed can't take sign-up down on a lagging schema |
| `npm run verify:signup` | Sign-up regression checks against a real database (needs `DATABASE_URL`) |
| `npm run verify:demo-deposit-cleanup` | Prove the demo-deposit cleanup tool reverses only mock credits (in-memory, no database needed) |
| `npm run cleanup:demo-deposits` | Review-first reversal of demo/mock wallet deposit credits (`--apply` to run) |
| `npm run admin:email` | Rename an administrator's login email in place (`--from`/`--to`, `--yes` to apply) |
| `npm run verify:admin-email-change` | Prove the rename touches one row and nothing else, against a real PostgreSQL |

## Renaming the administrator's email address

An administrator's login address is renamed **in place** — the same `users` row,
the same `id`, the same password hash, the same wallet and the same live
sessions. A second account is never created, and no financial record is
rewritten.

```bash
cd flexiData

# 1. Inspect the account you are about to rename (read-only).
npm run admin:email -- --from shadrachampah@gmail.com --status

# 2. Dry run: prints the exact UPDATE and everything it preserves. No write.
npm run admin:email -- --from shadrachampah@gmail.com --to shadrachampah123@gmail.com

# 3. Apply it.
npm run admin:email -- --from shadrachampah@gmail.com --to shadrachampah123@gmail.com --yes
```

The tool refuses to run — changing nothing — when

- no account has the `--from` address, or
- that account has `users.is_admin = false` (this tool only renames an
  administrator, so a customer's address can never be repointed by mistake), or
- **any** account already uses the `--to` address (checked case-insensitively
  before anything is written; `users.email` is `UNIQUE`), or
- `--yes` is missing (the default is a dry run).

What it writes is exactly one statement, scoped to one row:

```sql
update "users" set "email" = $1, "updated_at" = now()
 where "id" = $2 and "email" = $3 and "is_admin" = true
```

Everything else is guarded three ways. A statement guard refuses to send
anything that is not a read or that exact UPDATE, so the tool has no code path
to a wallet, a balance, a ledger row, a deposit, a checkout order, a scheduled
top-up or a session. Inside the same transaction — *before* `COMMIT` — it
re-reads an md5 content digest of every financial table and re-counts the
admins, the users, the wallets and the sessions; any mismatch rolls the whole
thing back. After `COMMIT` it reports that exactly one admin holds the new
address and that the row differs from its pre-rename snapshot in `email` and
`updated_at` alone.

Two follow-ups the tool prints for you:

- **`ADMIN_EMAILS` must be updated to the new address.** The admin gate needs
  both `users.is_admin = true` *and* an entry in that environment allowlist, so
  a renamed admin is locked out of `/admin` on their next request until the
  variable lists the new address. The tool says so when the allowlist still
  holds the old one.
- **History keeps the old address on purpose.** `checkout_orders.customer_email`
  is a point-in-time record of what Paystack was told, so it is not rewritten.

`npm run verify:admin-email-change` proves all of the above against a real
PostgreSQL: it spawns the CLI the way an operator does, seeds an admin with a
wallet, sessions, ledger rows, a Paystack deposit and a paid checkout order, and
asserts that every refusal changes nothing, that the rename changes only
`email` + `updated_at`, that every other table is byte-identical, that the new
address signs in with the *same* password while the old one no longer does, and
that the same live session still passes the admin gate once the allowlist
catches up. It uses `DATABASE_URL` only when `FLEXIDATA_ADMIN_EMAIL_TEST_DB=1`
is also set, and otherwise starts a throwaway cluster through the optional
`embedded-postgres` package (`npm i --no-save embedded-postgres`). With no
database available it **fails** rather than reporting a hollow pass.

## Wallet deposits (Paystack)

The **Deposit / Add money** button on `/wallet` runs a real Paystack charge. The
simulated MTN MoMo top-up is no longer on that path: it only runs if you
explicitly set `PAYMENTS_PROVIDER=mock` (a demo aid — it credits the wallet with
**no real payment**) **and the runtime is not production**. In a production
runtime (`NODE_ENV=production`) demo/mock deposits are hard-disabled at every
layer:

- `paymentsProvider()` refuses to resolve to the mock provider (fail-closed
  production lockout — with `PAYMENTS_PROVIDER=mock`, or with no Paystack key
  configured, wallet funding returns `503 paystack_unconfigured`).
- `POST /api/wallet/fund` re-checks the lock **before authentication**: any
  request that could resolve to a non-Paystack provider is rejected server-side,
  so the disabled UI cannot be bypassed by calling the API directly.
- The deposit service (`src/lib/deposits.ts`) refuses to create or settle a
  non-Paystack deposit in production — `reconcileDeposit` parks any legacy mock
  deposit as `failed` (never credited) and `settleAtomic`, the single
  money-movement choke point, throws before touching a wallet. A mock provider
  can therefore never credit a real wallet in production, through any route,
  webhook or future caller.
- Production client builds hard-disable the demo top-up UI (the controls and
  the demo "Approve deposit" flow are removed; `NODE_ENV` is inlined at build
  time), so the demo deposit button cannot appear in production even with
  tampered client state.


```
GH₵ 20 → POST /api/wallet/fund                    (session required)
           ├─ validates GH₵ 5 – GH₵ 5,000; wallet resolved from the SESSION
           ├─ INSERT deposit_requests (status=pending, amount_subunits=2000 pesewas)
           ├─ Paystack POST /transaction/initialize   (secret key, server-side)
           └─ 200 { status:"pending", ref:"DP-…", authorizationUrl }
       → browser navigates to the Paystack TEST checkout, customer pays
       → Paystack redirects back to /wallet?funding=success&ref=DP-…
           and/or POSTs /api/payments/webhook (charge.success, HMAC-SHA512)
       → POST /api/payments/verify { ref }         (session + owner of the ref)
           ├─ Paystack GET /transaction/verify/DP-…  ← the only source of truth
           ├─ requires status=success AND the same ref AND 2000 pesewas AND GHS
           └─ ONE db transaction: claim the deposit → balance = balance + 20.00
              → insert the ledger row (all three commit or none do)
       → UI: "+GH₵ 20.00 added!" / "Funded via Paystack. Your money is safe and ready."
```

| Endpoint | What it does |
| --- | --- |
| `POST /api/wallet/fund` | Validates the amount, writes the pending deposit, initializes Paystack, returns only the checkout URL + reference |
| `POST /api/payments/verify` | Verifies with Paystack and settles idempotently (auth + owner) |
| `GET /api/wallet/deposit?ref=` | Read-only status + fresh balance for the UI to poll (auth + owner) |
| `POST /api/payments/webhook` | Paystack `charge.*` events, signature-verified, re-verifies before settling |

Safety rules, all enforced server-side in
[`src/lib/deposits.ts`](flexiData/src/lib/deposits.ts):

- **The browser can never prove a payment.** Only Paystack's verify API (called
  with the secret key, server-side) can. The callback URL, the webhook payload
  and anything the client posts are *hints* that carry a reference, nothing more.
- **The amount can never be changed by the client.** The integer pesewa amount is
  validated and stored on the `deposit_requests` row *before* Paystack is called;
  verification must return exactly that integer (and `GHS`) or the deposit is
  parked as `failed` and not credited.
- **No double credit.** Settlement is one conditional
  `UPDATE … WHERE status IN ('pending','abandoned','failed') … RETURNING` inside a
  single transaction with the balance increment (`balance = balance + amount`, SQL
  arithmetic) and the ledger insert. The Paystack reference *is* the deposit's
  unique `ref`, so a replayed webhook / verify / poll loses the race and does
  nothing.
- **Failed, abandoned, mismatched or unverifiable → no credit.** The UI then says
  "Payment was not completed. Your wallet has not been credited."
- **Nobody can fund or read someone else's wallet.** The credited wallet is always
  the session user's own, and the status/verify endpoints return the same `404`
  for "does not exist" and "not yours".

`/api/health` reports the live configuration under `payments`
(`{"provider":"paystack","paystack":"test"}`) — the quickest way to confirm what a
deployment is actually doing, and it warns loudly when deposits are still mocked.

### Environment variables for TEST mode (Vercel)

| Variable | Value |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | your `sk_test_…` key (Paystack dashboard → Settings → API Keys & Webhooks, in **Test** mode) |
| `PAYMENTS_PROVIDER` | `paystack`, or leave it **unset** — unset now means "Paystack when a key is configured". **Remove it if it is currently `mock`**, that is what keeps deposits simulated |
| `APP_BASE_URL` | your public `https://<domain>` for the Paystack callback. If omitted, the request origin and then `VERCEL_URL` are used, so the redirect still works |
| `PAYSTACK_LIVE_MODE` | leave unset / `false` (a `sk_live_…` key is refused without it) |

None of these may be `NEXT_PUBLIC_…`. The secret key is read in exactly one
place — [`src/lib/paystack.ts`](flexiData/src/lib/paystack.ts), marked
`server-only` so a client-side import is a build error — and the deposit flow
uses Paystack's redirect (authorization URL) checkout, which needs no public key
in the browser at all.

Finally, set the webhook URL in the Paystack dashboard (Test mode) to
`https://<your-domain>/api/payments/webhook`. The redirect path already verifies
and settles on its own, so the webhook is a backstop for customers who close the
tab after paying — not the only way a deposit clears.

### Testing a GH₵ 20 deposit

1. Sign in → **Wallet** → **Fund wallet** → tap the `GH₵ 20` chip (or type `20`)
   → **Deposit GH₵ 20.00** → **Continue to Paystack**.
2. Paystack's TEST checkout opens. Pay with the test card `4084 0840 8408 4081`,
   any future expiry, CVV `408`, OTP `123456`. Mobile money is offered too, but it
   is not enabled on every Paystack *test* account — which is exactly why TEST mode
   widens the MoMo checkout to include the card channel.
3. Paystack sends you back to `/wallet?funding=success&ref=DP-…`. The sheet shows
   "Verifying payment…", then **"+GH₵ 20.00 added!"**, "Funded via Paystack. Your
   money is safe and ready.", the new balance re-read from the database, and the
   Paystack reference.
4. `/history` → **Deposits** shows *Wallet Top-up · +GH₵ 20.00 · Successful* with
   the subtitle `Paystack • MTN MoMo • DP-…`.
5. Close the checkout instead of paying and you get "Payment was not completed.
   Your wallet has not been credited." — the balance does not move, and the
   deposit row stays `pending`/`abandoned`.

Every one of those branches is covered automatically by
[Phase D of the E2E suite](#paystack-e2e-automated).

### Cleaning up demo/mock deposits

Before Paystack went live, the deposit button simulated an instant top-up: the
wallet was credited with **no real payment**, and a `deposit_requests` row
(`provider = "mock"`) plus a "Wallet Top-up" ledger row were written. The app
now hard-blocks creating those, but any demo credits already in the database
stay there until removed. `scripts/cleanup-demo-deposits.ts` reverses them,
review-first:

```bash
cd flexiData
npm run cleanup:demo-deposits              # DRY RUN — SELECTs only, prints a plan
npm run cleanup:demo-deposits -- --apply   # perform the cleanup (asks for confirmation)
```

For each demo credit it (1) debits the wallet with SQL arithmetic clamped at
zero (never below zero, never an absolute write), (2) parks the demo
`deposit_requests` row as `failed` with an audit note, and (3) marks the demo
ledger row `reversed` (or `failed` on a pre-gateway `tx_status` enum). It is
idempotent — a second run finds nothing left.

Safety rails, all proven by `npm run verify:demo-deposit-cleanup` (in-memory,
no database needed):

- **Review-first:** without `--apply` it only reads; nothing is written.
- **Never touches real money:** real Paystack deposits (matched by
  `deposit_requests.provider = "paystack"`), transfers (withdrawals),
  airtime-to-cash conversions, purchases, redemptions and referral rewards are
  all out of scope.
- **Production guard:** any non-local database target (Neon/Supabase/RDS/…,
  or a `NODE_ENV=production` runtime) is refused unless `--allow-production` is
  passed explicitly, and `--apply` still requires confirmation.
- **Shortfalls are reported, not invented:** if a wallet's demo balance has
  since been spent, only what remains is removed and the difference is shown as
  a shortfall.

## Paystack E2E (automated)

`scripts/paystack-e2e.mjs` is a fully automated end-to-end test of the
Paystack integration — no human steps, no browser required in CI. It is
triggered from GitHub Actions (`.github/workflows/paystack-e2e.yml`,
manual "Run workflow") and can also be run locally.

**Why it is shaped this way:** `checkout.paystack.com` sits behind a WAF that
blocks datacenter networks, so GitHub Actions runners get HTTP 403 on the
hosted checkout page and can never complete a test-card payment there. That is
an *environment* restriction, not an application failure — the real Paystack
TEST API works fine from CI. The suite therefore has three phases:

| Phase | Backend | What it proves |
| --- | --- | --- |
| **A** | Real Paystack TEST API (`api.paystack.co`) | Registration, order creation, **real** transaction init + verification of an unpaid charge (must stay unsettled), order privacy, and the full webhook security matrix (bad / missing / tampered / valid / unknown-ref signatures) with the real `sk_test_` key. The hosted checkout page is only *probed* — a 403 there is logged as an environment note, never a failure. |
| **B** | Local Paystack stub (`scripts/paystack-stub.mjs`, bound to 127.0.0.1) with the mock data provider set to succeed | The complete money flow through the app's real API routes: success (settle + fulfil exactly once, points, ledger), webhook-first settlement, duplicate-webhook idempotency, amount mismatch, currency mismatch, declined card, abandoned checkout, pending charge, and retry-within-the-same-checkout (declined → paid). |
| **C** | Same stub, mock data provider forced to fail | Paid-but-provider-failed: the order parks as `fulfillment_failed` and repeated verify/webhook hits never re-submit it (no double-sent bundles). |

Run it locally (needs a built app + Postgres + a TEST key):

```bash
cd flexiData
npm run build
node scripts/paystack-e2e.mjs            # full suite (real API + stub)
E2E_STUB_ONLY=1 node scripts/paystack-e2e.mjs   # offline: stub phase only
```

Optional, local machines only: `E2E_TRY_HOSTED_CHECKOUT=1` attempts a real
test-card payment on the *hosted* page with Puppeteer (`npm i --no-save
puppeteer`). It is best-effort and informational — the suite never fails on
the hosted page, which CI cannot reach anyway.

Safety: live (`sk_live_…`) keys are refused, the key is never printed (CI
fails the build if it ever appears in app or stub logs), the stub binds to
127.0.0.1 only, and the stub records only the *shape* of the app's bearer
header — never the key itself.

## Project layout

```
flexiData/
├─ drizzle.config.ts     # Drizzle ORM config (reads .env.local — see Migrations)
├─ src/
│  ├─ app/               # Routes, pages, layout & API routes
│  ├─ components/        # UI components
│  ├─ db/                # Drizzle client & schema
│  └─ lib/               # Constants, data access, seed & helpers
```

## Environment

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `AUTH_SECRET` | Long random string used to sign session cookies / reset tokens (required — sign-up fails before writing anything when it is missing, so no account can be orphaned) |
| `APP_BASE_URL` | Public deployment URL for links in emails & payment callbacks (e.g. `https://flexidata.app`). Optional for reset links: they are built from the origin of the incoming request, then `VERCEL_URL`, never `localhost` in production |
| `PAYMENTS_PROVIDER` | Which gateway funds the wallet: `paystack`, or `mock` for the instant **simulated** MoMo deposit — **development/demo environments only; ignored (refused) in production**, where deposits run only through verified Paystack charges. **Unset (recommended): Paystack whenever `PAYSTACK_SECRET_KEY` is set, `mock` otherwise** — a Paystack-configured deployment can never silently fall back to simulated deposits. See [Wallet deposits](#wallet-deposits-paystack) |
| `PAYSTACK_SECRET_KEY` | Paystack secret key (`sk_test_…` for TEST mode). Server-only — never sent to the browser, never logged. Required for wallet deposits and the data-bundle checkout |
| `PAYSTACK_PUBLIC_KEY` | Optional and currently unused: the redirect/authorization-URL flow needs no client-side key. Safe to set (`pk_test_…`); nothing key-related reaches the browser either way |
| `PAYSTACK_LIVE_MODE` | Safety lock. A `sk_live_…` key is refused unless this is `true`, so going live is a deliberate two-step change. Leave unset/false while testing |
| `RESEND_API_KEY` | Recommended: Resend API key for direct password-reset email delivery. Set it together with `RESEND_FROM_EMAIL`. |
| `RESEND_FROM_EMAIL` | A sender verified in Resend, e.g. `FlexiData <support@your-domain.com>`. Required with `RESEND_API_KEY`. |
| `RESEND_REPLY_TO` | Optional address that receives replies to reset emails. |
| `NOTIFY_WEBHOOK_URL` | Alternative email relay accepting `{ to, subject, text, html }` JSON. Used when Resend is not fully configured. In production with neither transport, forgot password returns an honest 502 rather than pretending an email was sent. |
| `DATA_API_PROVIDER` | Data gateway adapter to use: `mock` for local dev, or your production provider slug |
| `DATA_API_BASE_URL` | Base URL for your Ghanaian data-API gateway/provider |
| `DATA_API_PURCHASE_PATH` | Relative path used to submit MTN / Telecel data orders |
| `DATA_API_BALANCE_PATH` | Optional path used to sync provider float balances |
| `DATA_API_AUTH_TYPE` | Auth mode for the provider: `none`, `basic`, `bearer`, or `headers` |
| `DATA_API_KEY` / `DATA_API_SECRET` / `DATA_API_TOKEN` | Provider credentials, depending on the auth mode |
| `DATA_API_ACCOUNT_ID` | Optional merchant/account identifier required by some aggregators |
| `DATA_API_CALLBACK_URL` | Public callback URL the provider can call after fulfilling a bundle |
| `DATA_API_WEBHOOK_SECRET` | Shared secret used to verify callback requests |
| `DATA_API_TIMEOUT_MS` | Backend timeout for provider requests |
| `DATA_API_SYNC_FLOAT_ON_PURCHASE` | Whether to sync cached float balances before purchase attempts |
| `DATA_API_SCHEMA_FALLBACKS` | Tolerate a database that has not been migrated for the data gateway yet (default `true`) |
| `DATA_API_SCHEMA_PROBE_MS` | How often the detected gateway schema is re-read from the catalog (default `60000`) |
| `DATA_MOCK_RESULT` | Test-only override for the `mock` data gateway result: `successful` / `pending` / `failed`. Unset keeps the demo behaviour (mostly successful) |
| `DRIZZLE_ALLOW_LOCAL_DB` | Set to `1` to let `drizzle-kit` target a `localhost` database on CI/Vercel (it refuses by default) |

## Migrations

`flexiData/drizzle.config.ts` resolves the database to migrate in three steps:

1. It loads `.env.local` **and** `.env` itself, with `.env.local` winning — the
   same precedence Next.js uses. It has to: drizzle-kit only auto-loads `.env`,
   so a `DATABASE_URL` that lives in `.env.local` (which is what this README
   tells you to create) is invisible to it. That is how an earlier `drizzle-kit
   push` aimed at production silently migrated a laptop's `localhost` database
   instead.
2. It refuses to guess. With no `DATABASE_URL` set it aborts with an
   explanation rather than falling back to a hard-coded local URL.
3. On CI or Vercel it refuses a `localhost` / `127.0.0.1` database outright,
   unless you set `DRIZZLE_ALLOW_LOCAL_DB=1`.

`drizzle-kit generate` still works without a database — it only diffs the
schema, so it is the one command exempt from step 2.

To migrate production, run it from your machine against the production URL:

```bash
cd flexiData
DATABASE_URL='postgresql://…?sslmode=require' npx drizzle-kit push
```

Then check `/api/health`: `gatewaySchema` and `signupSchema` should both read
`"current"`.

## Deploying to Vercel (with Neon)

1. Merge this branch into `main` (or connect the branch you deploy from).
2. In Vercel, **Add New → Project** and import the repo. Set the **Root
   Directory** to `flexiData`.
3. Add the required **Environment Variables** (all three scopes: Production,
   Preview, Development):
   - `DATABASE_URL` = your Neon **pooled** connection string ending in
     `?sslmode=require` (or `?sslmode=verify-full`).
   - `AUTH_SECRET` = a long random string
     (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`).
   - `APP_BASE_URL` = your public `https://<domain>` (used for links in emails
     and Paystack callbacks; reset links fall back to the request origin, so
     the flow keeps working when you forget this — a localhost value shipped to
     production was the historical cause of unreachable reset links).
   - For **payments** (wallet deposits + data-bundle checkout):
     `PAYSTACK_SECRET_KEY` = your `sk_test_…` key for testing, or `sk_live_…`
     **plus** `PAYSTACK_LIVE_MODE=true` for real money. Wallet funding uses
     Paystack automatically once the key is set — make sure `PAYMENTS_PROVIDER`
     is **not** `mock` (delete the variable, or set it to `paystack`); in
     production a leftover `mock` does not simulate anything any more — wallet
     funding is refused outright until the variable is removed. Set the
     Paystack webhook URL to `https://<domain>/api/payments/webhook` in the
     dashboard. See [Wallet deposits](#wallet-deposits-paystack).
   - For **password reset emails** (recommended): add `RESEND_API_KEY` and
     `RESEND_FROM_EMAIL` to Vercel. The sender must be verified in Resend, for
     example `FlexiData <support@your-domain.com>`; the app sends directly to
     Resend's API, so no custom email webhook is required. Optionally set
     `RESEND_REPLY_TO`.
   - Or use `NOTIFY_WEBHOOK_URL` for an existing email relay that accepts
     `{ to, subject, text, html }` JSON. It is used only when Resend is not
     fully configured.
   - For **live data delivery**: `DATA_API_PROVIDER`, `DATA_API_BASE_URL`,
     `DATA_API_PURCHASE_PATH`, the matching auth credentials for your Ghanaian
     data gateway, and `DATA_API_CALLBACK_URL` = your public
     `/api/purchase/callback` endpoint.
4. Deploy, then open the site once so it can seed the bundle catalog.

### If you see "We hit a snag"

Open the "What went wrong?" details on the error page, or visit `/api/health`.
Common causes and fixes:

| Message | Fix |
| --- | --- |
| `DATABASE_URL is missing` | The env var isn't set — add it in Vercel Settings → Environment Variables, then Redeploy |
| `password authentication failed` | Wrong password in the URL — re-copy from Neon |
| `connect ECONNREFUSED` / `timeout` | Neon is blocking Vercel's IPs — in Neon, make sure your project allows connections (disable IP allowlist, or add Vercel's ranges) |
| `relation "wallets" does not exist` | Run `npx drizzle-kit push` against Neon |
| `column "fulfillment_status" does not exist` / `relation "provider_float_balances" does not exist` | The data gateway columns have not been pushed. The app keeps running with [compatibility fallbacks](#schema-compatibility-fallbacks) (provider tracking is skipped); run `npx drizzle-kit push` to switch it on |
| `too many connections` | Use the **pooled** Neon URL (contains `-pooler`) |
| Sign-up says "Something went wrong. Please try again. (ref AB12CD)" | The `ref` is logged next to the real error — search your Vercel logs for `[flexidata] register failed ref=AB12CD`. The usual cause is drift on the sign-up tables **or** the shared catalog seed (`price_alerts` / `bundle_plans`); see [Sign-up fixes](#sign-up-fixes) |
| Sign-up says "Something went wrong. Please try again." and only for a referral code | The database still carries a UNIQUE constraint on `users.referred_by`. Current code repairs it on boot, whatever it is named — see [Sign-up fixes](#sign-up-fixes) |
| Sign-up says "Account setup is temporarily unavailable" | `/api/health` reports `signupSchema.blocked: true` with the exact missing columns. Run `npx drizzle-kit push` against that database |
| Sign-up rejects a `+233…` number with "Enter a valid Ghanaian phone number" | Pull the latest code — `normalizePhone` now accepts `+233`, `233` and `00233` |
| `/api/health` reports `signupSchema.status: "drifted"` | Sign-up still works (the missing columns are skipped), but the database is behind. Run `npx drizzle-kit push` to store them |

## Sign-up fixes

Four defects made account creation fail:

1. **`users.referred_by` was UNIQUE.** Only one visitor could ever be referred by
   a given user, so the *second* person to sign up with any referral code hit
   `duplicate key value violates unique constraint "users_referred_by_idx"` and
   saw "Something went wrong. Please try again." The index is now a plain
   `index`; "pay a referrer only once" is (and always was) enforced by
   `users.referral_rewarded_at` in `src/lib/referrals.ts`.

   **Existing databases repair themselves.** On the first request after boot the
   app looks the uniqueness up in the catalog **by column, not by name**, and
   swaps it for a plain index in a single transaction — the same change
   `npx drizzle-kit push` makes. So no manual migration is needed; just deploy.
   You can watch for this line in the server log:

   ```
   [flexidata] replaced the UNIQUE constraint on users.referred_by (users_referred_by_idx) with a plain index — sign-ups using a referral code work again
   ```

   Matching on the column rather than the name matters: the same uniqueness can
   reach production as a unique **constraint** (`users_referred_by_key`) or under
   a differently-named index, and looking only for `users_referred_by_idx` found
   neither. A constraint is dropped with `alter table … drop constraint`, because
   `drop index` fails while a constraint still owns the index.

   `npx drizzle-kit push` still works if you prefer to do it by hand, and the
   repair is idempotent — it is a no-op once the index is correct.

2. **International numbers were rejected.** `normalizePhone` ran the input
   through `phoneDigits`, which caps at 10 digits, so a 12-digit `+233…` number
   was truncated into something that then failed validation. `+233`, `233` and
   `00233` are now all normalized to the local `0XXXXXXXXX` form. `groupPhone`
   no longer truncates the digits as they are typed, so the field can hold an
   international number at all.

3. **A half-finished sign-up blocked the email forever.** The user, wallet and
   agent-profile inserts were three separate statements; if the wallet insert
   failed the user row stayed behind, and every retry answered "An account with
   this email already exists". The three inserts now run in one transaction, and
   a concurrent duplicate is reported with the same friendly message the
   pre-checks give instead of a bare 500.

4. **A migration that never reached production 500'd *every* sign-up.** This is
   the one that kept the error alive after defect 1 was fixed. Drizzle's
   `insert` names **every** column of the table definition, so on a database
   missing even one optional column the statement died with
   `column "referral_rewarded_at" of relation "users" does not exist` — and the
   route turned that into "Something went wrong. Please try again."

   Sign-up now has the same compatibility treatment the rest of the app has. It
   reads the live column list for `users`, `wallets` and `agent_profiles`, and
   builds the inserts naming only columns the database actually has:

   - **Optional columns** (nullable, or `NOT NULL` with a database default) are
     skipped, and the database default fills them in. Sign-up keeps working.
   - **Required columns** (`users.email`, `wallets.number`, …) cannot be skipped,
     so a database missing one is *reported* rather than worked around: the API
     answers "Account setup is temporarily unavailable" and
     `/api/health` shows `signupSchema.blocked: true` with the exact names.
   - Either way the drift is logged on boot, and `/api/health` reports
     `signupSchema.status` as `current`, `drifted` or `unknown`.

5. **The shared catalog seed could 500 *every* sign-up alone.** `ensureSeeded()`
   runs on the sign-up / login / password-reset path and writes a few shared
   catalog tables (`bundle_plans`, `provider_float_balances`, `price_alerts`).
   The compatibility work in defect 4 guarded the tables account creation
   writes to, but not the seed's own tables, so a deployment whose database was
   one migration behind `price_alerts` let the seed throw. That rejected the
   `ensureSeeded()` promise and surfaced account creation as
   "Something went wrong. Please try again. (ref …)" — and because the failure
   happened *before* the user row was written, **every retry reproduced it**.

   The seed is now best-effort: a missing table or column is logged and skipped
   (exactly like the data-gateway fallbacks), so a lagging schema can no longer
   take auth down.

```bash
cd flexiData
npm run verify:seed-resilience   # no database needed (in-memory simulator)
npm run verify:auth-flow         # no database needed; drives the real auth routes
npm run verify:signup            # needs DATABASE_URL + AUTH_SECRET; cleans up after itself
```

The check talks to a real database on purpose: the simulated Postgres behind
`verify:schema-compat` does not model unique constraints, which is exactly how
defect 1 shipped. It now also drops the optional sign-up columns, signs up, and
puts them back — the regression test for defect 4.

## Schema compatibility fallbacks

The data gateway widened the schema (a `provider_float_balances` ledger, a
`fulfillment_status` lifecycle, and `provider_*` columns on `transactions` and
`bundle_plans`). Deployed databases are usually a step behind that change, and a
plain `select`/`insert` against a stale schema would otherwise break every page
of the app.

At startup (and every `DATA_API_SCHEMA_PROBE_MS`) the app reads
`information_schema` / `pg_type` to see which of those objects actually exist,
then adapts:

- **Reads** use the columns the UI needs, so `/`, `/history` and `/data` render
  on either schema revision.
- **Ledger writes** are built with an explicit column list, because Drizzle
  otherwise names every column of the table definition. Missing gateway columns
  are skipped instead of failing the purchase — the order is still recorded.
- **Provider float tracking** (sync, reservations, `floatBalance` from a
  callback) is skipped while `provider_float_balances` is absent.
- **Provider callbacks** match on `ref` only and never write the fulfillment
  columns; a `reversed` status is stored as `failed` if the local `tx_status`
  enum predates the new label. The wallet is still credited and the subtitle
  still tells the user the truth.
- **`/api/health`** reports `gatewaySchema: "current" | "legacy" | "unknown"`
  plus the exact missing objects. `signupSchema` reports the same for the tables
  account creation writes to (`users`, `wallets`, `agent_profiles`) — those are
  covered by [Sign-up fixes](#sign-up-fixes) rather than by the gateway
  fallbacks, because a missing column there is what broke sign-up.

Everything heals on its own: run `npx drizzle-kit push`, and the next probe
re-enables full tracking without a redeploy. Set
`DATA_API_SCHEMA_FALLBACKS=false` if you would rather a stale schema fail loudly
than degrade.

### Verifying it

```bash
cd flexiData
npx tsx scripts/schema-compat-harness.ts      # SCENARIO=legacy|current|probedown|strict|heal
MIGRATED=false npx tsx scripts/schema-baseline-probe.ts
```

The scripts run the real route handlers against a simulated Postgres that either
has or has not been migrated, so the fallbacks (and the untouched happy path) are
both covered.

> ⚠️ Never commit `drizzle.config.json` with a real password, and never put a
> real `DATABASE_URL` in a file tracked by git. Use Vercel env vars and a local
> `.env.local` (git-ignored) instead.
