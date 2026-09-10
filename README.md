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
| `npm run verify:withdrawal` | Prove a database can accept a withdrawal (`--write-probe` adds INSERTs that are rolled back; needs `DATABASE_URL`) |
| `npm run verify:admin-withdrawal-action` | Drive the real admin approve/reject withdrawal action end to end (needs `DATABASE_URL` + a running dev app at `BASE_URL`) |
| `npm run verify:wallet-freshness` | Prove the Wallet page converges on the database after out-of-band money movement (needs `DATABASE_URL` + a running dev app at `BASE_URL`) |
| `npm run verify:withdrawal-refund` | Prove withdraw → reject restores the wallet exactly once, idempotently, atomically, and the user sees it (needs `DATABASE_URL` + a running dev app at `BASE_URL`) |
| `npm run verify:withdrawals-disabled` | Prove the withdrawal kill switch is fail-closed and blocks creation/approval/retry/payout before any money or Paystack effect (in-memory; `DATABASE_URL` + `BASE_URL` add a live drive) |
| `npm run diagnose:withdrawal-refund` | **Read-only** forensics for a failed refund against a real database — identifies the affected withdrawal and which case occurred (needs `DATABASE_URL`) |
| `npm run cleanup:demo-deposits` | Review-first reversal of demo/mock wallet deposit credits (`--apply` to run) |

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

Then check `/api/health`: `gatewaySchema`, `signupSchema` and
`withdrawalSchema` should all read `"current"`.

> **A production database carrying drift `schema.ts` does not own — do not
> push.** `drizzle-kit push` syncs the whole schema **in both directions**: any
> table that exists in the live database but not in `src/db/schema.ts` (a
> leftover from an old hotfix, another tool's bookkeeping table, …) is reported
> as a **table removal** and push will only continue if you accept dropping it.
> That is exactly how the PR #38 migration ended up aborted on production. When
> a change needs only a couple of named objects (the admin-audit widening is
> the canonical example), apply an **explicit, guarded SQL migration** instead
> — see
> [Applying the PR #38 audit migration to production](#applying-the-pr-38-audit-migration-to-production-non-destructive).

> **A migration file can be missing while its snapshot is committed.**
> `drizzle/meta/_journal.json` lists a tag for every migration, and
> `drizzle-kit` refuses to run at all when the matching `.sql` is absent
> (`No file drizzle/0005_lively_hiroim.sql found in drizzle folder`). That is
> exactly what happened to the withdrawal schema — see
> [Withdrawal fixes](#withdrawal-fixes). If `drizzle-kit migrate` reports a
> missing file, the journal entry is real and the SQL has to be restored, not
> deleted from the journal: the snapshot next to it still describes the objects
> the migration was supposed to create.

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
| Withdraw says "Unable to process withdrawal. Please try again. (ref …)" | The database is missing `withdrawal_requests`. `/api/health` reports it under `withdrawalSchema`; the `ref` is logged next to the real Postgres error — search your Vercel logs for `[flexidata] withdraw failed ref=…`. Run `npx drizzle-kit push`, or confirm with `npm run verify:withdrawal`. See [Withdrawal fixes](#withdrawal-fixes) |
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

## Withdrawal fixes

Withdrawing GH₵ 5.00 from a real wallet answered **500 Internal Server Error**.
The cause was not in the route: the route was correct, and its transaction
rolled back cleanly, leaving the balance and the ledger untouched.

**The withdrawal migration was never in the repository.**
`drizzle/meta/_journal.json` and `drizzle/meta/0005_snapshot.json` both describe
a migration tagged `0005_lively_hiroim` — the one that creates
`withdrawal_requests`, the `withdrawal_status` enum and the `withdrawal` value of
`tx_type` — but `drizzle/0005_lively_hiroim.sql` itself was never committed. Two
consequences:

1. `drizzle-kit migrate` aborted outright with
   `No file drizzle/0005_lively_hiroim.sql found in drizzle folder`, creating
   nothing at all.
2. A database provisioned any other way simply never got the table, so
   `POST /api/wallet/withdraw` died on its first insert with
   `relation "withdrawal_requests" does not exist` (SQLSTATE `42P01`). The route
   caught that and answered a bare 500, and `/api/health` still read `"current"`
   for every schema it knew how to check — the withdrawal objects were not on
   its list.

Four changes fix it:

1. **`drizzle/0005_lively_hiroim.sql` restored** — the exact 0004 → 0005 delta
   described by the committed snapshot, in the order `drizzle-kit` emits it.
   Purely additive: no `DROP`, no column removal, no row rewrite, so it is safe
   against a database holding real wallets. Applying the whole `drizzle/` folder
   with drizzle's own migrator now produces a schema that matches
   `meta/0006_snapshot.json` object for object.
2. **Additive self-heal** — `repairWithdrawalSchema()` in `src/lib/seed.ts`,
   registered with the other boot repairs and awaited once per instance by the
   withdrawal route (`ensureWithdrawalSchema()`). Every statement is guarded
   (`create table if not exists`, `add column if not exists`, `add value if not
   exists`, catalog lookups for `CREATE TYPE` and `ADD CONSTRAINT`), so a
   deployment recovers on its first request even if nobody runs a migration by
   hand. It never drops or rewrites anything.
3. **Real diagnostics** — the route now logs
   `[flexidata] withdraw failed ref=AB12CD user=… wallet=… code=42P01 — relation
   "withdrawal_requests" does not exist` and answers
   `Unable to process withdrawal. Please try again. (ref AB12CD)`. The client
   response carries no SQL, no column names and no driver internals; the ref is
   what you search the Vercel logs for.
4. **`/api/health` reports it** — a `withdrawalSchema` block (`status`,
   `blocked`, `table`, `missing`, `hint`) plus a `withdrawalWarning` when the
   schema is absent, so this class of drift is visible without reading logs.

Two more defects on the same path were fixed while verifying:

- **`POST /api/admin/withdrawals/[id]/action` used the wrong admin gate.** It
  called `requireAdmin()` — the *page* gate, which throws `notFound()` — inside a
  `try` whose `catch` converted the throw into a 500. Every denied caller got
  "Internal Server Error" instead of the identical 404 every other `/api/admin/**`
  route returns, which both logged a false alarm and defeated the "no oracle"
  rule in `src/lib/admin/auth.ts`. It now uses `requireAdminApi()`.
- The same handler echoed `err.message` (the driver's own text) to the client on
  failure. Operational refusals now answer 404 / 409, and anything unexpected is
  logged with a ref behind a generic message.

### Verifying a withdrawal path without moving money

```bash
cd flexiData
DATABASE_URL='postgresql://…' npm run verify:withdrawal -- --write-probe
```

Phase A is a read-only catalog probe. `--write-probe` additionally runs the exact
INSERTs the route performs against throwaway rows inside a transaction that is
**rolled back**, then asserts nothing was left behind — so it proves the columns,
both enum values and both foreign keys accept the write without creating a
payout, a request, or a ledger row. The genuine live Paystack deposit
(`DP-MTMZN2P8SSBR`) is re-read before and after and the script fails loudly if it
changed. No money moves: the withdrawal feature records a request and holds the
balance, and payout is still manual admin approval.

### Admin reject/approve of withdrawals ("Failed to process action")

An admin clicking **Reject** (or **Approve**) on a pending withdrawal in
`/admin/withdrawals` got a bare failure while everything else — the list, the
customer's own withdrawal request — kept working. The exact server error,
captured from the action endpoint's log line:

```text
SQLSTATE 23514 (check_violation)
new row for relation "admin_audit_logs" violates check constraint
"admin_audit_logs_action_check"   (action = 'reject_withdrawal')
```

The route itself was correct: it locks the withdrawal (`SELECT … FOR UPDATE`),
verifies it is still `pending`, refunds the wallet, flips the ledger row and
inserts the admin audit row — all in ONE transaction. That final audit INSERT
is the only statement the database refused. `admin_audit_logs_action_check`
shipped narrow (`0002`/`0003`: suspend / activate / delivery_resolved /
refund_review) and only `drizzle/0006` widens it with
`approve_withdrawal` / `reject_withdrawal`. A production database that never
ran 0006 therefore rejects the audit row, which rolls back the entire action —
correctly, since a partial refund must never commit — and the API answers 500,
which the admin UI showed as "Failed to process action". Three things kept the
cause invisible: `drizzle-kit push` does not reliably re-diff an existing CHECK
definition, the runtime self-heal covered only `withdrawal_requests`, and
`/api/health` had no probe for the audit constraint.

The fix (both paths covered, nothing dropped, no row rewritten):

1. **`drizzle/0007_widen_admin_audit_log_actions.sql`** — drops and immediately
   re-adds the CHECK with the exact widened definition `src/db/schema.ts`
   declares, and rebuilds the replay-safe partial unique index
   (`admin_audit_logs_order_action_idx`) with the four-action predicate so
   "one audit row per (target_ref, action)" finally covers withdrawals.
   Additive and idempotent: on a database that already ran 0006 it re-creates
   identical objects; existing rows were written under the narrower list, so
   they satisfy the wider one by construction. On production it is applied
   with the targeted runner — `npm run migrate:admin-audit-actions` — not
   `drizzle-kit push`; see
   [Applying the PR #38 audit migration to production](#applying-the-pr-38-audit-migration-to-production-non-destructive).
2. **Runtime self-heal** — `ensureAdminAuditActions()` in `src/lib/seed.ts`
   probes the catalog (constraint + index definitions) and performs the same
   widening only when a withdrawal action is actually missing, so a deployment
   recovers on the first admin action even if nobody runs a migration by hand.
   Registered with the boot repairs and awaited by the action route, exactly
   like `ensureWithdrawalSchema()`.
3. **`/api/health` reports it** — an `adminAuditSchema` block
   (`status`/`blocked`/`missing`/`hint`) plus an `adminAuditWarning` while the
   constraint predates the withdrawal actions, so this drift can never hide
   behind `withdrawalSchema: "current"` again.

The action route was also hardened while there: the reject flow now locks the
user's wallet row before refunding (the same `FOR UPDATE` the request path
uses), refunds exactly the GROSS amount the request deducted (GH₵ 5.00, not
the GH₵ 4.90 net of the fee), stamps `updated_at`, refuses a missing or
over-length (240-char) rejection reason up front with a 400 instead of dying
inside the money transaction, and the admin UI surfaces the API's safe error
text ("Only pending requests can be modified", the log ref, …) instead of a
blanket "Failed to process action.".

Verifying the whole action path against a real database + app:

```bash
cd flexiData
DATABASE_URL='postgresql://…' npx tsx scripts/verify-admin-withdrawal-action.ts              # catalog probe
DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' npx tsx scripts/verify-admin-withdrawal-action.ts
```

Phase B drives the real API end to end: deposit → withdrawal request (gross
deduction) → reject (single gross refund, `rejected` status, one audit row,
ledger `failed`) → replayed reject refused with 409 and no second refund →
concurrent-reject safety → approve still works → rejecting an approved
withdrawal refused → non-admin gets the identical 404 → invalid/unknown ids
and reason validation answered with 400/404. It creates only `fd-awa-`-tagged
throwaway rows, deletes them again (audit rows first — they RESTRICT), and
re-checks the genuine Paystack deposit `DP-MTMZN2P8SSBR` before and after.

### A rejection restores the wallet exactly once (atomic + idempotent)

This is the load-bearing guarantee of the whole withdrawal feature. One admin
rejection must move money **exactly one time**: restore the exact amount the
request deducted, flip the refund ledger entry exactly once, and write exactly
one audit row — and a replay, double-click, timeout-after-commit or a second
admin must never move it a second time.

`POST /api/admin/withdrawals/[id]/action` (`reject`) does this inside a single
Postgres transaction in `src/app/api/admin/withdrawals/[id]/action/route.ts`:

```
BEGIN
  1.  SELECT … withdrawal_requests … WHERE id=$1 FOR UPDATE     -- row lock
  2.  require status = 'pending'                                 -- else 409/404, no money
  3.  the refund wallet is the WITHDRAWAL's wallet_id (server-side,
      derived from the request row) — never a client/admin-supplied id
  4.  SELECT … wallets … WHERE id=$1 FOR UPDATE                  -- wallet lock
  5.  UPDATE wallets SET balance = balance + <gross amount>      -- SQL arithmetic,
      WHERE id=$1 AND balance + amount < <overflow guard>          exact numeric, no float
  6.  UPDATE transactions SET status='failed', provider_message=<reason>
      WHERE id=<the withdrawal's ledger row> AND status='pending' -- flip, once
  7.  INSERT admin_audit_logs (target_ref, action='reject_withdrawal', reason)
  COMMIT   ← all seven, or none
```

The **idempotency** is structural, not advisory. Step 2 fails the whole
transaction on any request that is no longer `pending` (a second reject sees
`rejected`), and step 7's `INSERT` is guarded by the partial unique index
`admin_audit_logs_order_action_idx` — so even two admins racing, a double-click,
a client retry, or a webhook overlap cannot commit two refunds: the loser of the
race hits the row lock, re-reads the now-`rejected` status, and answers **409**
`withdrawal_already_processed` with zero money moved. There is no
"already handled" branch that re-runs the refund, and the wallet is never
credited by a client-supplied number — it is the wallet the request row points
at. `npm run verify:withdrawal-refund` proves every one of these branches,
including five concurrent rejects producing exactly one 200 and four 409s with a
single refund.

#### When the audit schema is behind: `503 schema_maintenance_required`

On a database that never ran `drizzle/0007` (the audit CHECK/index still
predates the withdrawal actions), the action route now **refuses up front with
`503 schema_maintenance_required`** instead of failing deep in the money
transaction. It still returns the correct answer — the withdrawal stays
`pending`, nothing is refunded, nothing is committed — but it tells the operator
*exactly* what to run (the targeted migration below) and never leaves a half-applied
refund behind. `/api/health` surfaces this as `adminAuditSchema.status: "legacy"`,
so it is visible before anyone clicks. See [Admin reject/approve](#admin-rejectapprove-of-withdrawals-failed-to-process-action).

#### Applying the PR #38 audit migration to production (non-destructive)

`drizzle-kit push` syncs `src/db/schema.ts` against the live database in **both
directions**, so on a database that carries tables outside the repo schema it
requests **table removals** (a destructive `DROP TABLE` prompt) — the PR #38
push was aborted for exactly this reason, and no amount of "yes" makes that
safe on real money data. Do not truncate, delete, or repair anything by hand:
the only schema change `reject_withdrawal` needs is widening the audit
constraint + its replay-safety index, and `drizzle/0007` does precisely that.

Run the **targeted** migration instead — it applies the `drizzle/0007` objects
with an explicit, single-transaction, additive SQL file and a static safety
audit (it refuses to run if the SQL ever references `DROP TABLE`/`TRUNCATE`/
`DELETE`/`UPDATE` or touches any table other than `admin_audit_logs`):

```bash
cd flexiData
# 1. Read-only preview: catalog state + the exact plan, nothing executed.
DATABASE_URL='postgresql://…?sslmode=require' npm run migrate:admin-audit-actions -- --dry-run
# 2. Apply + verify in one transaction, then re-read the catalog and drive
#    the exact reject/approve audit INSERTs inside a ROLLED-BACK probe.
DATABASE_URL='postgresql://…?sslmode=require' npm run migrate:admin-audit-actions
```

The runner (`scripts/apply-pr38-admin-audit-migration.ts`) only ever widens
`admin_audit_logs_action_check` and rebuilds `admin_audit_logs_order_action_idx`
(plus an `IF NOT EXISTS` repair of `admin_audit_logs.target_ref` for pre-0003
baselines). It **drops no table, deletes/rewrites no row, and touches no
wallet, withdrawal, ledger or deposit** — it snapshots the genuine Paystack
deposit `DP-MTMZN2P8SSBR` (full row) before and after and fails loudly if it
changed, and it lists any production-only tables so you can see it left them
alone. It is idempotent: on a database that already ran 0006/0007 every step
is a `no-op` and it reports `already-current`.

Afterwards confirm `/api/health` shows `adminAuditSchema.status: "current"`,
then re-reject the stuck withdrawal through the normal admin flow — the route
now restores the wallet exactly once. No manual refund is ever needed or
correct. `npm run verify:withdrawal-refund` (with `BASE_URL` set) proves the
whole refund path against the migrated database.

#### Diagnosing a failed refund against production (read-only)

When a user reports "I rejected my withdrawal but the money never came back,"
run the forensics script against the real database. It opens
`SET TRANSACTION READ ONLY`, so it cannot modify a single byte, and it
snapshots the genuine live deposit `DP-MTMZN2P8SSBR` (full row) before and
after to prove it never touched it:

```bash
cd flexiData
DATABASE_URL='postgresql://…' npx tsx scripts/diagnose-withdrawal-refund.ts                # 10 most recent
DATABASE_URL='postgresql://…' npx tsx scripts/diagnose-withdrawal-refund.ts --ref WDL-XXXX
DATABASE_URL='postgresql://…' npx tsx scripts/diagnose-withdrawal-refund.ts --id 42
DATABASE_URL='postgresql://…' npx tsx scripts/diagnose-withdrawal-refund.ts --since 2026-09-07T12:00:00Z --json
```

For each matching withdrawal it prints the user, wallet, amount, fee, net,
status, admin + reason, created/updated timestamps, the wallet balance **now**
and the **ledger-derived** balance (with their delta), every ledger row
(type/status/direction/amount/note), every audit row, and a **verdict** mapping
the state onto the incident matrix:

- **CASE A** — request still `pending` → the rejection never committed (the
  wallet was never restored). Usually the `503 schema_maintenance_required`
  path above, or a rolled-back 500 on a legacy audit CHECK.
- **CASE B/C** — `rejected` but the ledger row was never flipped → the refund
  did not apply; reconcile the wallet before trusting the balance.
- **CASE G** — more than one `reject_withdrawal` audit row → a possible double
  refund; reconcile immediately.
- **CONSISTENT** — `rejected` + one `failed` ledger row + one audit row +
  balance == ledger-derived → the refund *is* in the database, so any stale
  number the user is seeing is the [Wallet freshness](#wallet-freshness-stale-balance-regression)
  layer, not accounting.

### Wallet freshness (stale-balance regression)

The server never caches wallet balances (every page/route reads the database,
`force-dynamic` + `no-store`), but the browser's client-side Router Cache can
serve a previously-rendered payload for a short window after a page was last
visited — and money can move OUT OF BAND (admin rejection refund, Paystack
webhook settlement, incoming transfer), which no server invalidation can reach
in someone else's browser. Three guards keep the user's display converging on
the database:

1. Nav links use the default viewport prefetch (instant `loading.tsx` shells)
   instead of full `prefetch` — a fully-prefetched payload is trusted for the
   *static* stale time (5 minutes), which is exactly what used to pin a stale
   balance. Navigations now always revalidate page data.
2. `/wallet` and `/` mount `<WalletFreshness />` (`src/components/wallet-freshness.tsx`):
   on mount, window focus, tab re-visibility and back/forward-cache restore it
   compares the server-rendered balance with the live `GET /api/wallet`
   (`no-store`, owner-scoped) balance and calls `router.refresh()` when they
   differ — the server stays the single source of truth.
3. `WalletTools` re-syncs its client-side balance state whenever the server
   prop changes (the insufficient-balance guards used to freeze at the mount
   value across refreshes).

Verifying the whole scenario against a real database + app (dev server with
`PAYMENTS_PROVIDER=mock`):

```bash
cd flexiData
DATABASE_URL='postgresql://…' npx tsx scripts/verify-wallet-freshness.ts              # catalog probe
DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' npx tsx scripts/verify-wallet-freshness.ts
```

Phase B replays the reported incident: deposit GH₵5 → Wallet page renders
GH₵5.00 → withdrawal request → database + page GH₵0.00 → admin rejects →
database back to GH₵5.00 → **the user-facing Wallet page renders GH₵5.00** →
replayed reject refused (409, no duplicate refund, still `rejected`, ledger
`failed`, one audit row) → admin sees the same GH₵5.00 → deposits still work →
transfers move money and the page reflects them. It creates only
`fd-wf-`-tagged throwaway rows, deletes them again, and re-checks the genuine
Paystack deposit `DP-MTMZN2P8SSBR` before and after.

The dedicated end-to-end refund test is `npm run verify:withdrawal-refund`
(`scripts/verify-withdrawal-refund.ts`). It is the single script that covers the
whole reported incident in one run — **withdraw → reject → wallet restored
exactly once → user's `GET /api/wallet` → the user's Wallet page and home
WalletCard** — plus the invariants a refund must hold: the balance is the exact
gross amount the request deducted, the refund ledger entry is flipped to
`failed` exactly once, there is exactly one audit row, `GET /api/wallet` is
`no-store` and reads the current database balance, the home page's WalletCard
reconciles to the same figure, a replayed reject is refused with 409 and a
second identical request cannot refund again, and five concurrent rejects
produce exactly one refund. It also asserts the [Wallet freshness](#wallet-freshness-stale-balance-regression)
mounts are present on `/wallet` and `/`, and proves the
`503 schema_maintenance_required` contract on a drifted (legacy audit) database
instead of moving money into a broken state. Like its siblings it uses only
`fd-wr-`-tagged throwaway rows, deletes them again (audit rows first), and
re-checks `DP-MTMZN2P8SSBR` before and after.

> **Note for a real deployment:** this sandbox has no access to the production
> database, so the *specific* refund that was lost is identified and its
> restoration is confirmed by running
> [`diagnose:withdrawal-refund`](#diagnosing-a-failed-refund-against-production-read-only)
> against production with the operator's `DATABASE_URL`. The code fix, the
> exactly-once guarantee, and the full regression matrix above are what make the
> next rejection restore the wallet reliably on the first click.

### Temporarily disabling withdrawals (kill switch)

While Paystack Transfers / third-party payouts are not approved for the
FlexiData Paystack account, the ENTIRE withdrawal/payout feature is inactive
behind one server-side, fail-closed flag — `WITHDRAWALS_ENABLED` (see
[`src/lib/withdrawal-flag.ts`](flexiData/src/lib/withdrawal-flag.ts) and
`WITHDRAWALS_ENABLED=false` in `flexiData/.env.example`). Only an explicit
`true` enables withdrawals; missing, empty, `false`, or any other value
(including `1`/`yes`/`on`) disables them.

While disabled, the server refuses — before any wallet, ledger, or Paystack
effect — new withdrawal requests (`503 withdrawals_disabled`), admin
**approve** and **retry**, and every payout-execution path (no transfer
recipient is created and no transfer is initiated, on any provider). The
payout implementation itself is NOT removed: historical records stay visible,
`reject`/`refund` reconciliation, the provider callback, and payout
reconciliation keep working, and deposits, transfers, and data purchases are
unaffected. The wallet Withdraw tab and `/admin/withdrawals` both show an
explicit "temporarily unavailable" notice, and `/api/health` reports the
switch under `withdrawals.enabled`.

Reactivation — only after FlexiData is registered and Paystack
Transfers/third-party payouts are approved — is a pure configuration change:
set `WITHDRAWALS_ENABLED=true`. Verify with:

```bash
cd flexiData
npm run verify:withdrawals-disabled
DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' npm run verify:withdrawals-disabled  # + live drive
```

> The live-drive suites that exercise withdrawals end to end
> (`verify:phase-b`, `verify:withdrawal-refund`,
> `verify:admin-withdrawal-action`, `verify:withdrawal-lifecycle`,
> `verify:withdrawal-security`, `verify:wallet-freshness`) need a dev server
> started with `WITHDRAWALS_ENABLED=true`.

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
