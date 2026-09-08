import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/api-auth";
import { db } from "@/db";
import { wallets, withdrawalRequests, transactions } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "crypto";
import { withdrawalSubtitle } from "@/lib/ghana-mobile";
import { validateWithdrawalRequestBody } from "@/lib/withdrawals";
import { ensureWithdrawalSchema } from "@/lib/seed";
import { recordWithdrawalEvent } from "@/lib/withdrawal-audit";

export const dynamic = "force-dynamic";

/** Financial responses are never cached anywhere (F7: the server is authoritative). */
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/** Thrown inside the transaction so the balance deduction rolls back with it. */
class InsufficientBalanceError extends Error {
  constructor() {
    super("Insufficient balance");
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Postgres "the object is not there" errors. These are schema drift, not a
 * wallet problem: the database was deployed behind the code. Named separately
 * so the server log says which one it was instead of a bare stack trace.
 */
const SCHEMA_DRIFT_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42704", // undefined_object
  "22P02", // invalid_text_representation (enum value missing from tx_type)
]);

/** Walk the Drizzle `cause` chain to the Postgres error (SQLSTATE + constraint). */
function pgDiagnostic(err: unknown): { code?: string; constraint?: string; message?: string } {
  let current = err as {
    code?: string;
    constraint?: string;
    message?: string;
    cause?: unknown;
  } | null;
  for (let depth = 0; current && depth < 6; depth++) {
    if (typeof current.code === "string" && current.code !== "") {
      return { code: current.code, constraint: current.constraint, message: current.message };
    }
    current = (current.cause ?? null) as typeof current;
  }
  return { message: (err as { message?: string } | null)?.message };
}

type IdempotencyRow = typeof withdrawalRequests.$inferSelect;

/** Replay lookup: the one withdrawal this wallet already made with this key, if any. */
async function findWithdrawalByIdempotency(
  walletId: number,
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  const rows = await db
    .select()
    .from(withdrawalRequests)
    .where(
      and(
        eq(withdrawalRequests.walletId, walletId),
        eq(withdrawalRequests.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Answer a duplicate request with the ORIGINAL result: same ref, same stored
 * fee/net, and the current authoritative balance (which may legitimately have
 * moved since — e.g. a later deposit — so it is re-read, never replayed).
 * No wallet/ledger mutation happens on this path.
 */
async function replayResponse(row: IdempotencyRow) {
  const current = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(eq(wallets.id, row.walletId))
    .limit(1);
  return NextResponse.json(
    {
      ok: true,
      ref: row.ref,
      newBalance: Number(current[0]?.balance ?? 0),
      fee: Number(row.fee),
      netAmount: Number(row.netAmount),
      duplicate: true,
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request) {
  // Correlation id for the server log / the user-facing message. Generated up
  // front so a failure at any point — auth, validation or the transaction —
  // can be found in the logs.
  const ref = randomBytes(3).toString("hex").toUpperCase();
  let actor = "unknown";

  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet, userId } = auth;
    actor = `user=${userId} wallet=${wallet.id}`;

    // F8: malformed JSON / empty body is a 400 with zero side effects — never
    // a 500 from a thrown parse error.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400, headers: NO_STORE });
    }

    // F1/F3/F8: strict validation BEFORE any financial mutation. Amount parsed
    // exactly (integer pesewas — `5.50` can never become 550), method
    // whitelisted, destination strictly normalized and matched to the method's
    // network, unknown/smuggled keys refused.
    const validated = validateWithdrawalRequestBody(body);
    if (!validated.ok) {
      return NextResponse.json({ ok: false, error: validated.error }, { status: 400, headers: NO_STORE });
    }
    const v = validated.value;

    // F2: keyed requests are idempotent across retries; legacy clients that
    // sent no key get a fresh UUID, so each of their requests stays unique.
    const idempotencyKey = v.idempotencyKey ?? randomUUID();

    // `withdrawal_requests` and the `withdrawal` ledger type arrive with a
    // migration a deployed database may not have received yet (see
    // `repairWithdrawalSchema`). Resolve that once per instance before opening
    // the money transaction: awaiting it here is what stops a cold instance
    // from answering 500 on the first withdrawal after a deploy.
    await ensureWithdrawalSchema();

    // F2 fast path: a retry of an already-recorded request reuses the original
    // result without touching the wallet or the ledger.
    const already = await findWithdrawalByIdempotency(wallet.id, idempotencyKey);
    if (already) return replayResponse(already);

    const amountCedis = v.amountCedis;
    const feeCedis = v.feeCedis;
    const netCedis = v.netCedis;
    const amountPesewas = v.amountPesewas;

    // The withdrawal ref is random (12 hex chars); on the ~impossible event of
    // a collision the attempt is retried with a fresh ref under the SAME
    // idempotency key, so a client retry stays safe either way.
    for (let attempt = 0; attempt < 3; attempt++) {
      const withdrawalRef = `WDL-${randomBytes(6).toString("hex").toUpperCase()}`;

      try {
        // Atomic transaction: wallet deduction + withdrawal row + ledger row
        // commit together or roll back together — never a half-written state.
        const result = await db.transaction(async (tx) => {
          // F2 in-transaction re-check: a concurrent duplicate may have
          // committed between the fast-path lookup above and this transaction's
          // snapshot. Returning the row commits an (empty) transaction and the
          // caller answers with the original result — no second deduction.
          const concurrent = await tx
            .select()
            .from(withdrawalRequests)
            .where(
              and(
                eq(withdrawalRequests.walletId, wallet.id),
                eq(withdrawalRequests.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1);
          if (concurrent[0]) return { replay: true as const, row: concurrent[0] };

          // Lock wallet for update (concurrent-spending protection).
          const [lockedWallet] = await tx
            .select()
            .from(wallets)
            .where(eq(wallets.id, wallet.id))
            .for("update");
          if (!lockedWallet) throw new Error("Wallet not found");

          // F7: the funds check runs against the AUTHORITATIVE locked row in
          // Postgres NUMERIC — never against a browser-provided balance (which
          // the validator refuses to even accept as a field).
          const funds = await tx.execute(
            sql`select "wallets"."balance" >= ${amountCedis} as ok from "wallets" where "wallets"."id" = ${wallet.id}`,
          );
          if (!(funds.rows?.[0] as { ok?: boolean } | undefined)?.ok) {
            throw new InsufficientBalanceError();
          }

          // Deduct balance (Postgres numeric arithmetic on the exact value)
          await tx
            .update(wallets)
            .set({ balance: sql`${wallets.balance} - ${amountCedis}` })
            .where(eq(wallets.id, wallet.id));

          // Create withdrawal request (amounts stored as exact cedi strings;
          // destination normalized to 0XXXXXXXXX + network by the validator).
          await tx.insert(withdrawalRequests).values({
            ref: withdrawalRef,
            userId: userId,
            walletId: wallet.id,
            amount: amountCedis,
            fee: feeCedis,
            netAmount: netCedis,
            destinationMethod: v.method,
            destinationDetails: { account: v.msisdn10, network: v.network, method: v.method },
            status: "pending",
            idempotencyKey,
            currency: "GHS",
          });

          // Record the creation event in the withdrawal audit trail.
          // The audit table might not exist on un-migrated databases, so we
          // catch and log the error rather than failing the whole withdrawal.
          try {
            // Look up the just-inserted withdrawal id
            const [insertedRow] = await tx
              .select({ id: withdrawalRequests.id })
              .from(withdrawalRequests)
              .where(eq(withdrawalRequests.ref, withdrawalRef))
              .limit(1);
            if (insertedRow) {
              await recordWithdrawalEvent(tx, {
                withdrawalId: insertedRow.id,
                withdrawalRef,
                event: "created",
                previousStatus: null,
                newStatus: "pending",
                actorType: "system",
                actorId: userId,
                metadata: { amount: amountCedis, fee: feeCedis, netAmount: netCedis, method: v.method, destination: v.msisdn10, network: v.network },
              });
            }
          } catch (auditError) {
            // Non-fatal: the audit table might not exist yet on an un-migrated database
            console.warn("[flexidata] withdrawal audit event recording failed (non-fatal):", (auditError as Error)?.message);
          }

          // Create transaction record. The subtitle is built server-side from
          // whitelist metadata (W4) — no client string is interpolated, so a
          // malicious `method` can neither overflow the varchar(200) nor land
          // in the ledger (and it would have been rejected above anyway).
          await tx.insert(transactions).values({
            ref: withdrawalRef,
            walletId: wallet.id,
            type: "withdrawal",
            status: "pending",
            direction: "out",
            title: "Withdrawal Request",
            subtitle: withdrawalSubtitle(v.method, v.msisdn10),
            amount: amountCedis,
          });

          // New balance computed exactly (integer pesewas), never as a float
          // subtraction of two decimal values.
          const currentPesewas = cedisStringToPesewas(String(lockedWallet.balance)) ?? 0;
          return {
            replay: false as const,
            ref: withdrawalRef,
            newBalancePesewas: currentPesewas - amountPesewas,
          };
        });

        if (result.replay) return replayResponse(result.row);
        return NextResponse.json(
          {
            ok: true,
            ref: result.ref,
            newBalance: result.newBalancePesewas / 100,
            fee: Number(feeCedis),
            netAmount: Number(netCedis),
            duplicate: false,
          },
          { headers: NO_STORE },
        );
      } catch (err: unknown) {
        // A declined withdrawal is a business answer, not a fault.
        if (err instanceof InsufficientBalanceError) {
          return NextResponse.json({ ok: false, error: "Insufficient balance" }, { status: 400, headers: NO_STORE });
        }
        const diag = pgDiagnostic(err);
        if (diag.code === "23505") {
          // F2 race lost: a concurrent duplicate committed first (the partial
          // unique index is the final arbiter). Answer with the winner's
          // original result — exactly one deduction stands.
          if (diag.constraint === "withdrawal_requests_wallet_idempotency_idx") {
            const winner = await findWithdrawalByIdempotency(wallet.id, idempotencyKey);
            if (winner) return replayResponse(winner);
          }
          // Random-ref collision: retry with a fresh ref (same key). The ref is
          // written to both tables, so a collision can surface from either
          // unique constraint (e.g. against an orphaned ledger row).
          if (
            (diag.constraint === "withdrawal_requests_ref_unique" ||
              diag.constraint === "transactions_ref_unique") &&
            attempt < 2
          ) {
            continue;
          }
        }
        throw err;
      }
    }
    // Unreachable (the loop above always returns or throws), but strict TS
    // wants a total function.
    throw new Error("withdrawal ref allocation failed");
  } catch (err: unknown) {
    // A declined withdrawal is a business answer, not a fault: answer with the
    // reason and nothing else. The transaction has already rolled back, so the
    // balance and the ledger are untouched.
    if (err instanceof InsufficientBalanceError) {
      return NextResponse.json({ ok: false, error: "Insufficient balance" }, { status: 400, headers: NO_STORE });
    }

    // Everything else is unexpected. Keep the client response safe (no SQL, no
    // column names, no driver internals) but log the real diagnostic with the
    // correlation id so the next production failure names itself.
    const diag = pgDiagnostic(err);
    const causeText = diag.message ? ` — ${diag.message}` : "";
    console.error(
      `[flexidata] withdraw failed ref=${ref} ${actor}` +
        (diag.code ? ` code=${diag.code}` : "") +
        (diag.constraint ? ` constraint=${diag.constraint}` : "") +
        causeText,
      err,
    );
    if (diag.code && SCHEMA_DRIFT_CODES.has(diag.code)) {
      console.error(
        `[flexidata] the withdrawal schema is missing from this database (${diag.code}) — ` +
          "run `npx drizzle-kit push` against it (see drizzle/0005_lively_hiroim.sql).",
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: `Unable to process withdrawal. Please try again. (ref ${ref})`,
        code: "withdrawal_failed",
        ref,
      },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * Exact `numeric` -> integer pesewas for the locked wallet balance (the same
 * conversion the money module performs; kept local so this route never imports
 * float-based helpers into the deduction path).
 */
function cedisStringToPesewas(value: string): number | null {
  const s = value.trim();
  if (!/^-?\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith("-");
  const unsigned = negative ? s.slice(1) : s;
  const [whole, frac = ""] = unsigned.split(".");
  const pesewas = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(pesewas)) return null;
  return negative ? -pesewas : pesewas;
}
