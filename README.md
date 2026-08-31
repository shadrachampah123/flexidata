# FlexiData

A sleek, mobile-first **data bundle & airtime vending app** for Ghana. Buy discounted MTN &
Telecel bundles, top up airtime, convert airtime to cash, fund your wallet, schedule auto
top-ups and earn rewards — all in one place.

> Simulated by default in local development. Set the data gateway environment variables below to connect a real Ghanaian data-API provider for MTN / Telecel fulfillment.

## Stack

- **Next.js 16** (App Router, Turbopack)
- **React 19**
- **Tailwind CSS 4**
- **Drizzle ORM** + **PostgreSQL**
- Self-hosted variable fonts (Manrope + Space Grotesk)

## Getting started

```bash
cd flexiData
npm install

# 1. Configure the database
cp .env.example .env.local   # then edit DATABASE_URL to point at your Postgres

# 2. Create the schema
npx drizzle-kit push

# 3. Run the app (seeds demo data on first request)
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

## Project layout

```
flexiData/
├─ drizzle.config.json   # Drizzle ORM config
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

## Deploying to Vercel (with Neon)

1. Merge this branch into `main` (or connect the branch you deploy from).
2. In Vercel, **Add New → Project** and import the repo. Set the **Root
   Directory** to `flexiData`.
3. Add the required **Environment Variables** (all three scopes: Production,
   Preview, Development):
   - `DATABASE_URL` = your Neon **pooled** connection string ending in
     `?sslmode=require` (or `?sslmode=verify-full`).
   - `DATA_API_PROVIDER`, `DATA_API_BASE_URL`, `DATA_API_PURCHASE_PATH`, and the
     matching auth credentials for your Ghanaian data gateway.
   - `DATA_API_CALLBACK_URL` = your public `/api/purchase/callback` endpoint.
4. Deploy, then open the site once so it can seed demo data.

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
  plus the exact missing objects.

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
