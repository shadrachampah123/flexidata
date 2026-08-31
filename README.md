# FlexiData

A sleek, mobile-first **data bundle & airtime vending app** for Ghana. Buy discounted MTN &
Telecel bundles, top up airtime, convert airtime to cash, fund your wallet, schedule auto
top-ups and earn rewards — all in one place.

> Simulated vending environment — no real money or network charges move here.

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

| Variable       | Description                            |
| -------------- | -------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string (required)|
