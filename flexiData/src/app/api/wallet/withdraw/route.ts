import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/api-auth";
import { db } from "@/db";
import { wallets, withdrawalRequests, transactions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { cedisToPesewas, pesewasToCedisString, normalizePhoneDigits, isValidPhone } from "@/lib/format";
import { ensureWithdrawalSchema } from "@/lib/seed";

export const dynamic = "force-dynamic";

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

const MIN_WITHDRAW_PESEWAS = 500; // GH₵ 5.00

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

    const body = await req.json();
    const { amount, method, dest } = body;

    // Monetary values are handled as EXACT cedi strings / integer pesewas —
    // never as binary floats. `cedisToPesewas` refuses anything that is not a
    // well-formed amount with at most two decimal places (float residue like
    // 0.30000000000000004, exponent notation, sub-pesewa fractions), so a
    // value the database cannot store exactly is a 400, not a rounded 500.
    const amountPesewas = cedisToPesewas(amount);
    if (amountPesewas === null || amountPesewas <= 0) {
      return NextResponse.json({ ok: false, error: "Invalid amount" }, { status: 400 });
    }

    if (amountPesewas < MIN_WITHDRAW_PESEWAS) {
      return NextResponse.json({ ok: false, error: `Minimum withdrawal is GH₵5` }, { status: 400 });
    }

    // A withdrawal must go to a real mobile-money number. Normalise once and
    // validate against the same rule the UI uses; the client-side guard is a
    // convenience — this is the authoritative rejection.
    const destination = normalizePhoneDigits(String(dest ?? ""));
    if (!isValidPhone(destination)) {
      return NextResponse.json(
        { ok: false, error: "Enter a valid destination mobile money number" },
        { status: 400 },
      );
    }

    // Fee calculation: exactly 2% in integer pesewas (one round), with the
    // net derived by subtraction — no floating-point arithmetic anywhere in
    // the money path.
    const feePesewas = Math.round((amountPesewas * 2) / 100);
    const netPesewas = amountPesewas - feePesewas;
    const amountCedis = pesewasToCedisString(amountPesewas);
    const feeCedis = pesewasToCedisString(feePesewas);
    const netCedis = pesewasToCedisString(netPesewas);

    // `withdrawal_requests` and the `withdrawal` ledger type arrive with a
    // migration a deployed database may not have received yet (see
    // `repairWithdrawalSchema`). Resolve that once per instance before opening
    // the money transaction: awaiting it here is what stops a cold instance
    // from answering 500 on the first withdrawal after a deploy.
    await ensureWithdrawalSchema();

    const withdrawalRef = `WDL-${randomBytes(6).toString("hex").toUpperCase()}`;

    // Atomic transaction
    const result = await db.transaction(async (tx) => {
      // Lock wallet for update
      const [lockedWallet] = await tx.select().from(wallets).where(eq(wallets.id, wallet.id)).for("update");
      if (!lockedWallet) throw new Error("Wallet not found");

      // Sufficient-funds check in Postgres NUMERIC, not JS float: the row's
      // balance (numeric(12,2)) is compared against the exact cedi string of
      // the requested amount, so the decision can never disagree with the
      // deduction below.
      const funds = await tx.execute(
        sql`select "wallets"."balance" >= ${amountCedis} as ok from "wallets" where "wallets"."id" = ${wallet.id}`,
      );
      if (!(funds.rows?.[0] as { ok?: boolean } | undefined)?.ok) {
        throw new InsufficientBalanceError();
      }

      // Deduct balance (Postgres numeric arithmetic on the exact value)
      await tx.update(wallets)
        .set({ balance: sql`${wallets.balance} - ${amountCedis}` })
        .where(eq(wallets.id, wallet.id));

      // Create withdrawal request (amounts stored as exact cedi strings)
      await tx.insert(withdrawalRequests).values({
        ref: withdrawalRef,
        userId: userId,
        walletId: wallet.id,
        amount: amountCedis,
        fee: feeCedis,
        netAmount: netCedis,
        destinationMethod: method,
        destinationDetails: { account: destination },
        status: "pending",
      });

      // Create transaction record
      await tx.insert(transactions).values({
        ref: withdrawalRef,
        walletId: wallet.id,
        type: "withdrawal",
        status: "pending",
        direction: "out",
        title: "Withdrawal Request",
        subtitle: `To ${method}`,
        amount: amountCedis,
      });

      // New balance computed exactly (integer pesewas), never as a float
      // subtraction of two decimal values.
      const currentPesewas = cedisToPesewas(String(lockedWallet.balance)) ?? 0;
      return {
        ok: true,
        ref: withdrawalRef,
        newBalance: Number(pesewasToCedisString(currentPesewas - amountPesewas)),
        fee: Number(feeCedis),
        netAmount: Number(netCedis),
      };
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    // A declined withdrawal is a business answer, not a fault: answer with the
    // reason and nothing else. The transaction has already rolled back, so the
    // balance and the ledger are untouched.
    if (err instanceof InsufficientBalanceError) {
      return NextResponse.json({ ok: false, error: "Insufficient balance" }, { status: 400 });
    }

    // Everything else is unexpected. Keep the client response safe (no SQL, no
    // column names, no driver internals) but log the real diagnostic with the
    // correlation id so the next production failure names itself.
    const pgCode = (err as { code?: string } | null)?.code;
    const pgMessage = (err as { message?: string } | null)?.message;
    const cause = (err as { cause?: { message?: string; code?: string } } | null)?.cause;
    console.error(
      `[flexidata] withdraw failed ref=${ref} ${actor}` +
        (pgCode ? ` code=${pgCode}` : "") +
        (cause?.code ? ` cause=${cause.code}` : "") +
        (cause?.message ? ` — ${cause.message}` : pgMessage ? ` — ${pgMessage}` : ""),
      err,
    );
    // Drizzle wraps the driver error, so the SQLSTATE is usually on `.cause`
    // rather than on the thrown error itself. Check both, or this hint would
    // never fire for the exact case it exists for.
    const driftCode = (pgCode && SCHEMA_DRIFT_CODES.has(pgCode) ? pgCode : null)
      ?? (cause?.code && SCHEMA_DRIFT_CODES.has(cause.code) ? cause.code : null);
    if (driftCode) {
      console.error(
        `[flexidata] the withdrawal schema is missing from this database (${driftCode}) — ` +
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
      { status: 500 },
    );
  }
}
