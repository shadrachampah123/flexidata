/**
 * Payout-readiness security + accounting regression suite (F1–F8, W1–W4).
 *
 * Permanent guard for the withdrawal system. It proves, against the REAL code
 * and (in Phases B/C) a REAL database and app server:
 *
 *   F1  withdrawal method + destination validation (whitelist, strict Ghana
 *       mobile, no truncation, network matching — before any mutation)
 *   F2  withdrawal idempotency (one key → one deduction, one withdrawal, one
 *       ledger row — even concurrently; replays reuse the original result)
 *   F3  exact decimal money (`5.50` is GH₵5.50, never GH₵550 — withdrawals,
 *       deposits, transfers, fees, stored values)
 *   F4  admin reconciliation classifies the withdrawal lifecycle correctly
 *       (pending/processing/successful = debit; rejected/refunded = zero)
 *   F5  approval authorizes (`processing`) but never completes a payout: the
 *       ledger stays non-successful and `successful` is unreachable via admin API
 *   F6  stored-data integrity (CHECK constraints + idempotency index probed
 *       directly, incl. expected SQLSTATEs)
 *   F7  stale clients can never override the authoritative server balance
 *   F8  malformed API input is refused with ZERO side effects
 *   W1  decimal input is exact on every money tab (deposit/withdraw/transfer)
 *   W2  destinations are never truncated; transfers fail closed; the Paystack
 *       deposit `source` is a provider hint only
 *   W3  fee preview and server charge share one integer-pesewa quote
 *   W4  ledger subtitles come from trusted server metadata (no client strings)
 *
 * Layout:
 *   Phase A — pure validation/parsing/transition rules (no env needed).
 *   Phase B — database objects, constraint probes, reconciliation SQL
 *             (needs DATABASE_URL).
 *   Phase C — end-to-end API behavior (needs DATABASE_URL + BASE_URL).
 *
 * Safety rules (same as the sibling verify scripts):
 *   * refuses a non-local BASE_URL unless ALLOW_PRODUCTION=1;
 *   * every row it creates is tagged `fd-ws-` (users) or tracked by id and is
 *     deleted again before exit (audit rows first — they RESTRICT; ledger and
 *     deposit rows are FK-less so they are deleted explicitly);
 *   * the genuine live Paystack deposit `DP-MTMZN2P8SSBR` is snapshotted before
 *     and after and must be byte-identical;
 *   * Phase C requires the mock funding provider (instant settlement); against
 *     any other provider it fails loudly instead of hanging on checkout.
 *
 * Usage from the flexiData directory:
 *   npx tsx scripts/verify-withdrawal-security.ts                                  # Phase A only
 *   DATABASE_URL='postgresql://…' npx tsx scripts/verify-withdrawal-security.ts   # A + B
 *   DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' npx tsx scripts/verify-withdrawal-security.ts
 */
import { Pool } from "pg";
import {
  moneyFromPesewas,
  parseCedisAmount,
  pesewasToCedisString,
  sanitizeCedisInput,
  withdrawalQuote,
} from "../src/lib/money";
import {
  normalizeGhanaMobileStrict,
  withdrawalMethodMatchesNetwork,
  withdrawalSubtitle,
  WITHDRAWAL_METHOD_META,
  WITHDRAWAL_METHODS,
} from "../src/lib/ghana-mobile";
import {
  ADMIN_WITHDRAWAL_ACTIONS,
  assertWithdrawalTransition,
  canTransitionWithdrawal,
  validateWithdrawalRequestBody,
  WithdrawalTransitionError,
} from "../src/lib/withdrawals";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";
const ADMIN_EMAIL = "fd-ws-admin@verify.flexidata.internal";
const PREFIX = "fd-ws-";
const PASSWORD = "Passw0rd!long-verify";

let failures = 0;
let checks = 0;
const ok = (label: string, detail = ""): void => {
  checks += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
};
const bad = (label: string, detail = ""): void => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};
const note = (label: string, detail = ""): void => console.log(`  ·    ${label}${detail ? ` — ${detail}` : ""}`);
const check = (label: string, cond: boolean, detail = ""): void => {
  if (cond) ok(label, detail);
  else bad(label, detail);
};

/** Minimal cookie jar so the drive uses the app's real session handling. */
class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(base: string, path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(base + path, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: this.header(), ...(init.headers ?? {}) },
      redirect: "manual",
    });
    this.absorb(res);
    return res;
  }
}

async function main(): Promise<void> {
  console.log("\nPhase A — pure validation / parsing / lifecycle rules\n");
  phaseA();

  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const baseUrl = process.env.BASE_URL?.trim() ?? "";
  if (
    baseUrl &&
    !/^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(baseUrl) &&
    process.env.ALLOW_PRODUCTION !== "1"
  ) {
    console.error(
      `BASE_URL (${baseUrl}) does not look like a local test server (127.0.0.1 / localhost).\n` +
        "This script creates and deletes database rows; pass ALLOW_PRODUCTION=1 to force it.",
    );
    process.exit(2);
  }

  if (!databaseUrl) {
    note("Phase B skipped", "set DATABASE_URL to probe the database objects");
    note("Phase C skipped", "set DATABASE_URL + BASE_URL to drive the real API end to end");
  } else {
    const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 10_000 });
    const protectedBefore = await pool
      .query("select ref, status, amount, wallet_id, paystack_transaction_id from deposit_requests where ref = $1", [
        PROTECTED_REF,
      ])
      .then((r) => r.rows)
      .catch(() => null);
    // Baseline: no NEW successful payout rows may appear during this run.
    const payoutsBefore = await pool
      .query(
        "select (select count(*)::int from transactions where type = 'withdrawal' and status = 'successful') as ledger, " +
          "(select count(*)::int from withdrawal_requests where status = 'successful') as requests",
      )
      .then((r) => r.rows[0] as { ledger: number; requests: number })
      .catch(() => null);

    // Fixture ids collected for cleanup (users cascade wallets/withdrawals;
    // transactions + deposit_requests are FK-less and go explicitly).
    const track = { userEmails: [] as string[], walletIds: [] as number[] };
    try {
      console.log("\nPhase B — database objects, constraint probes, reconciliation SQL\n");
      await phaseB(pool, track);
      if (baseUrl) {
        console.log("\nPhase C — end-to-end API behavior\n");
        await phaseC(pool, baseUrl, track, payoutsBefore);
      } else {
        note("Phase C skipped", "set BASE_URL to drive the real API end to end");
      }
    } finally {
      await cleanup(pool, track);
      if (protectedBefore) {
        const protectedAfter = await pool
          .query("select ref, status, amount, wallet_id, paystack_transaction_id from deposit_requests where ref = $1", [
            PROTECTED_REF,
          ])
          .then((r) => r.rows)
          .catch(() => null);
        check(
          `genuine deposit ${PROTECTED_REF} untouched`,
          protectedAfter !== null && JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
          protectedBefore.length ? "row unchanged" : "not present",
        );
      }
      await pool.end();
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Phase A — pure rules (F1/F3/F5/F8/W2/W3/W4 validators, no I/O)
// ---------------------------------------------------------------------------

function phaseA(): void {
  // --- A1: strict Ghana mobile normalization (F1/W2) -------------------------
  const validMobile: Array<[unknown, string, string]> = [
    ["0244123456", "0244123456", "MTN"],
    ["0201234567", "0201234567", "TELECEL"],
    ["0501234567", "0501234567", "TELECEL"],
    ["0251234567", "0251234567", "MTN"],
    ["0531234567", "0531234567", "MTN"],
    ["0541234567", "0541234567", "MTN"],
    ["0551234567", "0551234567", "MTN"],
    ["0591234567", "0591234567", "MTN"],
    ["244123456", "0244123456", "MTN"], // 9-digit local
    ["201234567", "0201234567", "TELECEL"], // 9-digit local
    ["233244123456", "0244123456", "MTN"], // country code
    ["+233244123456", "0244123456", "MTN"], // +country code
    ["00233244123456", "0244123456", "MTN"], // trunk international
    ["024 412 3456", "0244123456", "MTN"], // spaced
    ["024-412-3456", "0244123456", "MTN"], // dashed
    ["(024) 412-3456", "0244123456", "MTN"], // cosmetic separators
    ["  0244123456  ", "0244123456", "MTN"], // padded
    ["0261234567", "0261234567", "AIRTELTIGO"], // recognized, not payout-capable
    ["0271234567", "0271234567", "AIRTELTIGO"],
    ["0561234567", "0561234567", "AIRTELTIGO"],
    ["0571234567", "0571234567", "AIRTELTIGO"],
  ];
  for (const [input, msisdn10, network] of validMobile) {
    const r = normalizeGhanaMobileStrict(input);
    check(
      `mobile accepts ${JSON.stringify(input)}`,
      r.ok && r.msisdn10 === msisdn10 && r.network === network,
      r.ok ? `${r.msisdn10} ${r.network}` : `rejected (${r.ok ? "" : r.error})`,
    );
  }
  const invalidMobile: Array<[unknown, string]> = [
    ["", "empty"],
    ["   ", "whitespace"],
    [null, "null"],
    [undefined, "undefined"],
    [244123456, "number type (leading zero unrepresentable)"],
    [{}, "object"],
    [[], "array"],
    [true, "boolean"],
    ["024412345", "too short (9 digits with trunk 0)"],
    ["02441234", "too short"],
    ["02441234567", "11 digits — must NOT truncate"],
    ["024412345678", "12 digits — must NOT truncate"],
    ["2332441234567", "13-digit garbage"],
    ["abcdefghij", "garbage characters"],
    ["024-abc-4567", "mixed garbage"],
    ["+", "bare plus"],
    ["233", "bare country code"],
    ["0231234567", "unknown prefix 023"],
    ["0281234567", "defunct prefix 028"],
    ["0211234567", "unknown prefix 021"],
    ["1234567890", "10 digits without trunk 0"],
    ["002332441234567", "over-long international"],
    ["2330244123456", "country code + trunk 0"],
    ["23333244123456", "double country code"],
    ["0244123456x", "trailing letter"],
    ["++233244123456", "double plus"],
  ];
  for (const [input, why] of invalidMobile) {
    const r = normalizeGhanaMobileStrict(input);
    check(`mobile rejects ${JSON.stringify(input)} (${why})`, !r.ok, r.ok ? `accepted as ${r.msisdn10}!` : "");
  }
  // Truncation can never validate: every over-long input above failed, and the
  // canonical output is always exactly 10 digits starting with 0.
  const trunc = normalizeGhanaMobileStrict("02441234567890123456789");
  check("grossly over-long input rejected, never truncated", !trunc.ok);
  // Network scoping.
  check("network scope accepts MTN number for [MTN]", normalizeGhanaMobileStrict("0244123456", { networks: ["MTN"] }).ok);
  check(
    "network scope accepts Telecel number for [TELECEL]",
    normalizeGhanaMobileStrict("0201234567", { networks: ["TELECEL"] }).ok,
  );
  check(
    "network scope rejects AirtelTigo for payout networks",
    !normalizeGhanaMobileStrict("0261234567", { networks: ["MTN", "TELECEL"] }).ok,
  );
  check(
    "network scope rejects Telecel for [MTN]",
    !normalizeGhanaMobileStrict("0201234567", { networks: ["MTN"] }).ok,
  );

  // --- A2: method whitelist + network matching (F1) ---------------------------
  check(
    "withdrawal methods are exactly momo_mtn + telecel_cash",
    WITHDRAWAL_METHODS.length === 2 && WITHDRAWAL_METHODS.includes("momo_mtn") && WITHDRAWAL_METHODS.includes("telecel_cash"),
    WITHDRAWAL_METHODS.join(","),
  );
  check(
    "method metadata is trusted server-side (labels + networks)",
    WITHDRAWAL_METHOD_META.momo_mtn.label === "MTN MoMo" &&
      WITHDRAWAL_METHOD_META.momo_mtn.network === "MTN" &&
      WITHDRAWAL_METHOD_META.telecel_cash.label === "Telecel Cash" &&
      WITHDRAWAL_METHOD_META.telecel_cash.network === "TELECEL",
  );
  check("momo_mtn matches MTN", withdrawalMethodMatchesNetwork("momo_mtn", "MTN"));
  check("telecel_cash matches TELECEL", withdrawalMethodMatchesNetwork("telecel_cash", "TELECEL"));
  check("momo_mtn rejects TELECEL", !withdrawalMethodMatchesNetwork("momo_mtn", "TELECEL"));
  check("telecel_cash rejects MTN", !withdrawalMethodMatchesNetwork("telecel_cash", "MTN"));
  check("momo_mtn rejects AIRTELTIGO", !withdrawalMethodMatchesNetwork("momo_mtn", "AIRTELTIGO"));
  check("telecel_cash rejects AIRTELTIGO", !withdrawalMethodMatchesNetwork("telecel_cash", "AIRTELTIGO"));
  check(
    "subtitle is trusted metadata (MTN)",
    withdrawalSubtitle("momo_mtn", "0244123456") === "MTN MoMo • 024 412 3456",
    withdrawalSubtitle("momo_mtn", "0244123456"),
  );
  check(
    "subtitle is trusted metadata (Telecel)",
    withdrawalSubtitle("telecel_cash", "0201234567") === "Telecel Cash • 020 123 4567",
    withdrawalSubtitle("telecel_cash", "0201234567"),
  );
  check(
    "subtitle is deterministic and bounded",
    withdrawalSubtitle("momo_mtn", "0244123456").length < 200 &&
      withdrawalSubtitle("momo_mtn", "0244123456") === withdrawalSubtitle("momo_mtn", "0244123456"),
  );

  // --- A3: exact money parsing (F3/W1) ----------------------------------------
  const validMoney: Array<[unknown, number, string]> = [
    ["5", 500, "5.00"],
    ["5.00", 500, "5.00"],
    ["5.5", 550, "5.50"],
    ["5.50", 550, "5.50"],
    ["10.25", 1025, "10.25"],
    ["100.99", 10099, "100.99"],
    ["0.01", 1, "0.01"],
    ["  5.50  ", 550, "5.50"],
    ["007.50", 750, "7.50"],
    ["9999999999.99", 999999999999, "9999999999.99"],
    [5, 500, "5.00"],
    [5.5, 550, "5.50"],
    [10.25, 1025, "10.25"],
    [100.99, 10099, "100.99"],
    [0.01, 1, "0.01"],
  ];
  for (const [input, pesewas, cedis] of validMoney) {
    const r = parseCedisAmount(input);
    check(
      `money parses ${JSON.stringify(input)} → ${pesewas}p`,
      r.ok && r.pesewas === pesewas && r.cedis === cedis,
      r.ok ? `${r.pesewas}p ${r.cedis}` : "rejected!",
    );
  }
  const invalidMoney: Array<[unknown, string]> = [
    ["0", "zero"], ["0.00", "zero"], [0, "zero number"],
    ["-5", "negative"], ["-5.00", "negative"], [-1, "negative number"], [-0.01, "negative"],
    ["", "empty"], ["   ", "whitespace"],
    ["abc", "garbage"], ["5.555", "excess precision"], ["5.999", "excess precision"], [5.555, "excess precision number"],
    ["5.", "dangling point"], [".5", "missing whole part"],
    ["1e3", "exponent"], ["1E3", "exponent"], ["0x10", "hex"],
    ["5,50", "comma decimal"], ["GH₵5.50", "currency symbol"], ["5.50 GH₵", "trailing text"],
    [NaN, "NaN"], [Infinity, "Infinity"], [-Infinity, "-Infinity"],
    [null, "null"], [undefined, "undefined"], [true, "boolean"], [false, "boolean"],
    [[], "array"], [{}, "object"],
    ["99999999999.99", "beyond numeric(12,2)"],
    [1e21, "huge float"],
    [0.1 + 0.2, "float residue 0.30000000000000004"],
  ];
  for (const [input, why] of invalidMoney) {
    const r = parseCedisAmount(input);
    check(
      `money rejects ${typeof input === "number" ? String(input) : JSON.stringify(input)} (${why})`,
      !r.ok,
      r.ok ? `parsed as ${r.pesewas}p!` : "",
    );
  }
  // THE critical regression: 5.50 is 550 pesewas, never 550 cedis.
  const critical = parseCedisAmount("5.50");
  check("CRITICAL: '5.50' → exactly GH₵5.50 (550p)", critical.ok && critical.pesewas === 550 && critical.cedis === "5.50");
  check("sanitizeCedisInput passes exact decimals", sanitizeCedisInput("5.50") === "5.50" && sanitizeCedisInput(5.5) === "5.5");
  check(
    "sanitizeCedisInput refuses non-exact input",
    sanitizeCedisInput(null) === null && sanitizeCedisInput(0.1 + 0.2) === null && sanitizeCedisInput("5.555") === null,
  );
  check(
    "pesewasToCedisString is the exact inverse",
    pesewasToCedisString(550) === "5.50" && pesewasToCedisString(5) === "0.05" && pesewasToCedisString(10099) === "100.99",
  );

  // --- A4: withdrawal quote — one rule for preview and charge (W3) ------------
  const quotes: Array<[number, number, number]> = [
    [500, 10, 490],
    [550, 11, 539],
    [1025, 21, 1004], // round(20.5) = 21 — the GH₵10.25 float-trap value
    [10099, 202, 9897],
    [100, 2, 98],
    [1, 0, 1],
    [666, 13, 653],
    [777, 16, 761],
  ];
  for (const [amount, fee, net] of quotes) {
    const q = withdrawalQuote(amount);
    check(
      `quote ${amount}p → fee ${fee}p net ${net}p`,
      q !== null && q.feePesewas === fee && q.netPesewas === net,
      q ? `fee ${q.feePesewas} net ${q.netPesewas}` : "null!",
    );
  }
  const sweep = [100, 101, 333, 499, 500, 501, 999, 1000, 1234, 5555, 10000, 99999, 500000];
  check(
    "quote invariant fee + net === amount (13 values)",
    sweep.every((a) => {
      const q = withdrawalQuote(a);
      return q !== null && q.feePesewas + q.netPesewas === a;
    }),
  );
  check(
    "quote rejects non-positive / non-integer input",
    withdrawalQuote(0) === null && withdrawalQuote(-5) === null && withdrawalQuote(1.5) === null && withdrawalQuote(NaN) === null,
  );
  check(
    "moneyFromPesewas formats without float",
    moneyFromPesewas(550) === "GH₵ 5.50" && moneyFromPesewas(100999) === "GH₵ 1,009.99" && moneyFromPesewas(0) === "GH₵ 0.00",
    `${moneyFromPesewas(550)} / ${moneyFromPesewas(100999)}`,
  );

  // --- A5: withdrawal request body validation (F1/F3/F8) -----------------------
  const goodBodies: Array<[unknown, { pesewas: number; method: string; msisdn10: string; key: boolean }]> = [
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456" }, { pesewas: 550, method: "momo_mtn", msisdn10: "0244123456", key: false }],
    [
      { amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "550e8400-e29b-41d4-a716-446655440000" },
      { pesewas: 550, method: "momo_mtn", msisdn10: "0244123456", key: true },
    ],
    [{ amount: 5, method: "telecel_cash", dest: "0201234567" }, { pesewas: 500, method: "telecel_cash", msisdn10: "0201234567", key: false }],
    [{ amount: "10.25", method: "momo_mtn", dest: "+233244123456" }, { pesewas: 1025, method: "momo_mtn", msisdn10: "0244123456", key: false }],
    [{ amount: " 5.00 ", method: "momo_mtn", dest: "024 412 3456" }, { pesewas: 500, method: "momo_mtn", msisdn10: "0244123456", key: false }],
    [{ amount: "100.99", method: "telecel_cash", dest: "0501234567", idempotencyKey: "abcdefgh" }, { pesewas: 10099, method: "telecel_cash", msisdn10: "0501234567", key: true }],
  ];
  for (const [body, exp] of goodBodies) {
    const r = validateWithdrawalRequestBody(body);
    check(
      `body accepts ${JSON.stringify(body)}`,
      r.ok &&
        r.value.amountPesewas === exp.pesewas &&
        r.value.method === exp.method &&
        r.value.msisdn10 === exp.msisdn10 &&
        (r.value.idempotencyKey !== null) === exp.key,
      r.ok ? `${r.value.amountPesewas}p ${r.value.method} ${r.value.msisdn10}` : `rejected (${r.ok ? "" : r.error})`,
    );
  }
  const feeCheck = validateWithdrawalRequestBody({ amount: "5.50", method: "momo_mtn", dest: "0244123456" });
  check(
    "validated body carries the exact quote (fee 0.11 net 5.39)",
    feeCheck.ok && feeCheck.value.feeCedis === "0.11" && feeCheck.value.netCedis === "5.39",
  );
  const badBodies: Array<[unknown, string]> = [
    // method
    [{ amount: "5.50", method: "momo", dest: "0244123456" }, "legacy 'momo'"],
    [{ amount: "5.50", method: "card", dest: "0244123456" }, "'card'"],
    [{ amount: "5.50", method: "MTN", dest: "0244123456" }, "wrong case/shape"],
    [{ amount: "5.50", method: "momo_mtn ", dest: "0244123456" }, "trailing space"],
    [{ amount: "5.50", method: "", dest: "0244123456" }, "empty method"],
    [{ amount: "5.50", method: null, dest: "0244123456" }, "null method"],
    [{ amount: "5.50", method: 123, dest: "0244123456" }, "numeric method"],
    [{ amount: "5.50", method: {}, dest: "0244123456" }, "object method"],
    [{ amount: "5.50", method: [], dest: "0244123456" }, "array method"],
    [{ amount: "5.50", dest: "0244123456" }, "missing method"],
    [{ amount: "5.50", method: "m".repeat(41), dest: "0244123456" }, "over-long method"],
    // dest
    [{ amount: "5.50", method: "momo_mtn", dest: null }, "null dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "" }, "empty dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "abc" }, "garbage dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "02441" }, "short dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "02441234567" }, "long dest (no truncation)"],
    [{ amount: "5.50", method: "momo_mtn", dest: 244123456 }, "numeric dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: {} }, "object dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: [] }, "array dest"],
    [{ amount: "5.50", method: "momo_mtn" }, "missing dest"],
    // mismatch
    [{ amount: "5.50", method: "momo_mtn", dest: "0201234567" }, "MTN method + Telecel number"],
    [{ amount: "5.50", method: "telecel_cash", dest: "0244123456" }, "Telecel method + MTN number"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0261234567" }, "MTN method + AirtelTigo number"],
    // amount
    [{ method: "momo_mtn", dest: "0244123456" }, "missing amount"],
    [{ amount: null, method: "momo_mtn", dest: "0244123456" }, "null amount"],
    [{ amount: 0, method: "momo_mtn", dest: "0244123456" }, "zero amount"],
    [{ amount: "0", method: "momo_mtn", dest: "0244123456" }, "zero string"],
    [{ amount: -5, method: "momo_mtn", dest: "0244123456" }, "negative amount"],
    [{ amount: "5.555", method: "momo_mtn", dest: "0244123456" }, "excess precision"],
    [{ amount: "abc", method: "momo_mtn", dest: "0244123456" }, "garbage amount"],
    [{ amount: {}, method: "momo_mtn", dest: "0244123456" }, "object amount"],
    [{ amount: [], method: "momo_mtn", dest: "0244123456" }, "array amount"],
    [{ amount: true, method: "momo_mtn", dest: "0244123456" }, "boolean amount"],
    [{ amount: "4.99", method: "momo_mtn", dest: "0244123456" }, "below GH₵5 minimum"],
    [{ amount: 4.99, method: "momo_mtn", dest: "0244123456" }, "below minimum (number)"],
    // smuggled / unknown keys
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", walletId: 1 }, "smuggled walletId"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", userId: 1 }, "smuggled userId"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", status: "successful" }, "smuggled status"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", balance: 999 }, "smuggled balance"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", foo: 1 }, "unknown key"],
    // body shape
    [null, "null body"], [[], "array body"], [{}, "empty object"], ["str", "string body"], [5, "number body"],
    // idempotency keys
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: null }, "null key"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "" }, "empty key"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: 123 }, "numeric key"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "short" }, "too-short key"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "x".repeat(65) }, "too-long key"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "has space" }, "key with space"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "key!@#$" }, "key with symbols"],
  ];
  for (const [body, why] of badBodies) {
    const r = validateWithdrawalRequestBody(body);
    check(`body rejects ${why}`, !r.ok, r.ok ? "accepted!" : "");
  }
  check(
    "64-char key accepted (boundary)",
    validateWithdrawalRequestBody({ amount: "5.50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "k".repeat(64) }).ok,
  );

  // --- A6: lifecycle transitions (F5) ------------------------------------------
  check("pending → processing allowed", canTransitionWithdrawal("pending", "processing"));
  check("pending → rejected allowed", canTransitionWithdrawal("pending", "rejected"));
  check("pending → successful FORBIDDEN", !canTransitionWithdrawal("pending", "successful"));
  check("pending → pending forbidden", !canTransitionWithdrawal("pending", "pending"));
  // Phase 2 expansion: processing can now transition to successful (via provider callback),
  // rejected (admin rejection), or refunded (admin refund / provider failure). These are
  // controlled transitions — successful is ONLY reachable via the provider callback endpoint,
  // NOT via any admin API.
  check("processing → successful allowed (provider callback only)", canTransitionWithdrawal("processing", "successful"));
  check("processing → rejected allowed (admin can reject from processing)", canTransitionWithdrawal("processing", "rejected"));
  check("processing → refunded allowed (admin refund / provider failure)", canTransitionWithdrawal("processing", "refunded"));
  check("processing → pending forbidden", !canTransitionWithdrawal("processing", "pending"));
  check("rejected → processing forbidden", !canTransitionWithdrawal("rejected", "processing"));
  check("rejected → rejected forbidden", !canTransitionWithdrawal("rejected", "rejected"));
  check("successful → * forbidden", !canTransitionWithdrawal("successful", "processing"));
  check("unknown from-state forbidden", !canTransitionWithdrawal("nope", "processing"));
  check("unknown to-state forbidden", !canTransitionWithdrawal("pending", "nope"));
  let threw: unknown = null;
  try {
    assertWithdrawalTransition("pending", "processing");
  } catch (e) {
    threw = e;
  }
  check("assert allows pending → processing", threw === null);
  threw = null;
  try {
    assertWithdrawalTransition("pending", "successful");
  } catch (e) {
    threw = e;
  }
  check(
    "assert throws WithdrawalTransitionError on pending → successful",
    threw instanceof WithdrawalTransitionError,
    threw instanceof Error ? threw.message : String(threw),
  );
  check(
    "admin API expresses only approve→processing + reject→rejected + refund→refunded (never successful)",
    ADMIN_WITHDRAWAL_ACTIONS.approve === "processing" &&
      ADMIN_WITHDRAWAL_ACTIONS.reject === "rejected" &&
      (ADMIN_WITHDRAWAL_ACTIONS as Record<string, string>).refund === "refunded" &&
      !Object.values(ADMIN_WITHDRAWAL_ACTIONS).includes("successful" as never),
  );
}

// ---------------------------------------------------------------------------
// Phase B — database objects (F2/F4/F6)
// ---------------------------------------------------------------------------

type Track = { userEmails: string[]; walletIds: number[] };

async function phaseB(pool: Pool, track: Track): Promise<void> {
  // --- B1: migration 0008 objects exist --------------------------------------
  const col = await pool.query(
    "select character_maximum_length as len from information_schema.columns where table_name = 'withdrawal_requests' and column_name = 'idempotency_key'",
  );
  check("idempotency_key column exists (varchar(64))", col.rows[0]?.len === 64, `len ${col.rows[0]?.len}`);
  const idx = await pool.query("select indexdef as def from pg_indexes where indexname = 'withdrawal_requests_wallet_idempotency_idx'");
  const idxDef: string = idx.rows[0]?.def ?? "";
  check("partial unique index (wallet_id, idempotency_key) exists", idxDef !== "", idxDef.slice(0, 80));
  check(
    "index is UNIQUE + partial on NOT NULL keys",
    /unique/i.test(idxDef) && /wallet_id/.test(idxDef) && /idempotency_key/.test(idxDef) && /is not null/i.test(idxDef),
  );
  const checkNames = [
    "withdrawal_requests_amount_positive_check",
    "withdrawal_requests_fee_within_amount_check",
    "withdrawal_requests_amount_split_check",
    "withdrawal_requests_method_check",
  ];
  const cons = await pool.query(
    "select conname, convalidated as valid, pg_get_constraintdef(oid) as def from pg_constraint where conname = any($1)",
    [checkNames],
  );
  const byName = new Map<string, { valid: boolean; def: string }>(
    cons.rows.map((r: { conname: string; valid: boolean; def: string }) => [r.conname, { valid: r.valid, def: r.def }]),
  );
  for (const name of checkNames) {
    check(`CHECK constraint ${name} exists`, byName.has(name));
  }
  check(
    "method CHECK whitelists exactly momo_mtn + telecel_cash",
    (byName.get("withdrawal_requests_method_check")?.def ?? "").includes("momo_mtn") &&
      (byName.get("withdrawal_requests_method_check")?.def ?? "").includes("telecel_cash"),
    byName.get("withdrawal_requests_method_check")?.def ?? "missing",
  );
  const unvalidated = checkNames.filter((n) => byName.has(n) && !byName.get(n)!.valid);
  note(
    "constraint validation state",
    unvalidated.length === 0
      ? "all four CHECKs validated (clean database)"
      : `NOT VALID (legacy violators preserved + reported — new writes still enforced): ${unvalidated.join(", ")}`,
  );

  // --- fixtures: two scratch users + wallets -----------------------------------
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const mkUser = async (tag: string, phone: string): Promise<{ userId: number; walletId: number }> => {
    const email = `${PREFIX}b-${stamp}-${tag}@verify.flexidata.internal`;
    const u = await pool.query(
      "insert into users (name, email, phone, password_hash, referral_code) values ('WSaskar B', $1, $2, 'scrypt:x:y', $3) returning id",
      [email, phone, `WSB${stamp.slice(-4)}${tag}`.toUpperCase()],
    );
    const w = await pool.query(
      "insert into wallets (user_id, name, number, balance) values ($1, 'WS B', $2, '1000.00') returning id",
      [u.rows[0].id, phone],
    );
    track.userEmails.push(email);
    track.walletIds.push(w.rows[0].id);
    return { userId: u.rows[0].id, walletId: w.rows[0].id };
  };
  const fx1 = await mkUser("aa", `0249${stamp.slice(-6).padStart(6, "0")}`);
  const fx2 = await mkUser("bb", `0209${stamp.slice(-6).padStart(6, "0")}`);
  check("Phase B fixtures created", fx1.walletId > 0 && fx2.walletId > 0);

  // --- B2: CHECK constraint probes (each isolated in a savepoint) ---------------
  // NOTE: every probe that EXPECTS a failure must sit inside its own savepoint:
  // a failed statement aborts the whole transaction, so without
  // ROLLBACK TO SAVEPOINT every later probe would die with 25P02.
  const client = await pool.connect();
  try {
    await client.query("begin");
    await phaseBProbes(client, fx1, fx2, stamp);
    await client.query("rollback");
  } finally {
    client.release();
  }
  const leftovers = await pool.query("select count(*)::int as n from withdrawal_requests where ref like $1", [`${PREFIX}probe-%`]);
  const idemLeftovers = await pool.query("select count(*)::int as n from withdrawal_requests where ref like $1", [`${PREFIX}idem-%`]);
  check("B2/B3 probes left nothing behind (rolled back)", leftovers.rows[0].n === 0 && idemLeftovers.rows[0].n === 0);

  await phaseBRecon(pool, track, stamp);
}

async function phaseBProbes(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  fx1: { userId: number; walletId: number },
  fx2: { userId: number; walletId: number },
  stamp: string,
): Promise<void> {
  const q = async (text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> =>
    (await client.query(text, values)) as { rows: Array<Record<string, unknown>> };
  let probeSeq = 0;
  const probeInsert = async (
    label: string,
    values: { amount: string; fee: string; net: string; method: string; key?: string | null },
    expect: { ok: true } | { ok: false; code: string; constraint?: string },
  ): Promise<void> => {
    probeSeq += 1;
    const sp = `ws_probe_${probeSeq}`;
    const ref = `${PREFIX}probe-${stamp}-${probeSeq}`;
    await q(`savepoint ${sp}`);
    try {
      await q(
        "insert into withdrawal_requests (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key) " +
          "values ($1, $2, $3, $4, $5, $6, $7, '{\"account\":\"0244123456\"}'::jsonb, 'pending', $8)",
        [ref, fx1.userId, fx1.walletId, values.amount, values.fee, values.net, values.method, values.key ?? null],
      );
      await q(`rollback to savepoint ${sp}`);
      check(label, expect.ok, expect.ok ? "accepted" : "ACCEPTED — constraint missing!");
    } catch (e) {
      await q(`rollback to savepoint ${sp}`);
      const code = (e as { code?: string }).code ?? "?";
      const constraint = (e as { constraint?: string }).constraint ?? "?";
      check(
        label,
        !expect.ok && code === expect.code && (expect.constraint === undefined || constraint === expect.constraint),
        `SQLSTATE ${code} ${constraint}`,
      );
    }
  };
  await probeInsert("F6 probe: amount 0 refused (23514)", { amount: "0", fee: "0", net: "0", method: "momo_mtn" }, { ok: false, code: "23514", constraint: "withdrawal_requests_amount_positive_check" });
  // Negative amounts violate both the positivity and the fee-range CHECKs, and
  // Postgres names only one of them — so this probe asserts the refusal (23514)
  // without pinning which constraint is reported. (The amount-0 probe below it
  // isolates amount_positive deterministically.)
  await probeInsert("F6 probe: negative amount refused (23514)", { amount: "-5.00", fee: "0", net: "-5.00", method: "momo_mtn" }, { ok: false, code: "23514" });
  await probeInsert("F6 probe: fee > amount refused (23514)", { amount: "5.00", fee: "6.00", net: "-1.00", method: "momo_mtn" }, { ok: false, code: "23514", constraint: "withdrawal_requests_fee_within_amount_check" });
  await probeInsert("F6 probe: negative fee refused (23514)", { amount: "5.00", fee: "-1.00", net: "6.00", method: "momo_mtn" }, { ok: false, code: "23514", constraint: "withdrawal_requests_fee_within_amount_check" });
  await probeInsert("F6 probe: amount ≠ fee+net refused (23514)", { amount: "5.00", fee: "0.10", net: "5.00", method: "momo_mtn" }, { ok: false, code: "23514", constraint: "withdrawal_requests_amount_split_check" });
  await probeInsert("F6 probe: split off by a pesewa refused (23514)", { amount: "5.00", fee: "0.00", net: "5.01", method: "momo_mtn" }, { ok: false, code: "23514", constraint: "withdrawal_requests_amount_split_check" });
  await probeInsert("F6 probe: method 'momo' refused (23514)", { amount: "5.00", fee: "0.10", net: "4.90", method: "momo" }, { ok: false, code: "23514", constraint: "withdrawal_requests_method_check" });
  await probeInsert("F6 probe: method 'card' refused (23514)", { amount: "5.00", fee: "0.10", net: "4.90", method: "card" }, { ok: false, code: "23514", constraint: "withdrawal_requests_method_check" });
  await probeInsert("F6 probe: empty method refused (23514)", { amount: "5.00", fee: "0.10", net: "4.90", method: "" }, { ok: false, code: "23514", constraint: "withdrawal_requests_method_check" });
  await probeInsert("F6 probe: wrong-case method refused (23514)", { amount: "5.00", fee: "0.10", net: "4.90", method: "MOMO_MTN" }, { ok: false, code: "23514", constraint: "withdrawal_requests_method_check" });
  await probeInsert("F6 probe: valid row accepted", { amount: "5.00", fee: "0.10", net: "4.90", method: "momo_mtn" }, { ok: true });
  await probeInsert("F6 probe: valid telecel row accepted", { amount: "10.25", fee: "0.21", net: "10.04", method: "telecel_cash" }, { ok: true });
  await probeInsert("F6 probe: valid keyed row accepted", { amount: "5.00", fee: "0.10", net: "4.90", method: "momo_mtn", key: `${PREFIX}key-ok` }, { ok: true });
  // Over-long method: refused either by the CHECK or by varchar(40) — either way it cannot land.
  probeSeq += 1;
  {
    const sp = `ws_probe_${probeSeq}`;
    const ref = `${PREFIX}probe-${stamp}-${probeSeq}`;
    await q(`savepoint ${sp}`);
    try {
      await q(
        "insert into withdrawal_requests (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status) " +
          "values ($1, $2, $3, '5.00', '0.10', '4.90', $4, '{\"account\":\"0244123456\"}'::jsonb, 'pending')",
        [ref, fx1.userId, fx1.walletId, "m".repeat(65)],
      );
      await q(`rollback to savepoint ${sp}`);
      check("F6 probe: 65-char method refused", false, "ACCEPTED!");
    } catch (e) {
      await q(`rollback to savepoint ${sp}`);
      const code = (e as { code?: string }).code ?? "?";
      check("F6 probe: 65-char method refused", code === "23514" || code === "22001", `SQLSTATE ${code}`);
    }
  }

  // --- B3: idempotency index probes ----------------------------------------------
  // Each insert gets its own savepoint: the duplicate-key probe fails ON
  // PURPOSE (23505), and without isolating it the aborted transaction would
  // poison every probe after it with 25P02.
  const idemInsert = async (
    ref: string,
    walletId: number,
    key: string | null,
  ): Promise<{ ok: true } | { ok: false; code: string; constraint: string }> => {
    probeSeq += 1;
    const sp = `ws_idem_${probeSeq}`;
    await q(`savepoint ${sp}`);
    try {
      await q(
        "insert into withdrawal_requests (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key) " +
          "values ($1, $2, $3, '5.00', '0.10', '4.90', 'momo_mtn', '{\"account\":\"0244123456\"}'::jsonb, 'pending', $4)",
        [ref, fx1.userId, walletId, key],
      );
      return { ok: true };
    } catch (e) {
      await q(`rollback to savepoint ${sp}`);
      return { ok: false, code: (e as { code?: string }).code ?? "?", constraint: (e as { constraint?: string }).constraint ?? "?" };
    }
  };
  {
    const r1 = await idemInsert(`${PREFIX}idem-1`, fx1.walletId, `${PREFIX}idem-key`);
    check("F2 probe: first keyed row accepted", r1.ok);
    // Release the first row's savepoint implicitly by continuing — its row is
    // still visible inside this transaction, which is exactly what the
    // duplicate probe below needs to collide with.
    const r2 = await idemInsert(`${PREFIX}idem-2`, fx1.walletId, `${PREFIX}idem-key`);
    check(
      "F2 probe: duplicate (wallet, key) refused (23505)",
      !r2.ok && r2.code === "23505" && r2.constraint === "withdrawal_requests_wallet_idempotency_idx",
      r2.ok ? "ACCEPTED!" : `SQLSTATE ${r2.code} ${r2.constraint}`,
    );
    const r3 = await idemInsert(`${PREFIX}idem-3`, fx1.walletId, `${PREFIX}idem-key-2`);
    check("F2 probe: different key on same wallet accepted", r3.ok);
    const r4 = await idemInsert(`${PREFIX}idem-4`, fx2.walletId, `${PREFIX}idem-key`);
    check("F2 probe: same key on a different wallet accepted (scoped per wallet)", r4.ok);
    const r5 = await idemInsert(`${PREFIX}idem-5`, fx1.walletId, null);
    const r6 = await idemInsert(`${PREFIX}idem-6`, fx1.walletId, null);
    check("F2 probe: multiple NULL-key legacy rows accepted", r5.ok && r6.ok);
    const r7 = await idemInsert(`${PREFIX}idem-7`, fx1.walletId, "k".repeat(64));
    check("F2 probe: 64-char key accepted (boundary)", r7.ok);
  }
}

async function phaseBRecon(pool: Pool, track: Track, stamp: string): Promise<void> {
  // --- B4: reconciliation SQL over withdrawal lifecycles (F4) ----------------------
  const { db } = await import("../src/db/index");
  const { calculatedBalanceSql } = await import("../src/lib/admin/reconciliation");
  const { sql } = await import("drizzle-orm");
  const fullCaps = { chargedAt: true, refundedAt: true, checkoutTable: true };
  const legacyCaps = { chargedAt: false, refundedAt: false, checkoutTable: true };

  const mkLedgerWallet = async (tag: string, phone: string): Promise<number> => {
    const email = `${PREFIX}recon-${stamp}-${tag}@verify.flexidata.internal`;
    const u = await pool.query(
      "insert into users (name, email, phone, password_hash, referral_code) values ('WS Recon', $1, $2, 'scrypt:x:y', $3) returning id",
      [email, phone, `WSR${stamp.slice(-4)}${tag}`.toUpperCase()],
    );
    const w = await pool.query("insert into wallets (user_id, name, number, balance) values ($1, 'WSR', $2, '0.00') returning id", [
      u.rows[0].id,
      phone,
    ]);
    track.userEmails.push(email);
    track.walletIds.push(w.rows[0].id);
    return w.rows[0].id;
  };
  let reconSeq = 0;
  const addLedger = async (
    walletId: number,
    rows: Array<{ type: string; status: string; direction: string; amount: string; charged?: boolean; refunded?: boolean; reversed?: boolean }>,
  ): Promise<void> => {
    for (const r of rows) {
      reconSeq += 1;
      await pool.query(
        "insert into transactions (ref, wallet_id, type, status, direction, title, subtitle, amount, charged_at, refunded_at) " +
          "values ($1, $2, $3, $4, $5, 't', '', $6, $7, $8)",
        [
          `${PREFIX}recon-${stamp}-${reconSeq}`,
          walletId,
          r.type,
          r.reversed ? "reversed" : r.status,
          r.direction,
          r.amount,
          r.charged ? new Date("2026-09-01T10:00:00Z") : null,
          r.refunded ? new Date("2026-09-02T10:00:00Z") : null,
        ],
      );
    }
  };
  const calcOf = async (walletId: number, caps: typeof fullCaps): Promise<string> => {
    const res = (await db.execute(
      sql`select ${calculatedBalanceSql("t", caps)} as calc from transactions "t" where "t"."wallet_id" = ${walletId}`,
    )) as unknown as { rows: Array<{ calc: string }> };
    return String(res.rows[0]?.calc ?? "missing");
  };
  // W1 deposit only → 500
  const w1 = await mkLedgerWallet("w1", `0241${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w1, [{ type: "deposit", status: "successful", direction: "in", amount: "500.00", charged: true }]);
  // W2 deposit + pending withdrawal → 14.50
  const w2 = await mkLedgerWallet("w2", `0242${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w2, [
    { type: "deposit", status: "successful", direction: "in", amount: "20.00", charged: true },
    { type: "withdrawal", status: "pending", direction: "out", amount: "5.50" },
  ]);
  // W3 deposit + two pending withdrawals → 9.00
  const w3 = await mkLedgerWallet("w3", `0243${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w3, [
    { type: "deposit", status: "successful", direction: "in", amount: "20.00", charged: true },
    { type: "withdrawal", status: "pending", direction: "out", amount: "5.00" },
    { type: "withdrawal", status: "pending", direction: "out", amount: "6.00" },
  ]);
  // W4 deposit + rejected withdrawal (failed, no charged_at — exactly what the reject path writes) → 20.00
  const w4 = await mkLedgerWallet("w4", `0244${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w4, [
    { type: "deposit", status: "successful", direction: "in", amount: "20.00", charged: true },
    { type: "withdrawal", status: "failed", direction: "out", amount: "5.00" },
  ]);
  // W5 deposit + approved/processing withdrawal (ledger still pending) → 15.00
  const w5 = await mkLedgerWallet("w5", `0245${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w5, [
    { type: "deposit", status: "successful", direction: "in", amount: "20.00", charged: true },
    { type: "withdrawal", status: "pending", direction: "out", amount: "5.00" },
  ]);
  // W6 simulated future payout completion: withdrawal ledger successful → 15.00
  const w6 = await mkLedgerWallet("w6", `0246${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w6, [
    { type: "deposit", status: "successful", direction: "in", amount: "20.00", charged: true },
    { type: "withdrawal", status: "successful", direction: "out", amount: "5.00" },
  ]);
  // W7 withdrawal + recorded refund (refunded_at) → 20.00
  const w7 = await mkLedgerWallet("w7", `0247${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w7, [
    { type: "deposit", status: "successful", direction: "in", amount: "20.00", charged: true },
    { type: "withdrawal", status: "successful", direction: "out", amount: "5.00", refunded: true },
  ]);
  // W8 multiple reversals: two failed + one reversed withdrawal → 20.00
  const w8 = await mkLedgerWallet("w8", `0248${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w8, [
    { type: "deposit", status: "successful", direction: "in", amount: "20.00", charged: true },
    { type: "withdrawal", status: "failed", direction: "out", amount: "5.00" },
    { type: "withdrawal", status: "failed", direction: "out", amount: "6.00" },
    { type: "withdrawal", status: "successful", direction: "out", amount: "7.00", reversed: true },
  ]);
  // W9 guard: pending data WITHOUT charged_at still excluded; failed data WITH charged_at still included → 500-40=460
  const w9 = await mkLedgerWallet("w9", `0240${stamp.slice(-6).padStart(6, "0")}`);
  await addLedger(w9, [
    { type: "deposit", status: "successful", direction: "in", amount: "500.00", charged: true },
    { type: "data", status: "pending", direction: "out", amount: "15.00" },
    { type: "data", status: "failed", direction: "out", amount: "40.00", charged: true },
  ]);

  const num = (s: string): number => Number(s);
  check("recon SQL: deposit only → 500", num(await calcOf(w1, fullCaps)) === 500, await calcOf(w1, fullCaps));
  check("recon SQL: deposit + pending withdrawal → 14.50", num(await calcOf(w2, fullCaps)) === 14.5, await calcOf(w2, fullCaps));
  check("recon SQL: two pending withdrawals → 9.00", num(await calcOf(w3, fullCaps)) === 9, await calcOf(w3, fullCaps));
  check("recon SQL: rejected withdrawal → 20.00 (zero debit)", num(await calcOf(w4, fullCaps)) === 20, await calcOf(w4, fullCaps));
  check("recon SQL: approved/processing withdrawal → 15.00 (debit)", num(await calcOf(w5, fullCaps)) === 15, await calcOf(w5, fullCaps));
  check("recon SQL: simulated payout completion → 15.00 (debit)", num(await calcOf(w6, fullCaps)) === 15, await calcOf(w6, fullCaps));
  check("recon SQL: withdrawal + refund → 20.00 (zero)", num(await calcOf(w7, fullCaps)) === 20, await calcOf(w7, fullCaps));
  check("recon SQL: multiple reversals → 20.00 (zero)", num(await calcOf(w8, fullCaps)) === 20, await calcOf(w8, fullCaps));
  check("recon SQL: non-withdrawal rules unchanged → 460", num(await calcOf(w9, fullCaps)) === 460, await calcOf(w9, fullCaps));
  check(
    "recon SQL (legacy caps): pending withdrawal still a debit → 14.50",
    num(await calcOf(w2, legacyCaps)) === 14.5,
    await calcOf(w2, legacyCaps),
  );
  check(
    "recon SQL (legacy caps): rejected withdrawal still zero → 20.00",
    num(await calcOf(w4, legacyCaps)) === 20,
    await calcOf(w4, legacyCaps),
  );
}

// ---------------------------------------------------------------------------
// Phase C — end-to-end API behavior
// ---------------------------------------------------------------------------

async function phaseC(
  pool: Pool,
  base: string,
  track: Track,
  payoutsBefore: { ledger: number; requests: number } | null,
): Promise<void> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  // Track-length boundary: everything appended after this point belongs to
  // Phase C (used by C11 to scope the no-fake-payout counts).
  const bFixtureWalletCount = track.walletIds.length;
  const bFixtureEmailCount = track.userEmails.length;
  let phoneSeq = 0;
  const mtnPhone = (): string => {
    phoneSeq += 1;
    const n = (parseInt(stamp.slice(-6), 36) + phoneSeq * 131071) % 8_999_999;
    return `024${(1_000_000 + n).toString()}`;
  };
  const telecelPhone = (): string => {
    phoneSeq += 1;
    const n = (parseInt(stamp.slice(-6), 36) + phoneSeq * 131071) % 8_999_999;
    return `020${(1_000_000 + n).toString()}`;
  };

  const mkAccount = async (
    tag: string,
    phone: string,
  ): Promise<{ jar: Jar; email: string; phone: string; walletId: number }> => {
    const jar = new Jar();
    const email = `${PREFIX}c-${stamp}-${tag}@verify.flexidata.internal`;
    const reg = await jar.req(base, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name: `Ws User ${tag}`, email, phone, password: PASSWORD }),
    });
    if (reg.status !== 200 && reg.status !== 201) {
      bad(`register ${tag}`, `status ${reg.status} ${(await reg.text()).slice(0, 120)}`);
      throw new Error(`register ${tag} failed`);
    }
    const login = await jar.req(base, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier: email, password: PASSWORD }),
    });
    if (login.status !== 200) throw new Error(`login ${tag} failed: ${login.status}`);
    const walletId = Number(
      (await pool.query("select w.id from wallets w join users u on u.id = w.user_id where u.email = $1", [email])).rows[0].id,
    );
    track.userEmails.push(email);
    track.walletIds.push(walletId);
    return { jar, email, phone, walletId };
  };

  const balanceOf = async (walletId: number): Promise<number> =>
    Number((await pool.query("select balance from wallets where id = $1", [walletId])).rows[0].balance);
  const wdCount = async (walletId: number): Promise<number> =>
    Number((await pool.query("select count(*)::int as n from withdrawal_requests where wallet_id = $1", [walletId])).rows[0].n);
  const txCount = async (walletId: number): Promise<number> =>
    Number((await pool.query("select count(*)::int as n from transactions where wallet_id = $1", [walletId])).rows[0].n);
  const snapshot = async (walletId: number) => ({ balance: await balanceOf(walletId), wd: await wdCount(walletId), tx: await txCount(walletId) });

  // Accounts: A (MTN), B (Telecel), D/E/F/G flow users, V victim.
  const adminJar = new Jar();
  await adminJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ws Admin", email: ADMIN_EMAIL, phone: telecelPhone(), password: PASSWORD }),
  });
  await adminJar.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN_EMAIL, password: PASSWORD }) });
  await pool.query("update users set is_admin = true where email = $1", [ADMIN_EMAIL]);
  track.userEmails.push(ADMIN_EMAIL);
  const adminWalletRow = await pool.query("select w.id from wallets w join users u on u.id = w.user_id where u.email = $1", [ADMIN_EMAIL]);
  if (adminWalletRow.rows[0]) track.walletIds.push(Number(adminWalletRow.rows[0].id));
  const adminMe = await adminJar.req(base, "/api/admin/me");
  check("admin gate admits the suite admin", adminMe.status === 200, `status ${adminMe.status}`);

  const A = await mkAccount("a", mtnPhone());
  const B = await mkAccount("b", telecelPhone());
  const V = await mkAccount("victim", mtnPhone());
  check("Phase C accounts registered", true, `A=${A.phone} B=${B.phone}`);

  const fund = async (jar: Jar, walletId: number, amount: unknown, extra?: Record<string, unknown>): Promise<Response> => {
    const res = await jar.req(base, "/api/wallet/fund", {
      method: "POST",
      body: JSON.stringify({ method: "momo_mtn", amount, ...(extra ?? {}) }),
    });
    for (let i = 0; i < 40; i++) {
      const body = (await res.clone().json().catch(() => ({}))) as { ok?: boolean; status?: string };
      if (body.status === "successful") break;
      await new Promise((r) => setTimeout(r, 250));
      if (i === 0) break; // mock settles synchronously; one read is enough
    }
    return res;
  };
  // Provider gate: Phase C needs instant (mock) settlement.
  const probeFund = await fund(A.jar, A.walletId, 100);
  const probeBody = (await probeFund.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string };
  check("mock funding provider settles instantly (Phase C prerequisite)", probeFund.status === 200 && probeBody.status === "successful", probeBody.error ?? probeBody.status ?? `status ${probeFund.status}`);
  if (!(probeFund.status === 200 && probeBody.status === "successful")) {
    bad("Phase C aborted", "point BASE_URL at a mock-provider server (PAYMENTS_PROVIDER=mock)");
    return;
  }
  check("A funded to GH₵100.00", (await balanceOf(A.walletId)) === 100);
  await fund(B.jar, B.walletId, 50);
  check("B funded to GH₵50.00", (await balanceOf(B.walletId)) === 50);
  await fund(V.jar, V.walletId, 30);
  check("V funded to GH₵30.00", (await balanceOf(V.walletId)) === 30);

  type WdResp = { ok?: boolean; ref?: string; newBalance?: number; fee?: number; netAmount?: number; duplicate?: boolean; error?: string; code?: string };
  const withdraw = async (jar: Jar, body: unknown): Promise<{ status: number; body: WdResp; headers: Headers }> => {
    const res = await jar.req(base, "/api/wallet/withdraw", { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as WdResp, headers: res.headers };
  };

  // --- C1: authentication + ownership (F8) -------------------------------------
  const anon = new Jar();
  const c1snap = await snapshot(A.walletId);
  const unauth = await withdraw(anon, { amount: "5.50", method: "momo_mtn", dest: A.phone });
  check("unauthenticated withdrawal → 401", unauth.status === 401, `status ${unauth.status}`);
  const unauthWallet = await anon.req(base, "/api/wallet");
  check("unauthenticated wallet read → 401", unauthWallet.status === 401);
  const smuggledUser = await withdraw(A.jar, { amount: "5.00", method: "momo_mtn", dest: A.phone, userId: 1 });
  check("smuggled userId → 400", smuggledUser.status === 400, smuggledUser.body.error ?? "");
  const smuggledWallet = await withdraw(A.jar, { amount: "5.00", method: "momo_mtn", dest: A.phone, walletId: V.walletId });
  check("smuggled walletId → 400 (cross-user attack refused)", smuggledWallet.status === 400);
  check("victim balance untouched by walletId smuggling", (await balanceOf(V.walletId)) === 30);
  const smuggledStatus = await withdraw(A.jar, { amount: "5.00", method: "momo_mtn", dest: A.phone, status: "successful" });
  check("smuggled status → 400", smuggledStatus.status === 400);
  const smuggledBalance = await withdraw(A.jar, { amount: "5.00", method: "momo_mtn", dest: A.phone, balance: 999999 });
  check("smuggled balance → 400 (server is authoritative)", smuggledBalance.status === 400);
  const c1after = await snapshot(A.walletId);
  check("C1 attacks caused zero mutation", JSON.stringify(c1snap) === JSON.stringify(c1after), JSON.stringify(c1after));

  // --- C2: valid withdrawal flows (F1) -------------------------------------------
  const kA1 = `${PREFIX}c2-a1-${stamp}`;
  const wA1 = await withdraw(A.jar, { amount: "5.50", method: "momo_mtn", dest: A.phone, idempotencyKey: kA1 });
  check("valid MTN withdrawal accepted", wA1.status === 200 && wA1.body.ok && !!wA1.body.ref && wA1.body.duplicate === false, wA1.body.ref ?? wA1.body.error);
  check("deduction is exactly GH₵5.50 (100 → 94.50)", (await balanceOf(A.walletId)) === 94.5 && wA1.body.newBalance === 94.5);
  check("response fee/net exact (0.11 / 5.39)", wA1.body.fee === 0.11 && wA1.body.netAmount === 5.39, `fee ${wA1.body.fee} net ${wA1.body.netAmount}`);
  const rowA1 = (await pool.query("select amount, fee, net_amount, status, destination_method, destination_details, idempotency_key from withdrawal_requests where ref = $1", [wA1.body.ref])).rows[0];
  check(
    "stored request exact (5.50/0.11/5.39, pending, momo_mtn)",
    rowA1.amount === "5.50" && rowA1.fee === "0.11" && rowA1.net_amount === "5.39" && rowA1.status === "pending" && rowA1.destination_method === "momo_mtn",
    JSON.stringify(rowA1),
  );
  check(
    "destination normalized (account + network MTN)",
    rowA1.destination_details?.account === A.phone && rowA1.destination_details?.network === "MTN" && rowA1.idempotency_key === kA1,
    JSON.stringify(rowA1.destination_details),
  );
  const ledA1 = (await pool.query("select type, status, direction, title, subtitle, amount, provider_reference, provider from transactions where ref = $1", [wA1.body.ref])).rows;
  check("exactly one ledger row", ledA1.length === 1, `${ledA1.length}`);
  check(
    "ledger row is pending withdrawal debit with trusted subtitle",
    ledA1[0]?.type === "withdrawal" && ledA1[0]?.status === "pending" && ledA1[0]?.direction === "out" && ledA1[0]?.amount === "5.50" && ledA1[0]?.subtitle === `MTN MoMo • ${A.phone.slice(0, 3)} ${A.phone.slice(3, 6)} ${A.phone.slice(6)}`,
    ledA1[0]?.subtitle,
  );
  check("no payout provider touched (provider columns NULL)", ledA1[0]?.provider === null && ledA1[0]?.provider_reference === null);
  check("withdraw response is no-store", (wA1.headers.get("cache-control") ?? "").includes("no-store"), wA1.headers.get("cache-control"));

  const kB1 = `${PREFIX}c2-b1-${stamp}`;
  const wB1 = await withdraw(B.jar, { amount: "10.25", method: "telecel_cash", dest: B.phone, idempotencyKey: kB1 });
  check("valid Telecel withdrawal accepted", wB1.status === 200 && wB1.body.ok === true, wB1.body.ref ?? wB1.body.error);
  check("Telecel deduction exact (50 → 39.75)", (await balanceOf(B.walletId)) === 39.75);
  check("Telecel fee/net exact (0.21 / 10.04)", wB1.body.fee === 0.21 && wB1.body.netAmount === 10.04, `fee ${wB1.body.fee} net ${wB1.body.netAmount}`);
  const ledB1 = (await pool.query("select subtitle, amount from transactions where ref = $1", [wB1.body.ref])).rows[0];
  check("Telecel subtitle trusted", ledB1?.subtitle === `Telecel Cash • ${B.phone.slice(0, 3)} ${B.phone.slice(3, 6)} ${B.phone.slice(6)}`, ledB1?.subtitle);

  const wA9 = await withdraw(A.jar, { amount: 5, method: "momo_mtn", dest: A.phone.slice(1), idempotencyKey: `${PREFIX}c2-a9-${stamp}` });
  const rowA9 = wA9.body.ref ? (await pool.query("select destination_details from withdrawal_requests where ref = $1", [wA9.body.ref])).rows[0] : null;
  check("9-digit dest accepted + stored normalized", wA9.status === 200 && rowA9?.destination_details?.account === A.phone, rowA9?.destination_details?.account);
  const wAIntl = await withdraw(A.jar, { amount: 5, method: "momo_mtn", dest: `+233${A.phone.slice(1)}`, idempotencyKey: `${PREFIX}c2-ai-${stamp}` });
  check("+233 dest accepted", wAIntl.status === 200 && wAIntl.body.ok === true, wAIntl.body.error ?? "");
  const wASpaced = await withdraw(A.jar, { amount: 5, method: "momo_mtn", dest: `${A.phone.slice(0, 3)} ${A.phone.slice(3, 6)} ${A.phone.slice(6)}`, idempotencyKey: `${PREFIX}c2-as-${stamp}` });
  check("spaced dest accepted", wASpaced.status === 200 && wASpaced.body.ok === true, wASpaced.body.error ?? "");
  const walletApi = await A.jar.req(base, "/api/wallet");
  const walletApiBody = (await walletApi.json().catch(() => ({}))) as { ok?: boolean; wallet?: { balance?: number } };
  check(
    "GET /api/wallet reflects deductions + no-store",
    walletApiBody.wallet?.balance === 79.5 && (walletApi.headers.get("cache-control") ?? "").includes("no-store"),
    `balance ${walletApiBody.wallet?.balance}`,
  );

  // --- C3: invalid matrix + zero mutation (F1/F3/F8) -------------------------------
  const c3snap = await snapshot(A.walletId);
  const invalidCases: Array<[unknown, string]> = [
    [{ amount: "5.50", method: "momo", dest: A.phone }, "legacy 'momo'"],
    [{ amount: "5.50", method: "card", dest: A.phone }, "'card'"],
    [{ amount: "5.50", method: "MTN", dest: A.phone }, "'MTN'"],
    [{ amount: "5.50", method: "momo_mtn ", dest: A.phone }, "padded method"],
    [{ amount: "5.50", method: "", dest: A.phone }, "empty method"],
    [{ amount: "5.50", method: null, dest: A.phone }, "null method"],
    [{ amount: "5.50", method: 123, dest: A.phone }, "numeric method"],
    [{ amount: "5.50", dest: A.phone }, "missing method"],
    [{ amount: "5.50", method: "momo_mtn", dest: null }, "null dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "" }, "empty dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "abc" }, "garbage dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "02441" }, "short dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "02441234567" }, "11-digit dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0231234567" }, "bad-prefix dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: 244123456 }, "numeric dest"],
    [{ amount: "5.50", method: "momo_mtn" }, "missing dest"],
    [{ amount: "5.50", method: "momo_mtn", dest: B.phone }, "MTN method + Telecel number"],
    [{ amount: "5.50", method: "telecel_cash", dest: A.phone }, "Telecel method + MTN number"],
    [{ amount: "5.50", method: "momo_mtn", dest: "0261234567" }, "MTN method + AirtelTigo number"],
    [{ amount: 0, method: "momo_mtn", dest: A.phone }, "zero amount"],
    [{ amount: "0", method: "momo_mtn", dest: A.phone }, "zero string"],
    [{ amount: -5, method: "momo_mtn", dest: A.phone }, "negative amount"],
    [{ amount: "5.555", method: "momo_mtn", dest: A.phone }, "excess precision"],
    [{ amount: "abc", method: "momo_mtn", dest: A.phone }, "garbage amount"],
    [{ amount: "4.99", method: "momo_mtn", dest: A.phone }, "below GH₵5 minimum"],
    [{ method: "momo_mtn", dest: A.phone }, "missing amount"],
    [{ amount: null, method: "momo_mtn", dest: A.phone }, "null amount"],
  ];
  for (const [body, why] of invalidCases) {
    const r = await withdraw(A.jar, body);
    check(`invalid withdrawal refused: ${why}`, r.status === 400 && r.body.ok !== true, `status ${r.status} ${r.body.error ?? ""}`);
  }
  const c3after = await snapshot(A.walletId);
  check("C3 invalid matrix caused zero mutation", JSON.stringify(c3snap) === JSON.stringify(c3after), JSON.stringify(c3after));
  check("C3 victim untouched", (await balanceOf(V.walletId)) === 30);

  // --- C4: decimal pipeline end to end (F3/W1) ----------------------------------------
  const C = await mkAccount("c", mtnPhone());
  await fund(C.jar, C.walletId, 200);
  const wC1 = await withdraw(C.jar, { amount: "5.50", method: "momo_mtn", dest: C.phone, idempotencyKey: `${PREFIX}c4-1-${stamp}` });
  check("5.50 deducts exactly 5.50 (200 → 194.50)", (await balanceOf(C.walletId)) === 194.5 && wC1.body.newBalance === 194.5);
  const rowC1 = (await pool.query("select amount, fee, net_amount from withdrawal_requests where ref = $1", [wC1.body.ref])).rows[0];
  check("5.50 stored exactly (5.50/0.11/5.39)", rowC1.amount === "5.50" && rowC1.fee === "0.11" && rowC1.net_amount === "5.39", JSON.stringify(rowC1));
  const ledC1 = (await pool.query("select amount from transactions where ref = $1", [wC1.body.ref])).rows[0];
  check("5.50 ledger exact", ledC1?.amount === "5.50");
  const wC2 = await withdraw(C.jar, { amount: "10.25", method: "momo_mtn", dest: C.phone, idempotencyKey: `${PREFIX}c4-2-${stamp}` });
  check("10.25 deducts exactly (→ 184.25)", (await balanceOf(C.walletId)) === 184.25, `balance ${await balanceOf(C.walletId)}`);
  const rowC2 = (await pool.query("select fee, net_amount from withdrawal_requests where ref = $1", [wC2.body.ref])).rows[0];
  check("10.25 fee/net exact (0.21/10.04)", rowC2?.fee === "0.21" && rowC2?.net_amount === "10.04", JSON.stringify(rowC2));
  const wC3 = await withdraw(C.jar, { amount: "100.99", method: "momo_mtn", dest: C.phone, idempotencyKey: `${PREFIX}c4-3-${stamp}` });
  check("100.99 deducts exactly (→ 83.26)", (await balanceOf(C.walletId)) === 83.26, `balance ${await balanceOf(C.walletId)}`);
  const rowC3 = (await pool.query("select fee, net_amount from withdrawal_requests where ref = $1", [wC3.body.ref])).rows[0];
  check("100.99 fee/net exact (2.02/98.97)", rowC3?.fee === "2.02" && rowC3?.net_amount === "98.97", JSON.stringify(rowC3));
  const big550 = await pool.query("select count(*)::int as n from withdrawal_requests where amount = 550 and wallet_id = $1", [C.walletId]);
  check("GH₵550 phantom NEVER appears", big550.rows[0].n === 0);
  // Deposit decimals (W1).
  await fund(C.jar, C.walletId, "10.25");
  check("deposit 10.25 credits exactly (→ 93.51)", (await balanceOf(C.walletId)) === 93.51, `balance ${await balanceOf(C.walletId)}`);
  const depRow = (await pool.query("select amount, amount_subunits from deposit_requests where wallet_id = $1 order by id desc limit 1", [C.walletId])).rows[0];
  check("deposit stored exactly (10.25 / 1025 subunits)", depRow?.amount === "10.25" && Number(depRow?.amount_subunits) === 1025, JSON.stringify(depRow));
  await fund(C.jar, C.walletId, "5.50");
  check("deposit 5.50 credits exactly (→ 99.01)", (await balanceOf(C.walletId)) === 99.01, `balance ${await balanceOf(C.walletId)}`);
  const badDep = await fund(C.jar, C.walletId, "10.255");
  const badDepBody = (await badDep.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  check("deposit 10.255 refused (no rounding)", badDep.status === 400 && badDepBody.ok !== true, `status ${badDep.status}`);
  check("refused deposit moved nothing", (await balanceOf(C.walletId)) === 99.01);
  // Transfer decimals (W1).
  const tr1 = await A.jar.req(base, "/api/wallet/transfer", { method: "POST", body: JSON.stringify({ account: B.phone, amount: "10.25" }) });
  check("transfer 10.25 accepted", tr1.status === 200, `status ${tr1.status}`);
  check("transfer 10.25 exact on both sides", (await balanceOf(A.walletId)) === 69.25 && (await balanceOf(B.walletId)) === 50, `A ${await balanceOf(A.walletId)} B ${await balanceOf(B.walletId)}`);
  const trRows = await pool.query("select amount from transactions where wallet_id = $1 and type = 'transfer' order by id desc limit 1", [A.walletId]);
  check("transfer ledger exact (10.25)", trRows.rows[0]?.amount === "10.25");
  const tr2 = await A.jar.req(base, "/api/wallet/transfer", { method: "POST", body: JSON.stringify({ account: B.phone, amount: "5.50" }) });
  check("transfer 5.50 accepted", tr2.status === 200);
  check("transfer 5.50 exact (A → 63.75)", (await balanceOf(A.walletId)) === 63.75);
  const trBad = await A.jar.req(base, "/api/wallet/transfer", { method: "POST", body: JSON.stringify({ account: B.phone, amount: "5.555" }) });
  check("transfer 5.555 refused (no rounding)", trBad.status === 400, `status ${trBad.status}`);
  const trBadAcct = await A.jar.req(base, "/api/wallet/transfer", { method: "POST", body: JSON.stringify({ account: "0231234567", amount: "5.00" }) });
  check("transfer to invalid number fails closed", trBadAcct.status === 400, `status ${trBadAcct.status}`);
  const trGhost = await A.jar.req(base, "/api/wallet/transfer", { method: "POST", body: JSON.stringify({ account: "0249990001", amount: "5.00" }) });
  check("transfer to unregistered number → 404", trGhost.status === 404, `status ${trGhost.status}`);

  // --- C5: idempotency end to end (F2) ---------------------------------------------------
  const D = await mkAccount("d", mtnPhone());
  await fund(D.jar, D.walletId, 100);
  const kD1 = `${PREFIX}c5-d1-${stamp}`;
  const d1a = await withdraw(D.jar, { amount: "7.50", method: "momo_mtn", dest: D.phone, idempotencyKey: kD1 });
  const d1b = await withdraw(D.jar, { amount: "7.50", method: "momo_mtn", dest: D.phone, idempotencyKey: kD1 });
  check("same key twice → same ref (replay)", d1a.body.ref !== undefined && d1a.body.ref === d1b.body.ref, `${d1a.body.ref} / ${d1b.body.ref}`);
  check("replay flags (false then true)", d1a.body.duplicate === false && d1b.body.duplicate === true);
  check("exactly one deduction after replay", (await balanceOf(D.walletId)) === 92.5);
  const dRows = await pool.query("select count(*)::int as n from withdrawal_requests where wallet_id = $1 and idempotency_key = $2", [D.walletId, kD1]);
  check("exactly one withdrawal row for the key", dRows.rows[0].n === 1);
  const dLed = await pool.query("select count(*)::int as n from transactions where wallet_id = $1 and ref = $2", [D.walletId, d1a.body.ref]);
  check("exactly one ledger row for the ref", dLed.rows[0].n === 1);
  // 5x sequential.
  for (let i = 0; i < 4; i++) {
    await withdraw(D.jar, { amount: "7.50", method: "momo_mtn", dest: D.phone, idempotencyKey: kD1 });
  }
  const dRows5 = await pool.query("select count(*)::int as n from withdrawal_requests where wallet_id = $1 and idempotency_key = $2", [D.walletId, kD1]);
  check("same key 5x → still one row, one deduction", dRows5.rows[0].n === 1 && (await balanceOf(D.walletId)) === 92.5);
  // 6x concurrent.
  const kD2 = `${PREFIX}c5-d2-${stamp}`;
  const conc = await Promise.all(
    Array.from({ length: 6 }, () => withdraw(D.jar, { amount: "6.00", method: "momo_mtn", dest: D.phone, idempotencyKey: kD2 })),
  );
  const concRefs = new Set(conc.map((r) => r.body.ref));
  check("6 concurrent duplicates → all 200", conc.every((r) => r.status === 200), conc.map((r) => r.status).join(","));
  check("6 concurrent duplicates → one shared ref", concRefs.size === 1, [...concRefs].join(","));
  check("6 concurrent duplicates → one deduction (→ 86.50)", (await balanceOf(D.walletId)) === 86.5);
  const d2Rows = await pool.query("select count(*)::int as n from withdrawal_requests where wallet_id = $1 and idempotency_key = $2", [D.walletId, kD2]);
  check("6 concurrent duplicates → one withdrawal row", d2Rows.rows[0].n === 1);
  // Replay while pending + after lifecycle moves.
  const dPending = await withdraw(D.jar, { amount: "7.50", method: "momo_mtn", dest: D.phone, idempotencyKey: kD1 });
  check("replay while pending reuses original", dPending.status === 200 && dPending.body.ref === d1a.body.ref && dPending.body.duplicate === true);
  const d1Id = Number((await pool.query("select id from withdrawal_requests where ref = $1", [d1a.body.ref])).rows[0].id);
  const dApprove = await adminJar.req(base, `/api/admin/withdrawals/${d1Id}/action`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
  check("approve for replay-after-approval", dApprove.status === 200, `status ${dApprove.status}`);
  const dAfterApprove = await withdraw(D.jar, { amount: "7.50", method: "momo_mtn", dest: D.phone, idempotencyKey: kD1 });
  check("replay after approved/processing reuses original", dAfterApprove.status === 200 && dAfterApprove.body.ref === d1a.body.ref);
  check("replay after approval deducted nothing new", (await balanceOf(D.walletId)) === 86.5);
  const kD3 = `${PREFIX}c5-d3-${stamp}`;
  const d3 = await withdraw(D.jar, { amount: "5.00", method: "momo_mtn", dest: D.phone, idempotencyKey: kD3 });
  const d3Id = Number((await pool.query("select id from withdrawal_requests where ref = $1", [d3.body.ref])).rows[0].id);
  const dReject = await adminJar.req(base, `/api/admin/withdrawals/${d3Id}/action`, { method: "POST", body: JSON.stringify({ action: "reject", reason: "idempotency probe" }) });
  check("reject for replay-after-reject", dReject.status === 200, `status ${dReject.status}`);
  const dAfterReject = await withdraw(D.jar, { amount: "5.00", method: "momo_mtn", dest: D.phone, idempotencyKey: kD3 });
  check("replay after rejected reuses original", dAfterReject.status === 200 && dAfterReject.body.ref === d3.body.ref && dAfterReject.body.duplicate === true);
  const d3Rows = await pool.query("select count(*)::int as n from withdrawal_requests where wallet_id = $1 and idempotency_key = $2", [D.walletId, kD3]);
  check("replay after rejected: still one row, refund intact", d3Rows.rows[0].n === 1 && (await balanceOf(D.walletId)) === 86.5);
  // Distinct keys are distinct withdrawals (no over-dedup).
  await withdraw(D.jar, { amount: "5.00", method: "momo_mtn", dest: D.phone, idempotencyKey: `${PREFIX}c5-k4-${stamp}` });
  await withdraw(D.jar, { amount: "5.00", method: "momo_mtn", dest: D.phone, idempotencyKey: `${PREFIX}c5-k5-${stamp}` });
  check("different keys → different withdrawals (→ 76.50)", (await balanceOf(D.walletId)) === 76.5);
  // Legacy clients without keys are never falsely deduplicated.
  await withdraw(D.jar, { amount: "5.00", method: "momo_mtn", dest: D.phone });
  await withdraw(D.jar, { amount: "5.00", method: "momo_mtn", dest: D.phone });
  check("keyless legacy requests stay unique (→ 66.50)", (await balanceOf(D.walletId)) === 66.5);
  // Malformed key → 400, zero mutation.
  const dSnap = await snapshot(D.walletId);
  const dBadKey = await withdraw(D.jar, { amount: "5.00", method: "momo_mtn", dest: D.phone, idempotencyKey: "bad key!" });
  check("malformed idempotency key → 400", dBadKey.status === 400);
  check("malformed key caused zero mutation", JSON.stringify(dSnap) === JSON.stringify(await snapshot(D.walletId)));

  // --- C6: stale balances + concurrency (F7) -----------------------------------------------
  const E = await mkAccount("e", mtnPhone());
  await fund(E.jar, E.walletId, 20);
  const E2 = new Jar(); // second session / device, same user
  const eLogin = await E2.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: E.email, password: PASSWORD }) });
  check("second session signs in as the same user", eLogin.status === 200);
  // Concurrent overdraft attempt: 15 + 15 on 20 → exactly one wins.
  const race = await Promise.all([
    withdraw(E.jar, { amount: "15.00", method: "momo_mtn", dest: E.phone, idempotencyKey: `${PREFIX}c6-r1-${stamp}` }),
    withdraw(E2, { amount: "15.00", method: "momo_mtn", dest: E.phone, idempotencyKey: `${PREFIX}c6-r2-${stamp}` }),
  ]);
  const raceStatuses = race.map((r) => r.status).sort();
  check("concurrent overdraft: exactly one 200 + one 400", JSON.stringify(raceStatuses) === "[200,400]", raceStatuses.join(","));
  check("concurrent overdraft leaves exactly GH₵5.00", (await balanceOf(E.walletId)) === 5);
  // Stale client: session 2 still "thinks" 20 — the server decides from its own row.
  const staleTry = await withdraw(E2, { amount: "18.00", method: "momo_mtn", dest: E.phone, idempotencyKey: `${PREFIX}c6-stale-${stamp}` });
  check("stale session cannot overdraw (server authoritative)", staleTry.status === 400 && (await balanceOf(E.walletId)) === 5);
  const eApi = await E.jar.req(base, "/api/wallet");
  const eApiBody = (await eApi.json().catch(() => ({}))) as { wallet?: { balance?: number } };
  check("success + refresh converges to authoritative 5.00", eApiBody.wallet?.balance === 5);
  // Reject + refresh converges too.
  const eWdRef = race.find((r) => r.status === 200)?.body.ref;
  const eWdId = Number((await pool.query("select id from withdrawal_requests where ref = $1", [eWdRef])).rows[0].id);
  const eReject = await adminJar.req(base, `/api/admin/withdrawals/${eWdId}/action`, { method: "POST", body: JSON.stringify({ action: "reject", reason: "stale probe" }) });
  check("reject for refresh probe", eReject.status === 200);
  const eApi2 = await E2.req(base, "/api/wallet");
  const eApiBody2 = (await eApi2.json().catch(() => ({}))) as { wallet?: { balance?: number } };
  check("reject + refresh converges to restored 20.00", eApiBody2.wallet?.balance === 20, `balance ${eApiBody2.wallet?.balance}`);
  check("freshness signal is no-store", (eApi2.headers.get("cache-control") ?? "").includes("no-store"));

  // --- C7: approval semantics (F5) -------------------------------------------------------------
  const F = await mkAccount("f", mtnPhone());
  await fund(F.jar, F.walletId, 50);
  const wF1 = await withdraw(F.jar, { amount: "10.00", method: "momo_mtn", dest: F.phone, idempotencyKey: `${PREFIX}c7-1-${stamp}` });
  const f1Id = Number((await pool.query("select id from withdrawal_requests where ref = $1", [wF1.body.ref])).rows[0].id);
  const fApprove = await adminJar.req(base, `/api/admin/withdrawals/${f1Id}/action`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
  const fApproveBody = (await fApprove.json().catch(() => ({}))) as { ok?: boolean; status?: string };
  check("approve → 200 {processing}", fApprove.status === 200 && fApproveBody.status === "processing", JSON.stringify(fApproveBody));
  const fState = (await pool.query("select status from withdrawal_requests where id = $1", [f1Id])).rows[0];
  const fLedger = (await pool.query("select status, provider_reference, provider from transactions where ref = $1", [wF1.body.ref])).rows[0];
  check("approval moves request to processing", fState?.status === "processing");
  check("approval does NOT mark ledger successful (stays pending)", fLedger?.status === "pending", `ledger ${fLedger?.status}`);
  check("approve moves no money (still 40.00)", (await balanceOf(F.walletId)) === 40);
  check("approve attaches no provider", fLedger?.provider === null && fLedger?.provider_reference === null);
  const fAudit = await pool.query("select count(*)::int as n from admin_audit_logs where target_ref = $1 and action = 'approve_withdrawal'", [wF1.body.ref]);
  check("exactly one approve_withdrawal audit row", fAudit.rows[0].n === 1);
  const fReApprove = await adminJar.req(base, `/api/admin/withdrawals/${f1Id}/action`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
  check("re-approval → 409", fReApprove.status === 409, `status ${fReApprove.status}`);
  const fRejectAfter = await adminJar.req(base, `/api/admin/withdrawals/${f1Id}/action`, { method: "POST", body: JSON.stringify({ action: "reject", reason: "too late" }) });
  check("reject-after-approval → 409, no refund", fRejectAfter.status === 409 && (await balanceOf(F.walletId)) === 40);
  const fSmuggle = await adminJar.req(base, `/api/admin/withdrawals/${f1Id}/action`, { method: "POST", body: JSON.stringify({ action: "approve", status: "successful" }) });
  check("smuggled status on admin API → 400", fSmuggle.status === 400);
  const fComplete = await adminJar.req(base, `/api/admin/withdrawals/${f1Id}/action`, { method: "POST", body: JSON.stringify({ action: "complete" }) });
  check("invalid action 'complete' → 400", fComplete.status === 400);
  const fSuccessful = await adminJar.req(base, `/api/admin/withdrawals/${f1Id}/action`, { method: "POST", body: JSON.stringify({ action: "successful" }) });
  check("invalid action 'successful' → 400 (completion inexpressible)", fSuccessful.status === 400);
  const fNoAction = await adminJar.req(base, `/api/admin/withdrawals/${f1Id}/action`, { method: "POST", body: JSON.stringify({}) });
  check("missing action → 400", fNoAction.status === 400);
  const fNoId = await adminJar.req(base, "/api/admin/withdrawals/99999999/action", { method: "POST", body: JSON.stringify({ action: "approve" }) });
  check("unknown id → 404", fNoId.status === 404);
  const fJunkId = await adminJar.req(base, "/api/admin/withdrawals/nope/action", { method: "POST", body: JSON.stringify({ action: "approve" }) });
  check("non-numeric id → 400", fJunkId.status === 400);
  const wF2 = await withdraw(F.jar, { amount: "5.00", method: "momo_mtn", dest: F.phone, idempotencyKey: `${PREFIX}c7-2-${stamp}` });
  const f2Id = Number((await pool.query("select id from withdrawal_requests where ref = $1", [wF2.body.ref])).rows[0].id);
  const fNoReason = await adminJar.req(base, `/api/admin/withdrawals/${f2Id}/action`, { method: "POST", body: JSON.stringify({ action: "reject", reason: "" }) });
  check("reject without reason → 400", fNoReason.status === 400);
  const fReject2 = await adminJar.req(base, `/api/admin/withdrawals/${f2Id}/action`, { method: "POST", body: JSON.stringify({ action: "reject", reason: "F5 probe refund" }) });
  check("second withdrawal rejected (refund path)", fReject2.status === 200 && (await balanceOf(F.walletId)) === 40);
  // (The no-fake-payout counts live in C11 at the end of Phase C, where they can
  // cover every suite wallet including the ones created by C9/C10.)

  // --- C8: reconciliation API (F4) ---------------------------------------------------------------
  const reconA = await adminJar.req(base, `/api/admin/reconciliation?walletId=${A.walletId}`);
  const reconABody = (await reconA.json().catch(() => ({}))) as { ok?: boolean; rows?: Array<{ walletId?: number; status?: string; difference?: number; storedBalance?: number; calculatedBalance?: number }>; rule?: { id?: string } };
  const rowA = reconABody.rows?.find((r) => r.walletId === A.walletId);
  check("reconciliation API answers for A", reconA.status === 200 && reconABody.ok === true, `status ${reconA.status}`);
  check(
    "A reconciles MATCHED with pending withdrawals as debits",
    rowA?.status === "matched" && rowA?.difference === 0 && rowA?.storedBalance === 63.75 && rowA?.calculatedBalance === 63.75,
    JSON.stringify(rowA),
  );
  const reconF = await adminJar.req(base, `/api/admin/reconciliation?walletId=${F.walletId}`);
  const reconFBody = (await reconF.json().catch(() => ({}))) as { rows?: Array<{ walletId?: number; status?: string; difference?: number }> };
  const rowF = reconFBody.rows?.find((r) => r.walletId === F.walletId);
  check(
    "F reconciles MATCHED (processing debit + rejected zero)",
    rowF?.status === "matched" && rowF?.difference === 0,
    JSON.stringify(rowF),
  );
  const reconD = await adminJar.req(base, `/api/admin/reconciliation?walletId=${D.walletId}`);
  const reconDBody = (await reconD.json().catch(() => ({}))) as { rows?: Array<{ walletId?: number; status?: string; difference?: number }> };
  const rowD = reconDBody.rows?.find((r) => r.walletId === D.walletId);
  check("D reconciles MATCHED across mixed lifecycle", rowD?.status === "matched" && rowD?.difference === 0, JSON.stringify(rowD));
  check("reconciliation rule is the exact ledger rule", reconABody.rule?.id === "ledger-flags", reconABody.rule?.id);
  const reconNonAdmin = await A.jar.req(base, `/api/admin/reconciliation?walletId=${A.walletId}`);
  check("reconciliation refuses non-admin (404)", reconNonAdmin.status === 404, `status ${reconNonAdmin.status}`);
  const reconAnon = await anon.req(base, `/api/admin/reconciliation?walletId=${A.walletId}`);
  check("reconciliation refuses anonymous (404)", reconAnon.status === 404);
  const reconMismatch = await adminJar.req(base, "/api/admin/reconciliation?onlyMismatches=1");
  const reconMismatchBody = (await reconMismatch.json().catch(() => ({}))) as { ok?: boolean; total?: number; mismatches?: number };
  check(
    "onlyMismatches filter works",
    reconMismatch.status === 200 && reconMismatchBody.ok === true && typeof reconMismatchBody.mismatches === "number",
    `mismatches ${reconMismatchBody.mismatches}`,
  );
  const reconSearch = await adminJar.req(base, `/api/admin/reconciliation?search=${encodeURIComponent(A.phone)}`);
  const reconSearchBody = (await reconSearch.json().catch(() => ({}))) as { rows?: Array<{ walletId?: number }> };
  check("reconciliation search narrows to A", reconSearchBody.rows?.some((r) => r.walletId === A.walletId) === true);

  // --- C9: malformed API matrix (F8) ------------------------------------------------------------------
  const M = await mkAccount("m", mtnPhone());
  await fund(M.jar, M.walletId, 50);
  const c9snap = await snapshot(M.walletId);
  const rawBodies: Array<[string, string, string]> = [
    ["{bad json", "application/json", "invalid JSON"],
    ["", "application/json", "empty body"],
    ["null", "application/json", "JSON null"],
    ["[]", "application/json", "JSON array"],
    ["[1,2,3]", "application/json", "JSON array values"],
    ["5", "application/json", "JSON number"],
    ['"hello"', "application/json", "JSON string"],
    ["hello=world", "text/plain", "form-encoded junk"],
    ["   ", "application/json", "whitespace body"],
  ];
  for (const [raw, ctype, why] of rawBodies) {
    const res = await M.jar.req(base, "/api/wallet/withdraw", { method: "POST", headers: { "Content-Type": ctype }, body: raw });
    check(`malformed refused: ${why}`, res.status === 400, `status ${res.status}`);
  }
  const malformedJson: Array<[unknown, string]> = [
    [null, "null body"], [[], "array body"], [[1], "array body values"], [{}, "empty object"],
    [{ amount: "5", method: "momo_mtn" }, "missing dest"], [{ method: "momo_mtn", dest: M.phone }, "missing amount"],
    [{ amount: {}, method: "momo_mtn", dest: M.phone }, "object amount"], [{ amount: [], method: "momo_mtn", dest: M.phone }, "array amount"],
    [{ amount: true, method: "momo_mtn", dest: M.phone }, "boolean amount"],
    [{ amount: "5", method: {}, dest: M.phone }, "object method"], [{ amount: "5", method: [], dest: M.phone }, "array method"],
    [{ amount: "5", method: 5, dest: M.phone }, "numeric method"], [{ amount: "5", method: true, dest: M.phone }, "boolean method"],
    [{ amount: "5", method: "momo_mtn", dest: {} }, "object dest"], [{ amount: "5", method: "momo_mtn", dest: [] }, "array dest"],
    [{ amount: "5", method: "momo_mtn", dest: 5 }, "numeric dest"], [{ amount: "5", method: "momo_mtn", dest: true }, "boolean dest"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, walletId: M.walletId }, "smuggled walletId"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, userId: 1 }, "smuggled userId"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, status: "successful" }, "smuggled status"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, balance: 1 }, "smuggled balance"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, ref: "X" }, "smuggled ref"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, id: 1 }, "smuggled id"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, adminUserId: 1 }, "smuggled adminUserId"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, password: "x" }, "smuggled password"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, ["__proto__"]: { x: 1 } }, "smuggled __proto__"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, idempotencyKey: null }, "null key"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, idempotencyKey: "" }, "empty key"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, idempotencyKey: 123 }, "numeric key"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, idempotencyKey: "short" }, "short key"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, idempotencyKey: "x".repeat(65) }, "65-char key"],
    [{ amount: "5", method: "momo_mtn", dest: M.phone, idempotencyKey: "has space" }, "spaced key"],
    [{ amount: "5", method: "m".repeat(41), dest: M.phone }, "41-char method"],
    [{ amount: "5", method: "m".repeat(500), dest: M.phone }, "500-char method (W4)"],
    [{ amount: "5", method: "momo_mtn", dest: "0".repeat(33) }, "33-char dest"],
    [{ amount: "5", method: "momo_mtn", dest: "x".repeat(500) }, "500-char dest"],
    [{ amount: "5".repeat(30), method: "momo_mtn", dest: M.phone }, "30-char amount"],
  ];
  for (const [body, why] of malformedJson) {
    const r = await withdraw(M.jar, body);
    check(`malformed refused: ${why}`, r.status === 400 && r.body.ok !== true, `status ${r.status}`);
  }
  const c9after = await snapshot(M.walletId);
  check("C9 malformed matrix caused zero mutation", JSON.stringify(c9snap) === JSON.stringify(c9after), JSON.stringify(c9after));

  // --- C10: fee quote parity — preview IS the charge (W3) -----------------------------------------------
  const G = await mkAccount("g", mtnPhone());
  await fund(G.jar, G.walletId, 500);
  for (const cedis of ["5.50", "10.25", "100.99"]) {
    const q = withdrawalQuote(parseCedisAmount(cedis).ok ? (parseCedisAmount(cedis) as { ok: true; pesewas: number }).pesewas : 0);
    // Keys allow [A-Za-z0-9_-] only — no dots — so the decimal point is encoded.
    const key = `${PREFIX}c10-${cedis.replace(".", "p")}-${stamp}`;
    const r = await withdraw(G.jar, { amount: cedis, method: "momo_mtn", dest: G.phone, idempotencyKey: key });
    const stored = r.body.ref ? (await pool.query("select fee, net_amount from withdrawal_requests where ref = $1", [r.body.ref])).rows[0] : null;
    const quoteFee = q ? Number((q.feePesewas / 100).toFixed(2)) : -1;
    const quoteNet = q ? Number((q.netPesewas / 100).toFixed(2)) : -1;
    check(
      `quote == response == stored for GH₵${cedis}`,
      r.status === 200 && r.body.fee === quoteFee && r.body.netAmount === quoteNet && Number(stored?.fee) === quoteFee && Number(stored?.net_amount) === quoteNet,
      `quote ${quoteFee}/${quoteNet} vs server ${r.body.fee}/${r.body.netAmount} vs stored ${stored?.fee}/${stored?.net_amount}`,
    );
  }
  const qd = withdrawalQuote(550)!;
  check(
    "client renders the same quote function (GH₵ 0.11 / GH₵ 5.39)",
    moneyFromPesewas(qd.feePesewas) === "GH₵ 0.11" && moneyFromPesewas(qd.netPesewas) === "GH₵ 5.39",
    `${moneyFromPesewas(qd.feePesewas)} / ${moneyFromPesewas(qd.netPesewas)}`,
  );

  // --- C11: no fake successful payouts anywhere (F5) ----------------------------------
  // Phase B wallets/requests predate Phase C; everything tracked after that
  // boundary belongs to Phase C and must contain ZERO successful payouts.
  const cWalletIds = track.walletIds.slice(bFixtureWalletCount);
  const cEmails = track.userEmails.slice(bFixtureEmailCount);
  const cPayoutLedger = await pool.query(
    "select count(*)::int as n from transactions where type = 'withdrawal' and status = 'successful' and wallet_id = any($1)",
    [cWalletIds],
  );
  check("zero successful payout ledger rows on suite wallets", cPayoutLedger.rows[0].n === 0, `${cPayoutLedger.rows[0].n}`);
  const cPayoutReqs = await pool.query(
    "select count(*)::int as n from withdrawal_requests where status = 'successful' and user_id in (select id from users where email = any($1))",
    [cEmails],
  );
  check("zero successful payout requests on suite accounts", cPayoutReqs.rows[0].n === 0, `${cPayoutReqs.rows[0].n}`);
  // Globally, the ONLY successful-withdrawal rows this run may add are the
  // intentional Phase B fixtures (simulated completion + recorded refund) —
  // counted live off the fixture wallets, never hardcoded.
  if (payoutsBefore) {
    const bWalletIds = track.walletIds.slice(0, bFixtureWalletCount);
    const bFixtureSuccessful = Number(
      (
        await pool.query(
          "select count(*)::int as n from transactions where type = 'withdrawal' and status = 'successful' and wallet_id = any($1)",
          [bWalletIds],
        )
      ).rows[0].n,
    );
    const payoutsAfter = (
      await pool.query(
        "select (select count(*)::int from transactions where type = 'withdrawal' and status = 'successful') as ledger, " +
          "(select count(*)::int from withdrawal_requests where status = 'successful') as requests",
      )
    ).rows[0] as { ledger: number; requests: number };
    check(
      "global payout delta equals intentional fixtures only",
      payoutsAfter.ledger === payoutsBefore.ledger + bFixtureSuccessful && payoutsAfter.requests === payoutsBefore.requests,
      `ledger ${payoutsBefore.ledger} → ${payoutsAfter.ledger} (fixtures ${bFixtureSuccessful}), requests ${payoutsBefore.requests} → ${payoutsAfter.requests}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup — deletes ONLY rows this suite created
// ---------------------------------------------------------------------------

async function cleanup(pool: Pool, track: Track): Promise<void> {
  try {
    if (track.walletIds.length > 0) {
      await pool.query("delete from transactions where wallet_id = any($1)", [track.walletIds]);
      await pool.query("delete from deposit_requests where wallet_id = any($1)", [track.walletIds]);
    }
    if (track.userEmails.length > 0) {
      await pool.query(
        "delete from admin_audit_logs where target_ref in (select ref from withdrawal_requests where user_id in (select id from users where email = any($1))) " +
          "or admin_user_id in (select id from users where email = any($1)) or target_user_id in (select id from users where email = any($1))",
        [track.userEmails],
      );
      const deleted = await pool.query("delete from users where email = any($1) returning id", [track.userEmails]);
      note("cleanup", `${deleted.rows.length} throwaway account(s) removed (wallets + withdrawals cascade; ledger + deposits deleted explicitly)`);
    }
    const usersLeft = track.userEmails.length
      ? Number((await pool.query("select count(*)::int as n from users where email = any($1)", [track.userEmails])).rows[0].n)
      : 0;
    const txLeft = track.walletIds.length
      ? Number((await pool.query("select count(*)::int as n from transactions where wallet_id = any($1)", [track.walletIds])).rows[0].n)
      : 0;
    check("cleanup left nothing behind", usersLeft === 0 && txLeft === 0, `users ${usersLeft} ledger ${txLeft}`);
  } catch (error) {
    note("cleanup failed", (error as Error).message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
