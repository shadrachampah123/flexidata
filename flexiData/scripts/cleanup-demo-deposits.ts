/**
 * Review-first cleanup for demo/mock wallet deposits.
 *
 * Before Paystack went live, the "Deposit / Add money" button simulated an
 * instant mobile-money top-up: it credited the wallet and wrote a "Wallet
 * Top-up" ledger row with no real payment behind it (and, later, a
 * `deposit_requests` row with `provider = "mock"`). Those simulated credits are
 * development/demo aids and should never exist as wallet money in a real
 * deployment. In production the app now hard-blocks creating them, but any
 * demo credits already written to the database remain until someone removes
 * them — which is what this tool does, review-first.
 *
 * It finds every demo/mock wallet credit and, after review, reverses it:
 *
 *   1. Debits the wallet by the demo credit amount with SQL arithmetic,
 *      clamped at zero (`GREATEST(0, balance - amount)`), so a wallet whose
 *      demo balance has since been spent can never go negative and real money
 *      is never touched.
 *   2. Parks the demo `deposit_requests` row as `failed` with an audit note.
 *   3. Marks the demo ledger row `reversed` (or `failed` where the `tx_status`
 *      enum predates `reversed`) with a provider audit note.
 *
 * Scope is deliberately narrow and reads-only until `--apply`:
 *
 *   - Only `deposit_requests` rows whose provider is NOT `paystack` and only
 *     `transactions` rows of `type = "deposit"` whose `ref` is not a real
 *     Paystack deposit are ever considered.
 *   - Real Paystack deposits, transfers (withdrawals), airtime-to-cash
 *     conversions, data/airtime purchases, redemptions and referral rewards are
 *     never touched.
 *   - It refuses to run against a production / remote database unless
 *     `--allow-production` is passed explicitly, and `--apply` always requires
 *     confirmation (skip with `--yes`).
 *   - Idempotent: a second run finds nothing left to reverse.
 *
 * Run:
 *   npx tsx scripts/cleanup-demo-deposits.ts                  # review (dry run)
 *   npx tsx scripts/cleanup-demo-deposits.ts --apply          # perform cleanup
 *   npx tsx scripts/cleanup-demo-deposits.ts --apply --yes \
 *       --allow-production --database-url "$DATABASE_URL"     # deliberate prod run
 *
 * The automated proof of all of the above lives in
 * `scripts/verify-demo-deposit-cleanup.ts` (`npm run verify:demo-deposit-cleanup`).
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { depositRequests, transactions, wallets } from "@/db/schema";

/**
 * The app's database client (`@/db`) and the schema-compatibility helpers are
 * loaded lazily, after the CLI has resolved the target connection string. The
 * app's `db/index.ts` throws at import time when `DATABASE_URL` is missing, and
 * `--help` / argument parsing must work without a database. Loading lazily also
 * lets `--database-url` (and the in-memory simulator used by the verify
 * harness) point the pool at the right target.
 */
function loadAppDb(): typeof import("@/db") {
  return require("@/db");
}

function loadSchemaCompat(): typeof import("@/lib/schema-compat") {
  return require("@/lib/schema-compat");
}

/** Audit note left on every row this tool reverses. */
const CLEANUP_NOTE = "Demo deposit reversed by cleanup (no real payment was taken).";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number): string {
  return `GH₵ ${n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* -------------------------------------------------------------------------- */
/* Target classification & production guard                                   */
/* -------------------------------------------------------------------------- */

export type TargetClassification = {
  /** The connection string used (never printed — only its host is surfaced). */
  dbUrl: string;
  /** Hostname only — what gets printed, never credentials. */
  host: string;
  isLocal: boolean;
  /** True when the target needs an explicit `--allow-production` acknowledgement. */
  requiresAcknowledgement: boolean;
  reasons: string[];
};

const PRODUCTION_HOST_HINTS =
  /(neon\.tech|supabase|rds\.amazonaws|azure|googleapis|cloudsql|vercel|render\.com|railway|fly\.dev|planetscale|cockroachlabs|timescale|heroku|cleardb|aivencloud|mongodb\.net|digitalocean|elephantsql)/i;

/**
 * Classify the target database so the tool can refuse to run against
 * production by default. Any non-local database — and any runtime with
 * `NODE_ENV=production` — requires an explicit acknowledgement.
 */
export function classifyTarget(dbUrl?: string): TargetClassification {
  const url = dbUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "No DATABASE_URL is set. Pass --database-url <url> or set DATABASE_URL in the environment.",
    );
  }

  let host = "unknown";
  try {
    host = new URL(url).hostname;
  } catch {
    // Not parseable as a URL — fall back to a conservative reading.
    host = url.replace(/^[^@]*@/, "").replace(/[/:].*$/, "");
  }

  const isLocal =
    ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal");

  const reasons: string[] = [];
  if (process.env.NODE_ENV === "production") reasons.push("NODE_ENV=production");
  if (!isLocal && PRODUCTION_HOST_HINTS.test(host)) {
    reasons.push(`host "${host}" matches a known managed/production database provider`);
  }
  if (!isLocal && !PRODUCTION_HOST_HINTS.test(host)) {
    reasons.push(`host "${host}" is a remote database (not localhost)`);
  }

  return { dbUrl: url, host, isLocal, requiresAcknowledgement: reasons.length > 0, reasons };
}

/* -------------------------------------------------------------------------- */
/* Discovery (read-only)                                                      */
/* -------------------------------------------------------------------------- */

export type DemoCredit = {
  ref: string;
  walletId: number;
  /** GH₵ credited to the wallet (no real payment behind it). */
  amount: number;
  /** Where the credit was found (both = deposit_requests + matching ledger row). */
  source: "deposit_request" | "ledger" | "both";
  createdAt: Date | null;
};

/** Refs of deposits created through Paystack — these are real money, never touched. */
async function paystackDepositRefs(): Promise<Set<string>> {
  const { db } = loadAppDb();
  try {
    const rows = await db
      .select({ ref: depositRequests.ref })
      .from(depositRequests)
      .where(eq(depositRequests.provider, "paystack"));
    return new Set(rows.map((r) => r.ref));
  } catch (error) {
    // A database without `deposit_requests` predates Paystack entirely: there
    // are no real Paystack deposits to protect.
    if (loadSchemaCompat().isMissingRelationError(error)) return new Set();
    throw error;
  }
}

/**
 * Find every demo/mock wallet credit:
 *
 *   (a) `deposit_requests` rows with a non-Paystack provider that settled
 *       (`status = "successful"`) — the modern mock deposit;
 *   (b) `transactions` rows of `type = "deposit"` whose `ref` is not a real
 *       Paystack deposit — covers legacy demo deposits written before
 *       `deposit_requests` existed.
 *
 * The two are merged by `ref` so a single credit is never double-counted.
 */
export async function collectDemoCredits(
  opts: { before?: Date; walletId?: number } = {},
): Promise<{ credits: DemoCredit[]; paystackDepositCount: number }> {
  const paystackRefs = await paystackDepositRefs();
  const byRef = new Map<string, DemoCredit>();
  const { db } = loadAppDb();

  try {
    const rows = await db.select().from(depositRequests).where(ne(depositRequests.provider, "paystack"));
    for (const row of rows) {
      // Belt-and-braces: the SQL filter already excludes Paystack deposits, but
      // never rely on that alone near money code — skip them again here.
      if (row.provider === "paystack") continue;
      if (row.status !== "successful") continue;
      if (opts.walletId != null && row.walletId !== opts.walletId) continue;
      if (opts.before && row.createdAt && row.createdAt > opts.before) continue;
      byRef.set(row.ref, {
        ref: row.ref,
        walletId: row.walletId,
        amount: round2(Number(row.amount)),
        source: "deposit_request",
        createdAt: row.createdAt ?? row.initiatedAt ?? null,
      });
    }
  } catch (error) {
    if (!loadSchemaCompat().isMissingRelationError(error)) throw error;
  }

  const ledgerRows = await db
    .select({
      ref: transactions.ref,
      walletId: transactions.walletId,
      status: transactions.status,
      amount: transactions.amount,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(eq(transactions.type, "deposit"));

  for (const row of ledgerRows) {
    if (row.status !== "successful") continue;
    if (paystackRefs.has(row.ref)) continue; // real Paystack deposit — never touched
    if (opts.walletId != null && row.walletId !== opts.walletId) continue;
    if (opts.before && row.createdAt && row.createdAt > opts.before) continue;

    const existing = byRef.get(row.ref);
    if (existing) {
      existing.source = "both";
      // The deposit_requests amount is authoritative; a mismatched ledger
      // wallet would be a data anomaly — keep the deposit row's wallet but log.
      if (existing.walletId !== row.walletId) {
        console.warn(
          `[cleanup] ref ${row.ref} has mismatched wallets (deposit ${existing.walletId} vs ledger ${row.walletId}); using ${existing.walletId}.`,
        );
      }
    } else {
      byRef.set(row.ref, {
        ref: row.ref,
        walletId: row.walletId,
        amount: round2(Number(row.amount)),
        source: "ledger",
        createdAt: row.createdAt,
      });
    }
  }

  return { credits: [...byRef.values()], paystackDepositCount: paystackRefs.size };
}

/* -------------------------------------------------------------------------- */
/* Plan & apply                                                               */
/* -------------------------------------------------------------------------- */

export type WalletCleanupPlan = {
  walletId: number;
  walletNumber: string | null;
  currentBalance: number;
  totalDemoCredit: number;
  /** min(currentBalance, totalDemoCredit) — what can actually be removed now. */
  removable: number;
  resultingBalance: number;
  /** Demo credit that cannot be removed because the balance has since been spent. */
  shortfall: number;
  credits: DemoCredit[];
};

export type CleanupPlan = {
  target: TargetClassification;
  wallets: WalletCleanupPlan[];
  demoCreditCount: number;
  paystackDepositCount: number;
  totalDemoCredit: number;
  totalRemovable: number;
  totalShortfall: number;
};

export async function buildCleanupPlan(
  opts: { before?: Date; walletId?: number; target?: TargetClassification } = {},
): Promise<CleanupPlan> {
  const target = opts.target ?? classifyTarget(undefined);
  // Point the app's database pool at the resolved target. The pool is created
  // lazily on first use (loadAppDb), so this takes effect for both the real
  // CLI (`--database-url`) and the in-memory verify harness.
  process.env.DATABASE_URL = target.dbUrl;
  const { db } = loadAppDb();

  const { credits, paystackDepositCount } = await collectDemoCredits({
    before: opts.before,
    walletId: opts.walletId,
  });

  const walletIds = [...new Set(credits.map((c) => c.walletId))];
  const walletRows = walletIds.length
    ? await db
        .select({ id: wallets.id, number: wallets.number, balance: wallets.balance })
        .from(wallets)
        .where(inArray(wallets.id, walletIds))
    : [];
  const balanceById = new Map(walletRows.map((w) => [w.id, round2(Number(w.balance))]));
  const numberById = new Map(walletRows.map((w) => [w.id, w.number]));

  const plans: WalletCleanupPlan[] = walletIds.map((walletId) => {
    const walletCredits = credits
      .filter((c) => c.walletId === walletId)
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    const totalDemoCredit = round2(walletCredits.reduce((sum, c) => sum + c.amount, 0));
    const currentBalance = balanceById.get(walletId) ?? 0;
    const removable = round2(Math.min(currentBalance, totalDemoCredit));
    return {
      walletId,
      walletNumber: numberById.get(walletId) ?? null,
      currentBalance,
      totalDemoCredit,
      removable,
      resultingBalance: round2(currentBalance - removable),
      shortfall: round2(totalDemoCredit - removable),
      credits: walletCredits,
    };
  });

  return {
    target,
    wallets: plans.sort((a, b) => a.walletId - b.walletId),
    demoCreditCount: credits.length,
    paystackDepositCount,
    totalDemoCredit: round2(plans.reduce((s, p) => s + p.totalDemoCredit, 0)),
    totalRemovable: round2(plans.reduce((s, p) => s + p.removable, 0)),
    totalShortfall: round2(plans.reduce((s, p) => s + p.shortfall, 0)),
  };
}

export type ApplyResult = {
  walletsDebited: number;
  depositsParked: number;
  ledgerRowsReversed: number;
  removed: number;
};

/**
 * Perform the reversal described by `plan`. Each wallet is processed in its
 * own database transaction (balance debit + its rows all-or-nothing). Reads
 * the schema capabilities once up front so the ledger update can fall back to
 * `status = "failed"` and skip gateway columns on a pre-gateway database.
 */
export async function applyCleanup(plan: CleanupPlan): Promise<ApplyResult> {
  const { db } = loadAppDb();
  const compat = loadSchemaCompat();
  const caps = await compat.getSchemaCapabilities();
  const canReverse = compat.supportsTxStatusValue(caps, "reversed");
  const ledgerStatus = canReverse ? "reversed" : "failed";
  const now = new Date();

  let walletsDebited = 0;
  let depositsParked = 0;
  let ledgerRowsReversed = 0;
  let removed = 0;

  for (const wallet of plan.wallets) {
    await db.transaction(async (tx) => {
      // 1. Debit the wallet — SQL arithmetic clamped at zero, never an
      //    absolute write, never below zero.
      if (wallet.totalDemoCredit > 0) {
        await tx
          .update(wallets)
          .set({
            balance: sql`GREATEST(0, ${wallets.balance} - ${wallet.totalDemoCredit.toFixed(2)})::numeric`,
          })
          .where(eq(wallets.id, wallet.walletId));
        walletsDebited += 1;
        removed += wallet.removable;
      }

      // 2. Park the demo deposit_requests rows (terminal state, audited).
      for (const credit of wallet.credits) {
        if (credit.source === "ledger") continue;
        await tx
          .update(depositRequests)
          .set({
            status: "failed",
            completedAt: now,
            verifiedAt: now,
            paystackGatewayResponse: CLEANUP_NOTE,
            updatedAt: now,
          })
          .where(
            and(eq(depositRequests.ref, credit.ref), eq(depositRequests.status, "successful")),
          );
        depositsParked += 1;
      }

      // 3. Mark the demo ledger rows reversed (or failed on a legacy enum).
      for (const credit of wallet.credits) {
        // A deposit_request-only credit has no ledger row (defensive); never
        // touch a ledger row that is not itself a demo deposit credit.
        if (credit.source === "deposit_request") continue;
        const values: Record<string, unknown> = {
          status: ledgerStatus,
          refundedAt: now,
          providerStatus: "reversed",
          providerMessage: CLEANUP_NOTE,
        };
        const setValues = compat.omitMissingGatewayColumns(caps, "transactions", values) as Partial<
          typeof transactions.$inferInsert
        >;
        await tx
          .update(transactions)
          .set(setValues)
          .where(
            and(
              eq(transactions.ref, credit.ref),
              eq(transactions.type, "deposit"),
              eq(transactions.status, "successful"),
            ),
          );
        ledgerRowsReversed += 1;
      }
    });
  }

  return {
    walletsDebited,
    depositsParked,
    ledgerRowsReversed,
    removed: round2(removed),
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

function sourceLabel(source: DemoCredit["source"]): string {
  if (source === "deposit_request") return "mock deposit";
  if (source === "ledger") return "legacy demo credit";
  return "mock deposit + ledger";
}

export function renderPlan(plan: CleanupPlan): string {
  const lines: string[] = [];
  lines.push("FlexiData — demo/mock deposit cleanup (review)");
  lines.push(`Target database host: ${plan.target.host}`);
  lines.push("");
  lines.push(
    `Demo/mock wallet credits found: ${plan.demoCreditCount} (${money(plan.totalDemoCredit)} total)`,
  );
  lines.push(`Real Paystack deposits present (will be left untouched): ${plan.paystackDepositCount}`);
  lines.push("");

  for (const wallet of plan.wallets) {
    lines.push(`Wallet #${wallet.walletId}${wallet.walletNumber ? ` (${wallet.walletNumber})` : ""}`);
    lines.push(`  current balance     ${money(wallet.currentBalance)}`);
    lines.push(`  demo credit total   ${money(wallet.totalDemoCredit)}`);
    lines.push(`  to remove           ${money(wallet.removable)}`);
    lines.push(`  resulting balance   ${money(wallet.resultingBalance)}`);
    lines.push(`  shortfall (spent)   ${money(wallet.shortfall)}`);
    for (const credit of wallet.credits) {
      const when = credit.createdAt ? ` · ${credit.createdAt.toISOString()}` : "";
      lines.push(`    ${credit.ref}  ${money(credit.amount)}  (${sourceLabel(credit.source)})${when}`);
    }
    lines.push("");
  }

  lines.push("Summary:");
  lines.push(`  wallets: ${plan.wallets.length}`);
  lines.push(`  demo credits: ${plan.demoCreditCount} → remove ${money(plan.totalRemovable)}`);
  lines.push(`  shortfall (cannot remove — balance already spent): ${money(plan.totalShortfall)}`);
  lines.push("");
  lines.push(
    "NOT touched: real Paystack deposits, transfers (withdrawals), conversions (airtime→cash), data/airtime purchases, redemptions, referral rewards.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/cleanup-demo-deposits.ts [options]

Review-first reversal of demo/mock wallet deposit credits.

Options:
  --apply                Perform the cleanup (default is a read-only DRY RUN).
  --yes                  Skip the interactive confirmation before --apply.
  --allow-production     Acknowledge that the target database may be production.
                         Without this, the tool refuses any non-local target
                         (and any NODE_ENV=production runtime), even for a dry run.
  --database-url <url>   Connection string to use instead of DATABASE_URL.
  --wallet <id>          Restrict the cleanup to a single wallet.
  --before <ISO date>    Only reverse demo credits created before this date.
  --help, -h             Show this help.

A dry run SELECTs only and never writes. The automated proof runs via
npm run verify:demo-deposit-cleanup (in-memory, no database needed).`);
}

type CliOptions = {
  apply: boolean;
  yes: boolean;
  allowProduction: boolean;
  databaseUrl?: string;
  walletId?: number;
  before?: Date;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    apply: false,
    yes: false,
    allowProduction: false,
    databaseUrl: process.env.DATABASE_URL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--yes") opts.yes = true;
    else if (arg === "--allow-production") opts.allowProduction = true;
    else if (arg === "--database-url") {
      opts.databaseUrl = argv[++i];
      if (!opts.databaseUrl) throw new Error("--database-url requires a value");
    } else if (arg === "--wallet") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--wallet requires a positive integer");
      opts.walletId = value;
    } else if (arg === "--before") {
      const value = argv[++i];
      if (!value) throw new Error("--before requires an ISO date");
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid --before date: ${value}`);
      opts.before = date;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function confirm(question: string): Promise<boolean> {
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim().toUpperCase() === "CLEANUP");
    });
  });
}

export async function runCli(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);

  // Production guard FIRST — before any database access.
  const target = classifyTarget(opts.databaseUrl);
  if (target.requiresAcknowledgement && !opts.allowProduction) {
    console.error("Refusing to run: the target database may be production.");
    for (const reason of target.reasons) console.error(`  - ${reason}`);
    console.error("");
    console.error(
      "This tool never runs against a production database by default. If you are",
      "deliberately operating on this database, re-run with --allow-production.",
    );
    process.exitCode = 2;
    return;
  }
  if (target.requiresAcknowledgement && opts.allowProduction) {
    console.warn("⚠️  Running with --allow-production against a non-local/production target.");
    console.warn(`    Host: ${target.host}`);
  }

  const plan = await buildCleanupPlan({ before: opts.before, walletId: opts.walletId, target });
  console.log(renderPlan(plan));

  if (!opts.apply) {
    console.log("");
    console.log("DRY RUN — no changes were made. Re-run with --apply to perform the cleanup.");
    return;
  }

  if (plan.wallets.length === 0) {
    console.log("");
    console.log("Nothing to clean up.");
    return;
  }

  if (!opts.yes) {
    const ok = await confirm("Type CLEANUP to proceed: ");
    if (!ok) {
      console.log("Aborted — no changes were made.");
      return;
    }
  }

  const result = await applyCleanup(plan);
  console.log("");
  console.log("Cleanup applied:");
  console.log(`  wallets debited:      ${result.walletsDebited}`);
  console.log(`  deposits parked:      ${result.depositsParked}`);
  console.log(`  ledger rows reversed: ${result.ledgerRowsReversed}`);
  console.log(`  wallet balance removed: ${money(result.removed)}`);
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error("cleanup-demo-deposits failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
