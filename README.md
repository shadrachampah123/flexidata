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
- **Wallet** — fund via MTN MoMo / Telecel Cash / card (simulated instantly in dev;
  [Paystack](https://paystack.com) in production, settled by verify + webhook) and
  transfer money to any other registered FlexiData user.
- **Shop** — discounted MTN (UP2U, SME non-expiry, Corporate, Social) & Telecel bundles,
  airtime at 2% off, and airtime-to-cash conversion.
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
| `AUTH_SECRET` | Long random string used to sign session cookies / reset tokens (required) |
| `APP_BASE_URL` | Public deployment URL for password-reset links & payment callbacks (e.g. `https://flexidata.app`) |
| `PAYMENTS_PROVIDER` | `mock` (instant simulated MoMo/card funding) or `paystack` for real Ghanaian mobile money/card checkout |
| `PAYSTACK_SECRET_KEY` | Paystack secret key — required when `PAYMENTS_PROVIDER=paystack` |
| `NOTIFY_WEBHOOK_URL` | Webhook that sends transactional email; when empty, reset links are logged/returned in dev |
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
   - `APP_BASE_URL` = your public `https://<domain>` (used for reset links and
     Paystack callbacks).
   - For **live payments**: `PAYMENTS_PROVIDER=paystack` + `PAYSTACK_SECRET_KEY`,
     and set the Paystack webhook URL to
     `https://<domain>/api/payments/webhook` in the Paystack dashboard.
   - For **password reset emails**: `NOTIFY_WEBHOOK_URL` pointing to an email
     relay that accepts `{ to, subject, text, html }` JSON.
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
