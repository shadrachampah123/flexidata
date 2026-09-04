# Phase 0 — Admin Access Control Gate: Acceptance Report

**Status:** complete and verified. **Phase 1 not started.**
Branch `arena/01a06e5e-flexidata`, base commit `182895e`.

---

## 1. What was built

Phase 0 delivers **only** the access-control gate. There is no dashboard, no data,
no financial control surface. The one page under `/admin` exists purely to prove the
gate works end to end.

| File | Purpose |
|---|---|
| `src/lib/admin/config.ts` | Reads and normalises `ADMIN_EMAILS`; no secrets, no DB. |
| `src/lib/admin/auth.ts` | The gate: `requireAdmin()` / `getAdminContext()`. Fail-closed. |
| `src/app/admin/layout.tsx` | Calls the gate; `notFound()` on denial. Inherited by all future `/admin/*`. |
| `src/app/admin/page.tsx` | Placeholder proving authorisation, nothing more. |
| `src/app/api/admin/me/route.ts` | Reference API route; authorises itself. |
| `scripts/grant-admin.ts` | Operator CLI: `--status` / grant / `--revoke`. |
| `scripts/verify-admin-access.ts` | 40-check security harness. |

Modified: `src/components/app-chrome.tsx` (added `/admin` to the existing bare-shell
list — the mechanism that was already there) and `package.json` (two `scripts` entries).
**Nothing else.**

### Authorisation model

Access requires **all** of the following, re-evaluated on **every request**:

1. A valid `fd_auth` cookie with a good HMAC signature and unexpired `exp`.
2. A live row in `sessions` for that `sid` (so logout / session revocation applies).
3. `users.is_admin = true` for that user, read fresh from the database.
4. The user's email present in the `ADMIN_EMAILS` environment allowlist.

Two independent signals (3 and 4) are required, so compromising the database alone
or the environment alone is not sufficient. No admin claim was added to the cookie,
so there is nothing to forge and nothing to go stale.

Denial is always `notFound()` / HTTP 404 — never 403 — so the admin surface is not
enumerable. The reason is logged server-side and never returned to the client.

### The `FLEXIDATA_TEST_USER_ID` seam

The impersonation seam is honoured by the admin gate **only** when all three hold:
`NODE_ENV !== "production"`, **and** `FLEXIDATA_TEST_ALLOW_ADMIN=1` is explicitly set,
**and** the impersonated user independently satisfies both admin signals. In production
the seam is ignored unconditionally. A seam-derived context is tagged `via: "test-seam"`.

---

## 2. Acceptance criteria

### (1) Tests

| Suite | Result |
|---|---|
| `verify:admin-access` (new) | **40/40** |
| `verify:auth-flow` | 37/37 |
| `verify:security-fixes` | 27/27 |
| `verify:seed-resilience` | 6/6 |
| `verify:schema-compat` | 4/5 — 2 failures **proven pre-existing** on `182895e` |

The `schema-compat` failures (`health: schema legacy`, `health: lists missing objects`,
scenario `probedown`) were reproduced identically on the base commit in a throwaway
worktree. They are unrelated to this work and were left alone.

### (2) Verification / security checks

`npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` clean, with both
`/admin` and `/api/admin/me` listed as `ƒ` (dynamic) — neither can ever be statically
prerendered and cached.

The 40 checks cover: anonymous access, normal users, both-signals-required, authorised
admins, mid-session revocation, session validity, the test seam, **degraded-database
fail-closed behaviour** (driver-level fault injection with real PostgreSQL error codes
42703 / 42P01 / 57P01), and a proof that the gate performs no writes.

### (3)–(6) Live demonstrations

Run against **real PostgreSQL** and a **production build** (`next start`), over real HTTP —
not a simulator. Two real accounts registered through the normal signup endpoint:
`nana@flexidata.test` (ordinary customer) and `ada@flexidata.test`.

**(3) Normal user cannot access `/admin`**

```
anonymous  GET /admin  -> 307  Location: /login?next=%2Fadmin
nana       GET /admin  -> 404  (site-default title, no admin chrome, no admin content)
```

**(4) Normal user cannot call `/api/admin/*`** — byte-identical responses for all three:

```
anonymous  GET /api/admin/me -> 404  {"ok":false,"error":"Not found"}
nana       GET /api/admin/me -> 404  {"ok":false,"error":"Not found"}
ada        GET /api/admin/me -> 404  {"ok":false,"error":"Not found"}
```

`ada` was in `ADMIN_EMAILS` but had `is_admin = false` — live proof one signal is not enough.

**(5) Authorised admin passes** — after `npm run admin:grant -- --email ada@flexidata.test`,
using the **same cookie as before the grant, with no re-login**:

```
ada  GET /api/admin/me -> 200
     {"ok":true,"admin":{"userId":2,"name":"Ada Admin","email":"ada@flexidata.test",
      "sessionId":2,"via":"session"},"phase":0,"capabilities":{"read":[],"write":[]}}
ada  GET /admin        -> 200  (renders the placeholder; nana still 404 throughout)
```

Note `capabilities` is empty — Phase 0 grants entry, not powers.

**(6) Revocation blocks access** — three independent revocation paths, same live session:

```
revoke users.is_admin      -> /admin 404, /api/admin/me 404   (next request, no logout)
remove email from ADMIN_EMAILS (is_admin still true) -> 404   (either signal suffices)
ordinary customer logout   -> /api/admin/me 404               (session-backed)
```

**Bonus — seam lock under worst case.** Server restarted in production with
`FLEXIDATA_TEST_USER_ID=2 FLEXIDATA_TEST_ALLOW_ADMIN=1` while ada was a genuine admin:
anonymous `/api/admin/me` still returned **404**. The seam is dead in production.

**Bonus — cookie carries no admin claim.** Decoded live `fd_auth`: `{"uid":2,"sid":3,"exp":...}`.

### (7) No migration created

`flexiData/drizzle/` holds the same **2** pre-existing `.sql` files and 2 journal entries
as the base commit. `git diff 182895e -- flexiData/drizzle` and
`git diff 182895e -- src/lib/db/schema.ts` are both **empty**. The verification database
was provisioned with `drizzle-kit push` (throwaway, since deleted), which generates no files.

### (8) No wallet / payment / delivery code modified

Complete diff against base:

```
flexiData/package.json                  |  2 ++
flexiData/src/components/app-chrome.tsx | 11 +++++++++--
2 files changed, 11 insertions(+), 2 deletions(-)
```

Everything else is new files under `src/lib/admin/`, `src/app/admin/`,
`src/app/api/admin/`, `scripts/`, and `docs/`. Confirmed byte-identical to base:
wallet, purchase, deposits, Paystack, webhooks, delivery, `src/lib/auth.ts`,
`src/lib/db/schema.ts`, and `src/proxy.ts`.

`src/proxy.ts` needed **no change**: its existing rule already redirects any
non-auth page to `/login` when signed out, so `/admin` inherits that for free.
The proxy still skips `/api/*`, which is exactly why `/api/admin/me` authorises itself.

---

## 3. Known residual (disclosed, low severity)

`notFound()` thrown from a **layout** cannot render the nested not-found boundary, so
Next.js falls back to a bare error shell. Consequences:

* `/admin` denied → 6,905-byte `<html id="__next_error__">` shell
* `/definitely-not-a-page` → 23,298-byte styled root-layout 404

Both show the same generic *"404: This page could not be found."* and the same site-default
title. A full dump of the denied `/admin` body confirmed the **only** occurrence of the
string "admin" is the route path the caller already typed, inside the Next flight payload.
No admin content, title, identity, or capabilities leak.

The residual is that a determined attacker can distinguish "route exists but you are denied"
from "route does not exist" by response shape. That reveals only that `/admin` is a defined
route — already guessable — and is generic Next.js behaviour for any layout-guarded route.

**Fix available, not applied:** adding a root `src/app/not-found.tsx` equalises both
responses. It was not applied because it changes the customer-facing 404 page product-wide,
which is a UX decision outside Phase 0 scope. Happy to do it on request.

**A real leak was found and fixed during this work:** the admin layout originally exported
`metadata = { title: "FlexiData Admin" }`. Next resolves a segment's `metadata` export
independently of whether that segment's component threw, so the denied 404 was serving
`<title>FlexiData Admin</title>` to non-admins. The export was removed and the layout now
carries a comment warning against re-adding it.

---

## 4. Operating the gate

```bash
npm run admin:grant -- --email someone@example.com --status   # inspect both signals
npm run admin:grant -- --email someone@example.com            # grant
npm run admin:grant -- --email someone@example.com --revoke   # revoke
npm run verify:admin-access                                   # 40-check harness
```

Granting also requires the email in `ADMIN_EMAILS` (comma-separated) in the environment.
Revocation takes effect on the account's very next request.

---

## 5. Stop point

Phase 0 is done. **Phase 1 has not been started** and will not be without explicit
approval. Per the approved plan, Phase 1 remains read-only monitoring (overview,
users, wallets, deposits, purchases, delivery status) with no financial control actions.
