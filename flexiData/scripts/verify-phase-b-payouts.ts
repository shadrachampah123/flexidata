/**
 * Phase B payout integration suite — Paystack Transfers (real-money payouts).
 *
 * Proves, against the REAL code and (in Phases B/C) a REAL database, stub
 * Paystack server and app server:
 *
 *   P1  real Paystack payout calls happen ONLY when PAYSTACK_TRANSFERS_ENABLED
 *       is explicitly enabled (every transfer/recipient/status/callback path
 *       refuses before any network I/O without it)
 *   P2  the mock provider can NEVER run in production (per-call guard +
 *       fail-closed resolution)
 *   P3  the Paystack secret key is server-side only (server-only markers, and
 *       no key material in any error surface)
 *   P4  every withdrawal uses a STABLE provider reference (the withdrawal ref,
 *       reused verbatim on retry — never regenerated)
 *   P5  a retry can NEVER create a second transfer (stored-reference reuse +
 *       the 0010 unique index as final arbiter)
 *   P6  timeout/ambiguous provider outcomes NEVER mint a new reference
 *       (PaystackTransferAmbiguousError → stays processing, same reference)
 *   P7  GHS amounts convert EXACTLY to integer pesewas (no floats anywhere)
 *   P8  recipient validation is server-side (strict Ghana mobile + bank shapes)
 *   P9  bank AND mobile-money destinations are handled correctly
 *   P10 the Paystack recipient code is persisted and reused correctly
 *   P11 transfer.success is handled idempotently
 *   P12 transfer.failed is handled idempotently
 *   P13 transfer.reversed is handled idempotently
 *   P14 webhook signature verification is MANDATORY (unsigned/tampered → 401,
 *       zero state change)
 *   P15 duplicate webhook delivery cannot duplicate a wallet/ledger effect
 *   P16 failed/reversed payouts restore funds EXACTLY once
 *   P17 successful payouts can NEVER be paid again (terminal, 409s)
 *   P18 amount/currency mismatches create reconciliation exceptions (never
 *       settle)
 *   P19 unknown provider references create reconciliation exceptions
 *   P20 stuck processing payouts are detected by reconciliation
 *   P21 admin retry cannot bypass idempotency (same reference, 409s)
 *   P22 unauthorized users cannot access another user's withdrawal
 *   P23 admin actions are authenticated, authorized, and audited
 *   P24 existing Paystack deposit/top-up functionality is unchanged
 *   M1  migration 0010 journal `when` is strictly greater than the maximum
 *       existing migration `when` (esp. 0008); 0008/0009 untouched
 *   M2  the unique provider-reference index exists after migration and rejects
 *       duplicates while allowing multiple NULLs
 *
 * Layout:
 *   Phase A — pure rules + file/journal checks (no env needed).
 *   Phase B — database objects + payout execution + reconciliation against a
 *             REAL database (needs DATABASE_URL) and the Paystack stub for the
 *             provider-backed checks (PAYSTACK_STUB_URL, default 127.0.0.1:4599;
 *             stub-backed checks skip loudly when the stub is unreachable).
 *   Phase C — end-to-end API behavior (needs DATABASE_URL + BASE_URL, with the
 *             app server started for payouts — see below).
 *
 * Phase C app-server requirements (from the flexiData directory):
 *   DATABASE_URL='postgresql://…' PAYMENTS_PROVIDER=mock \
 *   PAYOUT_PROVIDER=paystack-transfers PAYSTACK_TRANSFERS_ENABLED=true \
 *   WITHDRAWALS_ENABLED=true \
 *   PAYSTACK_SECRET_KEY='<TEST_PAYSTACK_SECRET>' \
 *   PAYSTACK_BASE_URL='http://127.0.0.1:4599' \
 *   ADMIN_EMAILS='fd-pb-admin@verify.flexidata.internal' \
 *   AUTH_SECRET='<random>' npm run dev -- --port 3000
 * (WITHDRAWALS_ENABLED=true re-arms the temporary withdrawal kill switch,
 * which is fail-closed — without it the suite's withdrawals/approvals are
 * refused with 503.)
 * plus the stub:  PAYSTACK_STUB_PORT=4599 node scripts/paystack-stub.mjs
 * The suite signs payout webhooks with TEST_PAYSTACK_SECRET (default below) —
 * it MUST match the app server's PAYSTACK_SECRET_KEY.
 *
 * IMPORTANT: this suite imports server-only app modules, so it must run with
 * the react-server condition (otherwise `server-only` throws on import):
 *   npx tsx --conditions=react-server scripts/verify-phase-b-payouts.ts
 * (use `npm run verify:phase-b`).
 *
 * Safety rules (same as the sibling verify scripts):
 *   * refuses a non-local BASE_URL unless ALLOW_PRODUCTION=1;
 *   * every row it creates is tagged (refs contain `WDL-PB-`, users contain
 *     `fd-pb-`) and is deleted again before exit;
 *   * the genuine live Paystack deposit `DP-MTMZN2P8SSBR` is snapshotted before
 *     and after and must be byte-identical;
 *   * NEVER touches a real Paystack: all provider calls go to the local stub.
 *
 * Usage from the flexiData directory:
 *   npm run verify:phase-b                                                        # Phase A only
 *   DATABASE_URL='postgresql://…' npm run verify:phase-b                         # A + B
 *   DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' npm run verify:phase-b  # A + B + C
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  moneyFromPesewas,
  parseCedisAmount,
  pesewasToCedisString,
  withdrawalQuote,
} from "../src/lib/money";
import {
  normalizeGhanaMobileStrict,
  withdrawalMethodMatchesNetwork,
  WITHDRAWAL_METHODS,
} from "../src/lib/ghana-mobile";
import {
  ADMIN_WITHDRAWAL_ACTIONS,
  canTransitionWithdrawal,
  WITHDRAWAL_TRANSITIONS,
} from "../src/lib/withdrawals";
import { cedisToPesewas } from "../src/lib/format";
import {
  createBankRecipient,
  createMomoRecipient,
  fetchTransfer,
  initiateTransfer,
  isPaystackTransfersEnabled,
  mapPaystackTransferStatus,
  payoutCedisToPesewas,
  PaystackTransferAmbiguousError,
  PaystackTransferValidationError,
  resetPaystackBankCodeCache,
  resolveBankCode,
  resolveMomoBankCode,
} from "../src/lib/paystack-transfers";
import {
  getPayoutProvider,
  isRealPayoutProviderConnected,
  resetPayoutProvider,
} from "../src/lib/payout-service";
import { isValidPaystackWebhookSignature } from "../src/lib/paystack";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";
const ADMIN_EMAIL = "fd-pb-admin@verify.flexidata.internal";
const PREFIX = "fd-pb-";
const PASSWORD = "Passw0rd!long-verify";
const TEST_KEY = process.env.TEST_PAYSTACK_SECRET?.trim() || "sk_test_phaseb_suite_key_1234567890";
const STUB_URL = (process.env.PAYSTACK_STUB_URL?.trim() || "http://127.0.0.1:4599").replace(/\/$/, "");

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

const ENV_KEYS = [
  "NODE_ENV",
  "WITHDRAWALS_ENABLED",
  "PAYSTACK_TRANSFERS_ENABLED",
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_LIVE_MODE",
  "PAYSTACK_BASE_URL",
  "PAYOUT_PROVIDER",
  "PAYSTACK_MTN_BANK_CODE",
  "PAYSTACK_TELECEL_BANK_CODE",
  "ADMIN_EMAILS",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
  resetPayoutProvider();
  resetPaystackBankCodeCache();
}

/** Read a repo file as text (cwd must be flexiData). */
function readRepo(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

async function stubHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${STUB_URL}/_stub/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function signPaystack(rawBody: string, key: string = TEST_KEY): string {
  return createHmac("sha512", key).update(rawBody).digest("hex");
}

// ===========================================================================
// Phase A — pure rules + file/journal checks
// ===========================================================================

async function phaseA(): Promise<void> {
  console.log("\nPhase A — transfer flag, provider resolution, money, validation, migration files\n");

  // --- A1: the explicit transfer flag gates EVERYTHING (P1) ----------------
  console.log("--- A1 transfer flag (P1) ---");
  {
    const snap = snapshotEnv();
    try {
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      delete process.env.PAYSTACK_SECRET_KEY;
      delete process.env.PAYOUT_PROVIDER;
      check("flag defaults OFF (no env)", isPaystackTransfersEnabled() === false);
      process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
      check("flag alone is not enough (no key)", isPaystackTransfersEnabled() === false);
      process.env.PAYSTACK_SECRET_KEY = "sk_test_abc123";
      check("flag + key enables", isPaystackTransfersEnabled() === true);
      for (const v of ["false", "0", "no", "off", ""]) {
        process.env.PAYSTACK_TRANSFERS_ENABLED = v;
        check(`flag=${JSON.stringify(v)} disables`, isPaystackTransfersEnabled() === false);
      }
      for (const v of ["1", "true", "yes", "on", "TRUE", " True "]) {
        process.env.PAYSTACK_TRANSFERS_ENABLED = v;
        check(`flag=${JSON.stringify(v)} enables`, isPaystackTransfersEnabled() === true);
      }
    } finally {
      restoreEnv(snap);
    }
  }

  // --- A2: every real-money entry refuses before network when disabled (P1)
  console.log("\n--- A2 disabled-refusal of every provider entry (P1) ---");
  {
    const snap = snapshotEnv();
    try {
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      delete process.env.PAYSTACK_SECRET_KEY;
      delete process.env.PAYOUT_PROVIDER;
      process.env.NODE_ENV = "test";
      // These checks target the TRANSFERS flag specifically, so the temporary
      // withdrawal kill switch is explicitly on — otherwise its refusal (not
      // the transfers refusal under test) is what fires.
      process.env.WITHDRAWALS_ENABLED = "true";
      resetPayoutProvider();
      const refusals: Array<[string, () => Promise<unknown>]> = [
        ["initiateTransfer", () => initiateTransfer({ amountPesewas: 100, recipientCode: "RCP_x", reference: "WDL-X", reason: "t" })],
        ["fetchTransfer", () => fetchTransfer("TRF_x")],
        ["createMomoRecipient", () => createMomoRecipient({ method: "momo_mtn", destination: "0244123456", accountName: "A B" })],
        ["createBankRecipient", () => createBankRecipient({ bankCode: "GCB", accountNumber: "1234567890", accountName: "A B" })],
        ["resolveMomoBankCode", () => resolveMomoBankCode("momo_mtn")],
        ["resolveBankCode", () => resolveBankCode("GCB")],
      ];
      for (const [label, fn] of refusals) {
        try {
          await fn();
          bad(`${label} refuses when disabled`, "did not throw");
        } catch (e) {
          check(`${label} refuses when disabled`, (e as Error)?.name === "PaystackConfigError", (e as Error)?.message?.slice(0, 60) ?? "");
        }
      }
      // Provider-level entries also fail closed (resolution itself throws).
      try {
        process.env.PAYOUT_PROVIDER = "paystack-transfers";
        resetPayoutProvider();
        getPayoutProvider();
        bad("paystack provider resolution refuses when disabled", "did not throw");
      } catch (e) {
        check("paystack provider resolution refuses when disabled", true, (e as Error)?.message?.slice(0, 60) ?? "");
      }
    } finally {
      restoreEnv(snap);
    }
  }

  // --- A3: provider resolution incl. production fail-closed (P1/P2) ---------
  console.log("\n--- A3 provider resolution (P1/P2) ---");
  {
    const snap = snapshotEnv();
    try {
      process.env.NODE_ENV = "test";
      delete process.env.PAYOUT_PROVIDER;
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      process.env.PAYSTACK_SECRET_KEY = "sk_test_abc123";
      resetPayoutProvider();
      check("dev default resolves to mock", getPayoutProvider().name === "mock");
      check("mock is not a real provider", isRealPayoutProviderConnected() === false);

      process.env.PAYOUT_PROVIDER = "paystack-transfers";
      process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
      resetPayoutProvider();
      check("dev + flag resolves to paystack-transfers", getPayoutProvider().name === "paystack-transfers");
      check("paystack counts as real provider", isRealPayoutProviderConnected() === true);

      // Production matrix.
      process.env.NODE_ENV = "production";
      delete process.env.PAYOUT_PROVIDER;
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      resetPayoutProvider();
      try {
        getPayoutProvider();
        bad("production default fails closed", "resolved without config");
      } catch {
        check("production default fails closed", true);
      }
      process.env.PAYOUT_PROVIDER = "mock";
      resetPayoutProvider();
      try {
        getPayoutProvider();
        bad("production + mock fails closed", "mock resolved in production");
      } catch {
        check("production + mock fails closed", true);
      }
      process.env.PAYOUT_PROVIDER = "paystack-transfers";
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      resetPayoutProvider();
      try {
        getPayoutProvider();
        bad("production + paystack without flag fails closed", "resolved");
      } catch {
        check("production + paystack without flag fails closed", true);
      }
      process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
      resetPayoutProvider();
      check("production + paystack + flag resolves", getPayoutProvider().name === "paystack-transfers");

      // The mock's per-call guard fires even for an already-constructed mock.
      process.env.NODE_ENV = "test";
      delete process.env.PAYOUT_PROVIDER;
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      resetPayoutProvider();
      const mock = getPayoutProvider();
      check("captured mock instance is mock", mock.name === "mock");
      process.env.NODE_ENV = "production";
      for (const [label, fn] of [
        ["mock.createPayout", () => mock.createPayout({ withdrawalRef: "WDL-X", amount: "5.00", currency: "GHS", method: "momo_mtn", destination: "0244123456", network: "MTN" })],
        ["mock.getPayoutStatus", () => mock.getPayoutStatus("MOCK-X")],
        ["mock.verifyCallback", () => mock.verifyCallback("{}", {})],
      ] as Array<[string, () => Promise<unknown>]>) {
        try {
          await fn();
          bad(`${label} throws in production`, "did not throw");
        } catch (e) {
          check(`${label} throws in production`, /production/.test((e as Error)?.message ?? ""));
        }
      }
    } finally {
      restoreEnv(snap);
    }
  }

  // --- A4: exact money (P7) -------------------------------------------------
  console.log("\n--- A4 exact money (P7) ---");
  check("payout 5.00 → 500", payoutCedisToPesewas("5.00") === 500);
  check("payout 5.50 → 550", payoutCedisToPesewas("5.50") === 550);
  check("payout 4.90 → 490", payoutCedisToPesewas("4.90") === 490);
  check("payout 9.80 → 980", payoutCedisToPesewas("9.80") === 980);
  check("payout 0.11 → 11", payoutCedisToPesewas("0.11") === 11);
  for (const v of ["5.501", "abc", "0", "0.00", "-5", "", "  ", "1e3", "NaN"]) {
    try {
      payoutCedisToPesewas(v);
      bad(`payout amount ${JSON.stringify(v)} rejected`, "did not throw");
    } catch (e) {
      check(`payout amount ${JSON.stringify(v)} rejected`, (e as Error)?.name === "PaystackTransferValidationError");
    }
  }
  check("pesewas round-trip 490 → 4.90", pesewasToCedisString(490) === "4.90");
  check("pesewas round-trip 980 → 9.80", pesewasToCedisString(980) === "9.80");
  check("cedisToPesewas exact (no float)", cedisToPesewas("4.90") === 490 && cedisToPesewas("4.89") === 489);
  check("0.30000000000000004 refused (float residue)", cedisToPesewas(0.30000000000000004) === null);
  check("10.25 quote exact", (() => { const q = withdrawalQuote(1025); return q !== null && q.feePesewas + q.netPesewas === 1025; })());
  check("money display is float-free", moneyFromPesewas(539) === "GH₵ 5.39");

  // --- A5: server-side recipient validation shapes (P8/P9) ------------------
  console.log("\n--- A5 recipient validation shapes (P8/P9) ---");
  check("over-long destination NEVER truncated", !normalizeGhanaMobileStrict("024412345678").ok);
  check("11-digit garbage rejected", !normalizeGhanaMobileStrict("02441234567").ok);
  check("letters rejected", !normalizeGhanaMobileStrict("02441abcde").ok);
  check("valid MTN accepted", normalizeGhanaMobileStrict("0244123456").ok);
  check("233-spelling normalizes", normalizeGhanaMobileStrict("233244123456").ok);
  check("method↔network match enforced", withdrawalMethodMatchesNetwork("momo_mtn", "MTN") && !withdrawalMethodMatchesNetwork("momo_mtn", "TELECEL"));
  check("withdrawal methods are MoMo-only", (WITHDRAWAL_METHODS as readonly string[]).includes("momo_mtn") && (WITHDRAWAL_METHODS as readonly string[]).includes("telecel_cash"));
  {
    // Validation fires BEFORE any network I/O: flag ON + pinned bank code, but
    // an unreachable Paystack host — invalid input must still throw
    // ValidationError (proving no network was needed to refuse it).
    const snap = snapshotEnv();
    try {
      process.env.NODE_ENV = "test";
      // Validation-shape checks: the kill switch is explicitly on so the
      // ValidationError under test (not the switch refusal) is what fires.
      process.env.WITHDRAWALS_ENABLED = "true";
      process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
      process.env.PAYSTACK_SECRET_KEY = "sk_test_abc123";
      process.env.PAYSTACK_BASE_URL = "http://127.0.0.1:9";
      process.env.PAYSTACK_MTN_BANK_CODE = "MTN";
      resetPayoutProvider();
      resetPaystackBankCodeCache();
      try {
        await createMomoRecipient({ method: "momo_mtn", destination: "999", accountName: "A B" });
        bad("momo bad destination refused pre-network", "did not throw");
      } catch (e) {
        check("momo bad destination refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await createMomoRecipient({ method: "telecel_cash", destination: "0244123456", accountName: "A B" });
        bad("momo network mismatch refused pre-network", "did not throw");
      } catch (e) {
        check("momo network mismatch refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await createMomoRecipient({ method: "momo_mtn", destination: "0244123456", accountName: "x" });
        bad("momo bad account name refused pre-network", "did not throw");
      } catch (e) {
        check("momo bad account name refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await createMomoRecipient({ method: "nope" as never, destination: "0244123456", accountName: "A B" });
        bad("momo bad method refused pre-network", "did not throw");
      } catch (e) {
        check("momo bad method refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await createBankRecipient({ bankCode: "GCB", accountNumber: "12ab", accountName: "A B" });
        bad("bank bad account number refused pre-network", "did not throw");
      } catch (e) {
        check("bank bad account number refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await createBankRecipient({ bankCode: "GCB", accountNumber: "123", accountName: "A B" });
        bad("bank short account number refused pre-network", "did not throw");
      } catch (e) {
        check("bank short account number refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await resolveBankCode("!!!");
        bad("bank bad code shape refused pre-network", "did not throw");
      } catch (e) {
        check("bank bad code shape refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await resolveMomoBankCode("nope" as never);
        bad("momo bad method refused pre-network", "did not throw");
      } catch (e) {
        check("momo bad method refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await initiateTransfer({ amountPesewas: 0, recipientCode: "RCP_x", reference: "WDL-X", reason: "t" });
        bad("transfer zero amount refused pre-network", "did not throw");
      } catch (e) {
        check("transfer zero amount refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await initiateTransfer({ amountPesewas: 10.5, recipientCode: "RCP_x", reference: "WDL-X", reason: "t" });
        bad("transfer float amount refused pre-network", "did not throw");
      } catch (e) {
        check("transfer float amount refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await initiateTransfer({ amountPesewas: 100, recipientCode: "", reference: "WDL-X", reason: "t" });
        bad("transfer empty recipient refused pre-network", "did not throw");
      } catch (e) {
        check("transfer empty recipient refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await initiateTransfer({ amountPesewas: 100, recipientCode: "RCP_x", reference: "bad ref!", reason: "t" });
        bad("transfer bad reference refused pre-network", "did not throw");
      } catch (e) {
        check("transfer bad reference refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
      try {
        await fetchTransfer("  ");
        bad("fetch empty code refused pre-network", "did not throw");
      } catch (e) {
        check("fetch empty code refused pre-network", (e as Error)?.name === "PaystackTransferValidationError");
      }
    } finally {
      restoreEnv(snap);
    }
  }

  // --- A6: Paystack status mapping (never fabricate success) ----------------
  console.log("\n--- A6 transfer status mapping ---");
  check("success → successful", mapPaystackTransferStatus("success") === "successful");
  check("successful → successful", mapPaystackTransferStatus("successful") === "successful");
  check("failed → failed", mapPaystackTransferStatus("failed") === "failed");
  check("reversed → reversed", mapPaystackTransferStatus("reversed") === "reversed");
  for (const s of ["pending", "processing", "queued", "otp", "abandoned", "unknown", "", "SUCCESS-ish"]) {
    check(`raw ${JSON.stringify(s)} → pending (never success)`, mapPaystackTransferStatus(s) !== "successful" || s.toLowerCase().startsWith("success"));
  }
  check("otp → pending", mapPaystackTransferStatus("otp") === "pending");
  check("empty → pending", mapPaystackTransferStatus("") === "pending");

  // --- A7: webhook signature mandatory + event mapping (P14) ----------------
  console.log("\n--- A7 webhook verification (P14) ---");
  {
    const snap = snapshotEnv();
    try {
      process.env.NODE_ENV = "test";
      process.env.PAYOUT_PROVIDER = "paystack-transfers";
      process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
      process.env.PAYSTACK_SECRET_KEY = TEST_KEY;
      delete process.env.PAYSTACK_LIVE_MODE;
      resetPayoutProvider();
      const provider = getPayoutProvider();
      check("A7 provider is paystack", provider.name === "paystack-transfers");

      const goodBody = JSON.stringify({
        event: "transfer.success",
        data: { transfer_code: "TRF_abc", reference: "WDL-REF1", amount: 490, currency: "GHS", status: "success" },
      });
      const unsigned = await provider.verifyCallback(goodBody, {});
      check("unsigned callback rejected", unsigned.ok === false);
      const tampered = await provider.verifyCallback(goodBody, { "x-paystack-signature": "0".repeat(128) });
      check("tampered signature rejected", tampered.ok === false);
      const wrongKey = await provider.verifyCallback(goodBody, { "x-paystack-signature": signPaystack(goodBody, "sk_test_wrong_key") });
      check("wrong-key signature rejected", wrongKey.ok === false);
      const signed = await provider.verifyCallback(goodBody, { "x-paystack-signature": signPaystack(goodBody) });
      check(
        "valid signature accepted",
        signed.ok === true && signed.data.providerReference === "TRF_abc" && signed.data.status === "successful",
      );
      if (signed.ok) {
        check("webhook amount exact (490 → 4.90)", signed.data.amount === "4.90", signed.data.amount ?? "?");
        check("webhook currency passed", signed.data.currency === "GHS");
        check("stable reference echoed", signed.data.withdrawalRef === "WDL-REF1");
        check("not ignored", signed.data.ignored !== true);
      }
      const failedBody = JSON.stringify({ event: "transfer.failed", data: { transfer_code: "TRF_f", reference: "WDL-R2", amount: 980, currency: "GHS", status: "failed" } });
      const failed = await provider.verifyCallback(failedBody, { "x-paystack-signature": signPaystack(failedBody) });
      check("transfer.failed maps to failed", failed.ok === true && failed.data.status === "failed");
      const reversedBody = JSON.stringify({ event: "transfer.reversed", data: { transfer_code: "TRF_r", reference: "WDL-R3", status: "reversed" } });
      const reversed = await provider.verifyCallback(reversedBody, { "x-paystack-signature": signPaystack(reversedBody) });
      check("transfer.reversed maps to reversed", reversed.ok === true && reversed.data.status === "reversed");
      check("missing amount stays undefined (no float guess)", reversed.ok === true && reversed.data.amount === undefined);
      const floatBody = JSON.stringify({ event: "transfer.success", data: { transfer_code: "TRF_x", reference: "WDL-R4", amount: 490.5, currency: "GHS" } });
      const floated = await provider.verifyCallback(floatBody, { "x-paystack-signature": signPaystack(floatBody) });
      check("non-integer amount refused (undefined)", floated.ok === true && floated.data.amount === undefined);
      const otherBody = JSON.stringify({ event: "charge.success", data: { reference: "DP-X" } });
      const other = await provider.verifyCallback(otherBody, { "x-paystack-signature": signPaystack(otherBody) });
      check("non-transfer event acked-and-ignored", other.ok === true && other.data.ignored === true);
      const noCodeBody = JSON.stringify({ event: "transfer.success", data: { reference: "WDL-R5", amount: 100, currency: "GHS" } });
      const noCode = await provider.verifyCallback(noCodeBody, { "x-paystack-signature": signPaystack(noCodeBody) });
      check("missing transfer_code rejected", noCode.ok === false);
      const unparseable = await provider.verifyCallback("not-json{{{", { "x-paystack-signature": signPaystack("not-json{{{") });
      check("unparseable body rejected", unparseable.ok === false);
      // Header name case-insensitivity.
      const upper = await provider.verifyCallback(goodBody, { "X-Paystack-Signature": signPaystack(goodBody) });
      check("signature header case-insensitive", upper.ok === true);
      // Raw signature helper agrees.
      check("isValidPaystackWebhookSignature accepts good sig", isValidPaystackWebhookSignature(goodBody, signPaystack(goodBody)) === true);
      check("isValidPaystackWebhookSignature rejects empty", isValidPaystackWebhookSignature(goodBody, null) === false);
    } finally {
      restoreEnv(snap);
    }
  }

  // --- A8: lifecycle + admin actions incl. retry (P17/P21) ------------------
  console.log("\n--- A8 lifecycle + admin actions (P17/P21) ---");
  check("approve → processing", ADMIN_WITHDRAWAL_ACTIONS.approve === "processing");
  check("reject → rejected", ADMIN_WITHDRAWAL_ACTIONS.reject === "rejected");
  check("refund → refunded", (ADMIN_WITHDRAWAL_ACTIONS as Record<string, string>).refund === "refunded");
  check("retry → processing (same-state)", (ADMIN_WITHDRAWAL_ACTIONS as Record<string, string>).retry === "processing");
  check("admin actions never include successful", !Object.values(ADMIN_WITHDRAWAL_ACTIONS).includes("successful" as never));
  check("processing→processing is NOT a lifecycle edge", canTransitionWithdrawal("processing", "processing") === false);
  check("pending→successful unreachable", canTransitionWithdrawal("pending", "successful") === false);
  check("successful is terminal", (WITHDRAWAL_TRANSITIONS.successful ?? []).length === 0);
  check("refunded is terminal", (WITHDRAWAL_TRANSITIONS.refunded ?? []).length === 0);
  check("rejected is terminal", (WITHDRAWAL_TRANSITIONS.rejected ?? []).length === 0);
  check("processing→successful allowed (provider only)", canTransitionWithdrawal("processing", "successful") === true);
  check("processing→refunded allowed", canTransitionWithdrawal("processing", "refunded") === true);

  // --- A9: secret server-side only (P3) -------------------------------------
  console.log("\n--- A9 secret handling (P3) ---");
  for (const f of [
    "src/lib/paystack.ts",
    "src/lib/paystack-transfers.ts",
    "src/lib/payout-service.ts",
    "src/lib/payout-execution.ts",
    "src/lib/payout-reconciliation.ts",
  ]) {
    check(`${f} is server-only`, readRepo(f).includes('import "server-only"'));
  }
  {
    const snap = snapshotEnv();
    try {
      const sentinelKey = "sk_test_sentinel_KEYMAT_999";
      process.env.PAYSTACK_SECRET_KEY = sentinelKey;
      // Kill switch on: this probe asserts the *transfers-disabled* error
      // carries no key material.
      process.env.WITHDRAWALS_ENABLED = "true";
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      try {
        await initiateTransfer({ amountPesewas: 100, recipientCode: "RCP_x", reference: "WDL-X", reason: "t" });
        bad("disabled error carries no key", "did not throw");
      } catch (e) {
        const msg = (e as Error)?.message ?? "";
        check("disabled error carries no key", !msg.includes(sentinelKey) && !msg.includes("sk_test"), msg.slice(0, 60));
      }
      // The transfers client must never read process.env.PAYSTACK_SECRET_KEY in
      // *code* (auth flows through paystackApiRequest); mentions in comments /
      // operator-facing error text are fine.
      const transfersCodeLines = readRepo("src/lib/paystack-transfers.ts")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      check("transfers module never reads the key directly", !transfersCodeLines.includes("process.env.PAYSTACK_SECRET_KEY"));
    } finally {
      restoreEnv(snap);
    }
  }
  check("no payout module logs the key", !/console\.(log|info|warn|error)\([^)]*key/i.test(readRepo("src/lib/paystack-transfers.ts") + readRepo("src/lib/payout-service.ts")));

  // --- A10: migration ordering + 0010 file checks (M1) ----------------------
  console.log("\n--- A10 migration ordering (M1) ---");
  {
    const journal = JSON.parse(readRepo("drizzle/meta/_journal.json")) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    check("journal dialect is postgresql", journal.dialect === "postgresql");
    const idxs = journal.entries.map((e) => e.idx);
    check("journal idx sequential 0..10", JSON.stringify(idxs) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), idxs.join(","));
    let allFiles = true;
    for (const e of journal.entries) {
      if (!existsSync(resolve(process.cwd(), `drizzle/${e.tag}.sql`))) {
        allFiles = false;
        bad(`journal tag has matching file: ${e.tag}`, "missing drizzle/<tag>.sql");
      }
    }
    if (allFiles) check("every journal tag has a matching drizzle/<tag>.sql", true, `${journal.entries.length} entries`);
    const byIdx = new Map(journal.entries.map((e) => [e.idx, e]));
    const w8 = byIdx.get(8)!;
    const w9 = byIdx.get(9)!;
    const w10 = byIdx.get(10)!;
    check("0008 tag untouched", w8.tag === "0008_withdrawal_integrity");
    check("0008 when untouched (1788904699099)", w8.when === 1788904699099, String(w8.when));
    check("0009 tag untouched", w9.tag === "0009_withdrawal_payout_system");
    check("0009 when untouched (1741478400000)", w9.when === 1741478400000, String(w9.when));
    check("0010 tag is 0010_withdrawal_provider_ref_unique", w10.tag === "0010_withdrawal_provider_ref_unique");
    const maxPrev = Math.max(...journal.entries.filter((e) => e.idx !== 10).map((e) => e.when));
    check("0010 when > maximum previous when", w10.when > maxPrev, `${w10.when} > ${maxPrev}`);
    check("0010 when > 0008 when specifically", w10.when > w8.when);
    check("0010 breakpoints true", w10.breakpoints === true);

    const sql0010 = readRepo("drizzle/0010_withdrawal_provider_ref_unique.sql");
    check("0010 creates the unique provider index", /create\s+unique\s+index\s+"withdrawal_requests_provider_ref_idx"/i.test(sql0010));
    check("0010 index is partial (WHERE NOT NULL)", /where\s+"withdrawal_requests"\."provider_reference"\s+is\s+not\s+null/i.test(sql0010));
    check("0010 report-first duplicates check", /duplicate provider_reference/i.test(sql0010));
    check("0010 fails loudly on dupes (23505)", /23505/.test(sql0010));
    for (const destructive of ["drop table", "delete from", "truncate", "update wallets", "update transactions", "update withdrawal_requests", "drop column"]) {
      check(`0010 has no ${destructive}`, !sql0010.toLowerCase().includes(destructive));
    }
    const schema = readRepo("src/db/schema.ts");
    check("schema declares unique provider index", schema.includes('uniqueIndex("withdrawal_requests_provider_ref_idx")'));
    check("schema partial predicate", schema.includes("providerReference} is not null"));
  }

  // --- A11: deposits unchanged markers (P24, static half) -------------------
  console.log("\n--- A11 deposits unchanged — static markers (P24) ---");
  {
    const deposits = readRepo("src/lib/deposits.ts");
    check("deposit production lock intact", deposits.includes("Mock settlement is disabled in production"));
    check("deposit settle choke point intact", deposits.includes("settleAtomic"));
    check("deposits never import payouts", !deposits.includes("payout-execution") && !deposits.includes("paystack-transfers") && !deposits.includes("PAYOUT_PROVIDER"));
    const payments = readRepo("src/lib/payments.ts");
    check(
      "payments gateway untouched by payouts",
      !payments.includes("PAYOUT_PROVIDER") && !payments.includes("paystack-transfers") &&
        !payments.includes("payout-execution") && !payments.includes("transferrecipient") && !payments.includes("/transfer"),
      "no payout identifiers",
    );
    const webhook = readRepo("src/app/api/payments/webhook/route.ts");
    check("payments webhook still signature-first", webhook.includes("x-paystack-signature") && webhook.includes("reconcileDeposit"));
    check("payments webhook ignores transfer events", !webhook.includes("transfer.success"));
    const fund = readRepo("src/app/api/wallet/fund/route.ts");
    check(
      "fund route has no payout path",
      !fund.includes("PAYOUT_PROVIDER") && !fund.includes("paystack-transfers") &&
        !fund.includes("payout-execution") && !fund.includes("payout-service"),
      "no payout imports",
    );
  }

  // --- A12: ambiguous error type exists and is distinct ---------------------
  console.log("\n--- A12 ambiguous-error contract (P6) ---");
  {
    const err = new PaystackTransferAmbiguousError("x");
    check("ambiguous error has distinct name", err.name === "PaystackTransferAmbiguousError");
    check("ambiguous error is an Error", err instanceof Error);
    const src = readRepo("src/lib/payout-execution.ts");
    check("execution imports the ambiguous error", src.includes("PaystackTransferAmbiguousError"));
    check("execution never mints references (no random/uuid)", !/randomUUID|randomBytes|Math\.random/.test(src));
    check("execution reuses stored recipient", src.includes("readStoredRecipientCode") || src.includes("recipient_code"));
  }
}

// ===========================================================================
// Phase B — database objects + payout execution + reconciliation
// ===========================================================================

type Track = {
  userEmails: string[];
  walletIds: number[];
  withdrawalRefs: string[];
  depositRefs: string[];
};

async function protectedSnapshot(pool: Pool): Promise<string> {
  const dep = await pool.query(
    "select id, ref, wallet_id, provider, method, amount::text as amount, amount_subunits, currency, status::text as status, provider_reference, paystack_transaction_id from deposit_requests where ref = $1",
    [PROTECTED_REF],
  );
  if (dep.rows.length === 0) return "absent";
  const w = await pool.query("select id, balance::text as balance from wallets where id = $1", [dep.rows[0].wallet_id]);
  const tx = await pool.query(
    "select ref, type::text as type, status::text as status, amount::text as amount from transactions where ref = $1 order by id",
    [PROTECTED_REF],
  );
  return JSON.stringify({ dep: dep.rows[0], wallet: w.rows[0] ?? null, tx: tx.rows });
}

async function cleanup(pool: Pool, track: Track): Promise<void> {
  // Reverse-dependency order; audit rows first (RESTRICT), then the rest.
  if (track.withdrawalRefs.length > 0) {
    await pool.query("delete from withdrawal_audit_logs where withdrawal_ref = any($1)", [track.withdrawalRefs]);
    await pool.query("delete from payout_reconciliation_exceptions where withdrawal_ref = any($1)", [track.withdrawalRefs]);
  }
  // Exceptions created without a withdrawal ref (unknown refs) are tagged in
  // the description with the suite stamp — delete by provider_reference tag.
  await pool.query("delete from payout_reconciliation_exceptions where provider_reference like 'TRF-PB-%'");
  await pool.query("delete from payout_reconciliation_exceptions where description like '%WDL-PB-%'");
  if (track.withdrawalRefs.length > 0) {
    await pool.query("delete from withdrawal_requests where ref = any($1)", [track.withdrawalRefs]);
    await pool.query("delete from transactions where ref = any($1)", [track.withdrawalRefs]);
  }
  if (track.depositRefs.length > 0) {
    await pool.query("delete from deposit_requests where ref = any($1)", [track.depositRefs]);
    await pool.query("delete from transactions where ref = any($1)", [track.depositRefs]);
  }
  if (track.userEmails.length > 0) {
    await pool.query("delete from admin_audit_logs where target_ref = any($1)", [track.withdrawalRefs.length ? track.withdrawalRefs : ["__none__"]]);
    const ids = (await pool.query("select id from users where email = any($1)", [track.userEmails])).rows.map((r) => r.id as number);
    if (ids.length > 0) {
      await pool.query("delete from admin_audit_logs where admin_user_id = any($1) or target_user_id = any($1)", [ids]);
      await pool.query("delete from sessions where user_id = any($1)", [ids]);
      await pool.query("delete from wallets where user_id = any($1)", [ids]);
      await pool.query("delete from users where id = any($1)", [ids]);
    }
  }
}

async function phaseB(pool: Pool, track: Track): Promise<void> {
  console.log("\nPhase B — unique index, payout execution, reconciliation (REAL database)\n");
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.toUpperCase();
  const ref = (tag: string) => `WDL-PB-${stamp}-${tag}`.slice(0, 40);

  // --- B1: the 0010 unique index shape (M2) --------------------------------
  console.log("--- B1 unique provider index (M2) ---");
  {
    const shape = await pool.query(
      `select c.relname as name, i.indisunique as unique,
              pg_get_expr(i.indpred, i.indrelid) as predicate
         from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = 'withdrawal_requests_provider_ref_idx'`,
    );
    check("provider index exists", shape.rows.length === 1);
    check("provider index IS unique", shape.rows[0]?.unique === true, String(shape.rows[0]?.unique));
    check(
      "provider index is partial on NOT NULL",
      typeof shape.rows[0]?.predicate === "string" && shape.rows[0].predicate.includes("provider_reference IS NOT NULL"),
      shape.rows[0]?.predicate ?? "?",
    );
  }

  // --- B2: duplicates rejected, NULLs allowed (M2/P5) ----------------------
  console.log("\n--- B2 duplicate rejection + NULL tolerance (M2/P5) ---");
  {
    // Fixture user + wallet for direct-SQL probes.
    const email = `${PREFIX}b-${stamp}@verify.flexidata.internal`.toLowerCase();
    const phone = `024${String(1000000 + (parseInt(stamp.slice(-6), 36) % 8999999))}`;
    const u = await pool.query(
      "insert into users (name, email, phone, password_hash, referral_code) values ($1, $2, $3, 'x', $4) returning id",
      [`PB User`, email, phone, `PB${stamp}`.slice(0, 20)],
    );
    const userId = u.rows[0].id as number;
    const w = await pool.query("insert into wallets (user_id, name, number, balance) values ($1, $2, $3, '100.00') returning id", [
      userId,
      "PB Wallet",
      phone,
    ]);
    const walletId = w.rows[0].id as number;
    track.userEmails.push(email);
    track.walletIds.push(walletId);

    const mk = async (r: string, providerRef: string | null, key: string | null) => {
      await pool.query(
        `insert into withdrawal_requests
           (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, provider_reference, currency)
         values ($1, $2, $3, '5.00', '0.10', '4.90', 'momo_mtn', $4, 'processing', $5, $6, 'GHS')`,
        [r, userId, walletId, JSON.stringify({ account: phone, network: "MTN", method: "momo_mtn" }), key, providerRef],
      );
      track.withdrawalRefs.push(r);
    };
    const r1 = ref("DUP1");
    const r2 = ref("DUP2");
    await mk(r1, "TRF-PB-STAMP-DUP", `pb-key-${stamp}-1`);
    try {
      await mk(r2, "TRF-PB-STAMP-DUP", `pb-key-${stamp}-2`);
      bad("duplicate provider_reference rejected", "second insert succeeded");
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const constraint = (e as { constraint?: string })?.constraint;
      check("duplicate provider_reference rejected (23505)", code === "23505", `${code}/${constraint}`);
      check("violation names the 0010 index", constraint === "withdrawal_requests_provider_ref_idx", constraint ?? "?");
    }
    // NULLs: many allowed.
    await mk(ref("NULL1"), null, `pb-key-${stamp}-3`);
    await mk(ref("NULL2"), null, `pb-key-${stamp}-4`);
    const nulls = await pool.query("select count(*)::int as n from withdrawal_requests where ref = any($1) and provider_reference is null", [
      track.withdrawalRefs,
    ]);
    check("multiple NULL provider_references allowed", (nulls.rows[0]?.n as number) >= 2);
  }

  // --- B3: runtime self-heal converges to the 0010 shape -------------------
  console.log("\n--- B3 self-heal convergence ---");
  {
    const { repairPayoutSystemSchema } = await import("../src/lib/seed");
    await repairPayoutSystemSchema();
    await repairPayoutSystemSchema();
    const shape = await pool.query(
      `select i.indisunique as unique from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = 'withdrawal_requests_provider_ref_idx'`,
    );
    check("self-heal keeps the unique index (idempotent)", shape.rows[0]?.unique === true);

    // Degrade to the 0009 shape, prove the healer rebuilds it as unique.
    await pool.query("drop index if exists withdrawal_requests_provider_ref_idx");
    await pool.query("create index withdrawal_requests_provider_ref_idx on withdrawal_requests (provider_reference) where provider_reference is not null");
    const degraded = await pool.query(
      `select i.indisunique as unique from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = 'withdrawal_requests_provider_ref_idx'`,
    );
    check("degraded fixture is non-unique", degraded.rows[0]?.unique === false);
    await repairPayoutSystemSchema();
    const healed = await pool.query(
      `select i.indisunique as unique from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = 'withdrawal_requests_provider_ref_idx'`,
    );
    check("self-heal rebuilds non-unique → unique", healed.rows[0]?.unique === true);

    // Duplicates: reported + preserved, index left alone (never rewritten).
    await pool.query("drop index if exists withdrawal_requests_provider_ref_idx");
    const dupeRef = `TRF-PB-DUPE-${stamp}`;
    const dr1 = ref("HD1");
    const dr2 = ref("HD2");
    const walletId = track.walletIds[0];
    const userRow = await pool.query("select user_id from wallets where id = $1", [walletId]);
    const userId = userRow.rows[0].user_id as number;
    const phone = `025${String(1000000 + (parseInt(stamp.slice(-6), 36) % 8999999))}`;
    for (const r of [dr1, dr2]) {
      await pool.query(
        `insert into withdrawal_requests
           (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, provider_reference, currency)
         values ($1, $2, $3, '6.00', '0.12', '5.88', 'momo_mtn', $4, 'processing', $5, $6, 'GHS')`,
        [r, userId, walletId, JSON.stringify({ account: phone, network: "MTN", method: "momo_mtn" }), `pb-heal-${r}`, dupeRef],
      );
      track.withdrawalRefs.push(r);
    }
    await repairPayoutSystemSchema(); // must NOT create the unique index, must NOT touch rows
    const stillMissing = await pool.query(
      `select count(*)::int as n from pg_class where relname = 'withdrawal_requests_provider_ref_idx'`,
    );
    check("self-heal refuses unique index while dupes exist", (stillMissing.rows[0]?.n as number) === 0);
    const dupeRows = await pool.query("select count(*)::int as n from withdrawal_requests where provider_reference = $1", [dupeRef]);
    check("duplicate rows preserved untouched (2)", (dupeRows.rows[0]?.n as number) === 2);
    // Resolve + heal.
    await pool.query("delete from withdrawal_requests where ref = $1", [dr2]);
    track.withdrawalRefs = track.withdrawalRefs.filter((r) => r !== dr2);
    await repairPayoutSystemSchema();
    const healed2 = await pool.query(
      `select i.indisunique as unique from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = 'withdrawal_requests_provider_ref_idx'`,
    );
    check("self-heal converges after dupe resolution", healed2.rows[0]?.unique === true);
  }

  // --- B4: reconciliation — stuck + duplicates (P20) ------------------------
  console.log("\n--- B4 reconciliation: stuck + duplicates (P20) ---");
  {
    const { runPayoutReconciliation } = await import("../src/lib/payout-reconciliation");
    const walletId = track.walletIds[0];
    const userRow = await pool.query("select user_id from wallets where id = $1", [walletId]);
    const userId = userRow.rows[0].user_id as number;
    const phone = `024${String(2000000 + (parseInt(stamp.slice(-6), 36) % 7999999))}`;
    const stuckRef = ref("STUCK");
    await pool.query(
      `insert into withdrawal_requests
         (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, provider_reference, currency, processed_at, created_at)
       values ($1, $2, $3, '7.00', '0.14', '6.86', 'momo_mtn', $4, 'processing', $5, $6, 'GHS', now() - interval '25 hours', now() - interval '26 hours')`,
      [stuckRef, userId, walletId, JSON.stringify({ account: phone, network: "MTN", method: "momo_mtn" }), `pb-stuck-${stamp}`, `TRF-PB-STUCK-${stamp}`],
    );
    track.withdrawalRefs.push(stuckRef);
    const before = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'stuck_processing' and resolved = false", [stuckRef]);
    check("no stuck exception before run", (before.rows[0]?.n as number) === 0);
    const res1 = await runPayoutReconciliation();
    check("reconciliation run examines processing rows", res1.examined >= 1, `examined=${res1.examined}`);
    const after = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'stuck_processing' and resolved = false", [stuckRef]);
    check("stuck processing detected", (after.rows[0]?.n as number) === 1);
    const res2 = await runPayoutReconciliation();
    const after2 = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'stuck_processing' and resolved = false", [stuckRef]);
    check("reconciliation is idempotent (no dupe exceptions)", (after2.rows[0]?.n as number) === 1, `newExceptions2=${res2.newExceptions}`);
    // Balances untouched by the scan (read-only proof).
    const bal = await pool.query("select balance::text as b from wallets where id = $1", [walletId]);
    check("reconciliation moves no money", (bal.rows[0]?.b as string) === "100.00", (bal.rows[0]?.b as string) ?? "?");
  }

  // --- B5: provider-backed execution + reconciliation (stub) (P4/P5/P6/P10) --
  console.log("\n--- B5 provider-backed execution + reconciliation (stub) ---");
  const stubUp = await stubHealthy();
  if (!stubUp) {
    note("stub unreachable — provider-backed B5 checks skipped", `set PAYSTACK_STUB_URL (tried ${STUB_URL})`);
  } else {
    await fetch(`${STUB_URL}/_stub/reset`, { method: "POST" });
    const snap = snapshotEnv();
    try {
      process.env.NODE_ENV = "test";
      // B5 executes real (stub) payouts: the temporary withdrawal kill switch
      // must be explicitly on.
      process.env.WITHDRAWALS_ENABLED = "true";
      process.env.PAYOUT_PROVIDER = "paystack-transfers";
      process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
      process.env.PAYSTACK_SECRET_KEY = TEST_KEY;
      process.env.PAYSTACK_BASE_URL = STUB_URL;
      delete process.env.PAYSTACK_MTN_BANK_CODE;
      delete process.env.PAYSTACK_TELECEL_BANK_CODE;
      resetPayoutProvider();
      resetPaystackBankCodeCache();

      const { db } = await import("../src/db/index");
      const { executeWithdrawalPayout } = await import("../src/lib/payout-execution");
      const { runPayoutReconciliation } = await import("../src/lib/payout-reconciliation");

      const walletId = track.walletIds[0];
      const userRow = await pool.query("select user_id from wallets where id = $1", [walletId]);
      const userId = userRow.rows[0].user_id as number;
      const mtnPhone = `024${String(3000000 + (parseInt(stamp.slice(-6), 36) % 6999999))}`;

      // Bank-code resolution from the live (stub) /bank list — nothing hardcoded.
      const mtnCode = await resolveMomoBankCode("momo_mtn");
      const telecelCode = await resolveMomoBankCode("telecel_cash");
      check("MTN momo code resolved via /bank", mtnCode === "MTN", mtnCode);
      check("Telecel momo code resolved via /bank", telecelCode === "TELECEL", telecelCode);
      const bank = await resolveBankCode("GCB");
      check("nuban bank code resolved via /bank", bank.code === "GCB", bank.name);
      try {
        await resolveBankCode("NOPE");
        bad("unknown bank code refused", "resolved");
      } catch (e) {
        check("unknown bank code refused", (e as Error)?.name === "PaystackTransferValidationError");
      }
      const bankRcpt = await createBankRecipient({ bankCode: "GCB", accountNumber: "1234567890", accountName: "PB Bank User" });
      check("bank recipient created (nuban path, P9)", bankRcpt.recipientCode.startsWith("RCP_") && bankRcpt.type === "nuban", bankRcpt.recipientCode);

      // Initiate via the execution choke point: exact pesewas + stable ref.
      const execRef = ref("EXEC");
      await pool.query(
        `insert into withdrawal_requests
           (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, currency)
         values ($1, $2, $3, '10.00', '0.20', '9.80', 'momo_mtn', $4, 'processing', $5, 'GHS')`,
        [execRef, userId, walletId, JSON.stringify({ account: mtnPhone, network: "MTN", method: "momo_mtn" }), `pb-exec-${stamp}`],
      );
      track.withdrawalRefs.push(execRef);
      const execRow = (await pool.query("select * from withdrawal_requests where ref = $1", [execRef])).rows[0];
      const attempt1 = await db.transaction(async (tx) => {
        const { withdrawalRequests } = await import("../src/db/schema");
        const { eq } = await import("drizzle-orm");
        const rows = await tx.select().from(withdrawalRequests).where(eq(withdrawalRequests.ref, execRef)).for("update");
        return executeWithdrawalPayout(tx, rows[0], { type: "system" });
      });
      check("execution initiates (stub)", attempt1.outcome === "initiated", attempt1.message.slice(0, 70));
      check("transfer code stored", (attempt1.providerReference ?? "").startsWith("TRF_"), attempt1.providerReference ?? "?");
      const stored = (await pool.query("select provider_reference, provider_payload from withdrawal_requests where ref = $1", [execRef])).rows[0];
      const payload = stored.provider_payload as Record<string, unknown>;
      check("recipient code persisted in payload (P10)", typeof payload.recipient_code === "string" && (payload.recipient_code as string).startsWith("RCP_"), String(payload.recipient_code ?? "?"));
      check("stable reference recorded (P4)", payload.reference_sent === execRef, String(payload.reference_sent ?? "?"));
      const audit1 = await pool.query("select count(*)::int as n from withdrawal_audit_logs where withdrawal_ref = $1", [execRef]);
      check("initiation audited", (audit1.rows[0]?.n as number) >= 1);

      // What did the stub actually receive? Exact pesewas + stable reference.
      const stubAudit = (await (await fetch(`${STUB_URL}/_stub/audit`)).json()) as {
        transfers: Record<string, { reference: string; amount: number; currency: string; recipientCode: string; authLooksLikeTestKey: boolean }>;
        recipients: Record<string, { accountNumber: string; bankCode: string }>;
      };
      const stubTransfers = Object.entries(stubAudit.transfers);
      check("exactly one stub transfer created", stubTransfers.length === 1, String(stubTransfers.length));
      const [, t1] = stubTransfers[0];
      check("stub transfer amount exact (980)", t1.amount === 980, String(t1.amount));
      check("stub transfer reference is the withdrawal ref (stable)", t1.reference === execRef, t1.reference);
      check("stub transfer currency GHS", t1.currency === "GHS");
      check("stub saw a test-key bearer shape", t1.authLooksLikeTestKey === true);
      const rcpt = stubAudit.recipients[t1.recipientCode];
      check("stub recipient account is the normalized msisdn", rcpt?.accountNumber === mtnPhone, rcpt?.accountNumber ?? "?");
      check("stub recipient bank is the MTN code", rcpt?.bankCode === "MTN", rcpt?.bankCode ?? "?");

      // Retry reuses — no second transfer (P5).
      const execRow2 = (await pool.query("select * from withdrawal_requests where ref = $1", [execRef])).rows[0];
      const { withdrawalRequests: wrTable } = await import("../src/db/schema");
      const { eq: drizzleEq } = await import("drizzle-orm");
      const attempt2 = await db.transaction(async (tx) => {
        const rows = await tx.select().from(wrTable).where(drizzleEq(wrTable.ref, execRef)).for("update");
        return executeWithdrawalPayout(tx, rows[0], { type: "system" });
      });
      void execRow2;
      check("retry reuses the stored transfer (P5)", attempt2.outcome === "reused" && attempt2.providerReference === attempt1.providerReference, attempt2.outcome);
      const stubAudit2 = (await (await fetch(`${STUB_URL}/_stub/audit`)).json()) as { transfers: Record<string, unknown> };
      check("no second stub transfer after retry", Object.keys(stubAudit2.transfers).length === 1);

      // Provider-vs-local reconciliation against the stub.
      await fetch(`${STUB_URL}/_stub/transfer-scenario`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: execRef, scenario: "success" }) });
      const r1 = await runPayoutReconciliation();
      void r1;
      const div1 = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'provider_success_local_processing' and resolved = false", [execRef]);
      check("provider-success-vs-local-processing flagged", (div1.rows[0]?.n as number) === 1);
      await fetch(`${STUB_URL}/_stub/transfer-scenario`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: execRef, scenario: "failed" }) });
      await runPayoutReconciliation();
      const div2 = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'provider_failure_local_processing' and resolved = false", [execRef]);
      check("provider-failure-vs-local-processing flagged", (div2.rows[0]?.n as number) === 1);
      await fetch(`${STUB_URL}/_stub/transfer-scenario`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: execRef, scenario: "success-wrong-amount" }) });
      await runPayoutReconciliation();
      const div3 = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'amount_mismatch' and resolved = false", [execRef]);
      check("provider amount drift flagged", (div3.rows[0]?.n as number) === 1);
      await fetch(`${STUB_URL}/_stub/transfer-scenario`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: execRef, scenario: "success-wrong-currency" }) });
      await runPayoutReconciliation();
      const div4 = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'currency_mismatch' and resolved = false", [execRef]);
      check("provider currency drift flagged", (div4.rows[0]?.n as number) === 1);
      await fetch(`${STUB_URL}/_stub/transfer-scenario`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: execRef, scenario: "pending" }) });

      // Ambiguous outcome: unreachable Paystack host → same reference kept (P6).
      process.env.PAYSTACK_BASE_URL = "http://127.0.0.1:9";
      resetPayoutProvider();
      resetPaystackBankCodeCache();
      const ambRef = ref("AMB");
      await pool.query(
        `insert into withdrawal_requests
           (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, currency)
         values ($1, $2, $3, '8.00', '0.16', '7.84', 'momo_mtn', $4, 'processing', $5, 'GHS')`,
        [ambRef, userId, walletId, JSON.stringify({ account: mtnPhone, network: "MTN", method: "momo_mtn" }), `pb-amb-${stamp}`],
      );
      track.withdrawalRefs.push(ambRef);
      const attemptAmb = await db.transaction(async (tx) => {
        const rows = await tx.select().from(wrTable).where(drizzleEq(wrTable.ref, ambRef)).for("update");
        return executeWithdrawalPayout(tx, rows[0], { type: "system" });
      });
      check("unreachable provider → ambiguous (not failed)", attemptAmb.outcome === "ambiguous", attemptAmb.message.slice(0, 70));
      const ambStored = (await pool.query("select provider_reference, provider_status, provider_payload, status from withdrawal_requests where ref = $1", [ambRef])).rows[0];
      check("ambiguous keeps provider_reference NULL (no fork)", ambStored.provider_reference === null);
      check("ambiguous marks provider_status unknown", ambStored.provider_status === "unknown", ambStored.provider_status ?? "?");
      check("ambiguous records the SAME stable reference", (ambStored.provider_payload as Record<string, unknown>)?.reference_sent === ambRef);
      check("ambiguous stays processing", ambStored.status === "processing");
      const ambAudit = await pool.query("select count(*)::int as n from withdrawal_audit_logs where withdrawal_ref = $1 and event = 'provider_timeout'", [ambRef]);
      check("ambiguous audited as provider_timeout", (ambAudit.rows[0]?.n as number) === 1);

      // Definitive failure: invalid destination → failed, retryable, no transfer.
      process.env.PAYSTACK_BASE_URL = STUB_URL;
      resetPayoutProvider();
      resetPaystackBankCodeCache();
      const badRef = ref("BADDEST");
      await pool.query(
        `insert into withdrawal_requests
           (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, currency)
         values ($1, $2, $3, '8.00', '0.16', '7.84', 'momo_mtn', $4, 'processing', $5, 'GHS')`,
        [badRef, userId, walletId, JSON.stringify({ account: "999", network: "MTN", method: "momo_mtn" }), `pb-bad-${stamp}`],
      );
      track.withdrawalRefs.push(badRef);
      const attemptBad = await db.transaction(async (tx) => {
        const rows = await tx.select().from(wrTable).where(drizzleEq(wrTable.ref, badRef)).for("update");
        return executeWithdrawalPayout(tx, rows[0], { type: "system" });
      });
      check("invalid destination → failed (definitive)", attemptBad.outcome === "failed", attemptBad.message.slice(0, 70));
      const badStored = (await pool.query("select status, provider_status from withdrawal_requests where ref = $1", [badRef])).rows[0];
      check("definitive failure stays processing (recoverable)", badStored.status === "processing" && badStored.provider_status === "initiation_failed");
      const stubAudit3 = (await (await fetch(`${STUB_URL}/_stub/audit`)).json()) as { transfers: Record<string, { reference: string }> };
      const badCreated = Object.values(stubAudit3.transfers).some((t) => t.reference === badRef);
      check("definitive failure created no stub transfer", badCreated === false);
    } finally {
      restoreEnv(snap);
    }
  }
}

// ===========================================================================
// Phase C — end-to-end API behavior (REAL app server + stub Paystack)
// ===========================================================================

async function phaseC(base: string, pool: Pool, track: Track): Promise<void> {
  console.log("\nPhase C — payout lifecycle end to end (REAL app server + stub Paystack)\n");
  if (!(await stubHealthy())) {
    bad("Phase C aborted", `Paystack stub unreachable at ${STUB_URL} — start it: PAYSTACK_STUB_PORT=4599 node scripts/paystack-stub.mjs`);
    return;
  }
  await fetch(`${STUB_URL}/_stub/reset`, { method: "POST" });

  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  let phoneSeq = 0;
  const seq = (): number => {
    phoneSeq += 1;
    return (parseInt(stamp.slice(-6), 36) + phoneSeq * 131071) % 8_999_999;
  };
  const mtnPhone = (): string => `024${1_000_000 + seq()}`;
  const telecelPhone = (): string => `020${1_000_000 + seq()}`;

  const mkAccount = async (
    tag: string,
    phone: string,
  ): Promise<{ jar: Jar; email: string; phone: string; walletId: number }> => {
    const jar = new Jar();
    const email = `${PREFIX}c-${stamp}-${tag}@verify.flexidata.internal`;
    const reg = await jar.req(base, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name: `Pb User ${tag}`, email, phone, password: PASSWORD }),
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
  const wdRow = async (walletRef: string) =>
    (await pool.query("select * from withdrawal_requests where ref = $1", [walletRef])).rows[0] as Record<string, unknown> | undefined;
  const ledgerRow = async (walletRef: string) =>
    (await pool.query("select * from transactions where ref = $1", [walletRef])).rows[0] as Record<string, unknown> | undefined;
  const exceptionCount = async (type: string, walletRef?: string): Promise<number> =>
    Number(
      (
        await pool.query(
          walletRef
            ? "select count(*)::int as n from payout_reconciliation_exceptions where exception_type = $1 and withdrawal_ref = $2 and resolved = false"
            : "select count(*)::int as n from payout_reconciliation_exceptions where exception_type = $1 and resolved = false",
          walletRef ? [type, walletRef] : [type],
        )
      ).rows[0].n,
    );

  // --- C1: admin + users ----------------------------------------------------
  console.log("--- C1 accounts + admin gate (P23) ---");
  const adminJar = new Jar();
  await adminJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Pb Admin", email: ADMIN_EMAIL, phone: telecelPhone(), password: PASSWORD }),
  });
  await adminJar.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN_EMAIL, password: PASSWORD }) });
  await pool.query("update users set is_admin = true where email = $1", [ADMIN_EMAIL]);
  track.userEmails.push(ADMIN_EMAIL);
  const adminWalletRow = await pool.query("select w.id from wallets w join users u on u.id = w.user_id where u.email = $1", [ADMIN_EMAIL]);
  if (adminWalletRow.rows[0]) track.walletIds.push(Number(adminWalletRow.rows[0].id));
  const adminMe = await adminJar.req(base, "/api/admin/me");
  check("admin gate admits the suite admin", adminMe.status === 200, `status ${adminMe.status} (app needs ADMIN_EMAILS=${ADMIN_EMAIL})`);
  if (adminMe.status !== 200) {
    bad("Phase C aborted", "admin gate refused — start the app with the documented ADMIN_EMAILS");
    return;
  }
  const A = await mkAccount("a", mtnPhone());
  const B = await mkAccount("b", telecelPhone());
  const C = await mkAccount("c", mtnPhone());
  const D = await mkAccount("d", mtnPhone());
  check("Phase C accounts registered", true, `A=${A.phone} B=${B.phone}`);

  // --- C2: fund (mock instant) — deposit path live (P24) --------------------
  console.log("\n--- C2 funding — deposit path live (P24) ---");
  const fund = async (jar: Jar, amount: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await jar.req(base, "/api/wallet/fund", { method: "POST", body: JSON.stringify({ method: "momo_mtn", amount }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const fa = await fund(A.jar, 100);
  check("A funded GH₵100 (mock instant)", fa.status === 200 && fa.body.status === "successful", String(fa.body.status ?? fa.status));
  if (!(fa.status === 200 && fa.body.status === "successful")) {
    bad("Phase C aborted", "point BASE_URL at a mock-funding server (PAYMENTS_PROVIDER=mock)");
    return;
  }
  await fund(B.jar, 50);
  await fund(C.jar, 30);
  await fund(D.jar, 40);
  check("balances exact after funding", (await balanceOf(A.walletId)) === 100 && (await balanceOf(B.walletId)) === 50);
  const depLedger = await pool.query(
    "select count(*)::int as n from transactions where wallet_id = $1 and type = 'deposit' and status = 'successful'",
    [A.walletId],
  );
  check("funding wrote a deposit ledger row", (depLedger.rows[0]?.n as number) >= 1);

  // --- C3: withdraw + idempotent retry (P4) ---------------------------------
  console.log("\n--- C3 withdraw + idempotent retry (P4) ---");
  type WdResp = { ok?: boolean; ref?: string; newBalance?: number; fee?: number; netAmount?: number; duplicate?: boolean; error?: string };
  const withdraw = async (jar: Jar, body: unknown): Promise<{ status: number; body: WdResp }> => {
    const res = await jar.req(base, "/api/wallet/withdraw", { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as WdResp };
  };
  const keyA = `pb-idem-${stamp}-a`;
  const wa = await withdraw(A.jar, { amount: "10", method: "momo_mtn", dest: A.phone, idempotencyKey: keyA });
  check("A withdraws GH₵10", wa.status === 200 && wa.body.ok === true && typeof wa.body.ref === "string", wa.body.error ?? wa.body.ref ?? `status ${wa.status}`);
  const refA = wa.body.ref as string;
  track.withdrawalRefs.push(refA);
  check("fee/net exact (0.20/9.80)", wa.body.fee === 0.2 && wa.body.netAmount === 9.8, `fee=${wa.body.fee} net=${wa.body.netAmount}`);
  check("balance deducted exactly (90.00)", (await balanceOf(A.walletId)) === 90);
  const waDupe = await withdraw(A.jar, { amount: "10", method: "momo_mtn", dest: A.phone, idempotencyKey: keyA });
  check("same key replays original (duplicate:true)", waDupe.body.duplicate === true && waDupe.body.ref === refA);
  check("replay deducts nothing (still 90.00)", (await balanceOf(A.walletId)) === 90);
  const wdCountA = await pool.query("select count(*)::int as n from withdrawal_requests where wallet_id = $1", [A.walletId]);
  check("one withdrawal row after replay", (wdCountA.rows[0]?.n as number) === 1);

  // --- C4: approve initiates a REAL stub transfer (P1/P4/P7/P8/P9/P10) -------
  console.log("\n--- C4 approve initiates stub transfer (P1/P4/P7/P8/P9/P10) ---");
  const wdIdOf = async (r: string): Promise<number> => Number((await pool.query("select id from withdrawal_requests where ref = $1", [r])).rows[0].id);
  const adminAction = async (id: number, action: string, reason = ""): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await adminJar.req(base, `/api/admin/withdrawals/${id}/action`, { method: "POST", body: JSON.stringify({ action, reason }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const idA = await wdIdOf(refA);
  const apA = await adminAction(idA, "approve");
  check("approve → processing", apA.status === 200 && apA.body.status === "processing", JSON.stringify(apA.body).slice(0, 120));
  const payoutA = apA.body.payout as { outcome?: string; providerReference?: string; message?: string } | undefined;
  check("approve reports payout attempt", !!payoutA && typeof payoutA.outcome === "string", payoutA?.outcome ?? "?");
  check("payout initiated (not skipped)", payoutA?.outcome === "initiated", payoutA?.outcome ?? "missing — is the app started with PAYOUT_PROVIDER=paystack-transfers + flag + WITHDRAWALS_ENABLED=true + stub?");
  if (payoutA?.outcome !== "initiated") {
    bad("Phase C aborted", "approve did not initiate — check app payout env (provider/flag/stub)");
    return;
  }
  const trfA = payoutA.providerReference as string;
  check("transfer code shape (TRF_)", trfA.startsWith("TRF_"), trfA);
  const rowA = (await wdRow(refA))!;
  check("provider_reference stored", rowA.provider_reference === trfA);
  const payloadA = rowA.provider_payload as Record<string, unknown>;
  check("recipient code persisted (P10)", typeof payloadA.recipient_code === "string" && (payloadA.recipient_code as string).startsWith("RCP_"), String(payloadA.recipient_code ?? "?"));
  check("stable reference recorded (P4)", payloadA.reference_sent === refA);
  const stubAudit = (await (await fetch(`${STUB_URL}/_stub/audit`)).json()) as {
    transfers: Record<string, { reference: string; amount: number; currency: string; recipientCode: string }>;
    recipients: Record<string, { accountNumber: string; bankCode: string; type: string }>;
  };
  check("exactly one stub transfer", Object.keys(stubAudit.transfers).length === 1);
  const stA = stubAudit.transfers[trfA];
  check("stub amount exact pesewas (980)", stA?.amount === 980, String(stA?.amount));
  check("stub reference is the withdrawal ref (stable)", stA?.reference === refA, stA?.reference ?? "?");
  check("stub currency GHS", stA?.currency === "GHS");
  const rcptA = stubAudit.recipients[stA?.recipientCode];
  check("recipient is MTN mobile_money", rcptA?.type === "mobile_money" && rcptA?.bankCode === "MTN", `${rcptA?.type}/${rcptA?.bankCode}`);
  check("recipient account is A's msisdn", rcptA?.accountNumber === A.phone, rcptA?.accountNumber ?? "?");
  const ledgerA = (await ledgerRow(refA))!;
  check("ledger stays pending at approve (no fake completion)", ledgerA.status === "pending");
  const auditA = await pool.query("select event from withdrawal_audit_logs where withdrawal_ref = $1 order by id", [refA]);
  const eventsA = auditA.rows.map((r) => r.event as string);
  check("audit chain created→approved→moved_to_processing", eventsA.includes("created") && eventsA.includes("approved") && eventsA.includes("moved_to_processing"), eventsA.join(","));

  // --- C5: retry reuses, double-approve 409s (P5/P21) -----------------------
  console.log("\n--- C5 retry + replay guards (P5/P21) ---");
  const rtA = await adminAction(idA, "retry");
  const payoutRt = rtA.body.payout as { outcome?: string; providerReference?: string } | undefined;
  check("retry on initiated → reused", rtA.status === 200 && payoutRt?.outcome === "reused" && payoutRt?.providerReference === trfA, JSON.stringify(rtA.body).slice(0, 120));
  const stubAuditRt = (await (await fetch(`${STUB_URL}/_stub/audit`)).json()) as { transfers: Record<string, unknown> };
  check("retry created no second transfer", Object.keys(stubAuditRt.transfers).length === 1);
  const apA2 = await adminAction(idA, "approve");
  check("second approve → 409", apA2.status === 409, `status ${apA2.status}`);
  // Retry on pending → 400.
  const wb = await withdraw(B.jar, { amount: "6", method: "telecel_cash", dest: B.phone, idempotencyKey: `pb-idem-${stamp}-b` });
  const refB = wb.body.ref as string;
  track.withdrawalRefs.push(refB);
  const idB = await wdIdOf(refB);
  const rtPending = await adminAction(idB, "retry");
  check("retry on pending → 400 (approve first)", rtPending.status === 400, `status ${rtPending.status}`);

  // --- C6: transfer.success idempotent (P11/P15/P17) -------------------------
  console.log("\n--- C6 transfer.success (P11/P15/P17) ---");
  const postCallback = async (payload: unknown, key: string | null): Promise<{ status: number; body: Record<string, unknown> }> => {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== null) headers["x-paystack-signature"] = signPaystack(raw, key);
    const res = await fetch(`${base}/api/payouts/callback`, { method: "POST", headers, body: raw });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const successA = { event: "transfer.success", data: { transfer_code: trfA, reference: refA, amount: 980, currency: "GHS", status: "success" } };
  const cb1 = await postCallback(successA, TEST_KEY);
  check("transfer.success → successful", cb1.status === 200 && cb1.body.status === "successful", JSON.stringify(cb1.body).slice(0, 100));
  check("withdrawal row successful", ((await wdRow(refA))!).status === "successful");
  check("ledger row successful", ((await ledgerRow(refA))!).status === "successful");
  check("success moves no wallet money (still 90)", (await balanceOf(A.walletId)) === 90);
  const cb1Dupe = await postCallback(successA, TEST_KEY);
  check("duplicate success is idempotent", cb1Dupe.status === 200 && (cb1Dupe.body.status === "idempotent" || cb1Dupe.body.status === "successful"), JSON.stringify(cb1Dupe.body).slice(0, 80));
  check("duplicate success moves nothing (still 90)", (await balanceOf(A.walletId)) === 90);
  const cbAfterSuccess = await postCallback({ event: "transfer.failed", data: { transfer_code: trfA, reference: refA, amount: 980, currency: "GHS", status: "failed" } }, TEST_KEY);
  check("failed-after-success refused (409)", cbAfterSuccess.status === 409, `status ${cbAfterSuccess.status}`);
  check("successful row unchanged by late failure", ((await wdRow(refA))!).status === "successful");
  const refundAfterSuccess = await adminAction(idA, "refund");
  check("admin refund on successful → 409", refundAfterSuccess.status === 409, `status ${refundAfterSuccess.status}`);
  const retryAfterSuccess = await adminAction(idA, "retry");
  check("admin retry on successful → 409", retryAfterSuccess.status === 409, `status ${retryAfterSuccess.status}`);

  // --- C7: transfer.failed refunds exactly once (P12/P15/P16) ----------------
  console.log("\n--- C7 transfer.failed (P12/P15/P16) ---");
  const apB = await adminAction(idB, "approve");
  const payoutB = apB.body.payout as { outcome?: string; providerReference?: string };
  check("B approve initiates (Telecel)", apB.status === 200 && payoutB?.outcome === "initiated", payoutB?.outcome ?? "?");
  const trfB = payoutB.providerReference as string;
  const stubAuditB = (await (await fetch(`${STUB_URL}/_stub/audit`)).json()) as {
    transfers: Record<string, { reference: string; amount: number }>;
    recipients: Record<string, { accountNumber: string; bankCode: string }>;
  };
  check("B stub amount exact (588 = 6.00 net)", stubAuditB.transfers[trfB]?.amount === 588, String(stubAuditB.transfers[trfB]?.amount));
  const balBeforeFail = await balanceOf(B.walletId);
  const failB = { event: "transfer.failed", data: { transfer_code: trfB, reference: refB, amount: 588, currency: "GHS", status: "failed" } };
  const cbF = await postCallback(failB, TEST_KEY);
  check("transfer.failed → refunded", cbF.status === 200 && cbF.body.status === "refunded", JSON.stringify(cbF.body).slice(0, 100));
  check("B wallet restored exactly (44 → 50)", balBeforeFail === 44 && (await balanceOf(B.walletId)) === 50, `before=${balBeforeFail} after=${await balanceOf(B.walletId)}`);
  check("B ledger failed (refunded)", ((await ledgerRow(refB))!).status === "failed");
  const cbFDupe = await postCallback(failB, TEST_KEY);
  check("duplicate failed is idempotent", cbFDupe.status === 200, `status ${cbFDupe.status}`);
  check("duplicate failed restores nothing more (still 50)", (await balanceOf(B.walletId)) === 50);

  // --- C8: transfer.reversed refunds exactly once (P13/P16) ------------------
  console.log("\n--- C8 transfer.reversed (P13/P16) ---");
  const wc = await withdraw(C.jar, { amount: "5", method: "momo_mtn", dest: C.phone, idempotencyKey: `pb-idem-${stamp}-c` });
  const refC = wc.body.ref as string;
  track.withdrawalRefs.push(refC);
  const idC = await wdIdOf(refC);
  const apC = await adminAction(idC, "approve");
  const trfC = (apC.body.payout as { providerReference: string }).providerReference;
  const revC = { event: "transfer.reversed", data: { transfer_code: trfC, reference: refC, amount: 490, currency: "GHS", status: "reversed" } };
  const cbR = await postCallback(revC, TEST_KEY);
  check("transfer.reversed → refunded", cbR.status === 200 && cbR.body.status === "refunded", JSON.stringify(cbR.body).slice(0, 100));
  check("C wallet restored exactly (25 → 30)", (await balanceOf(C.walletId)) === 30);
  const cbRDupe = await postCallback(revC, TEST_KEY);
  check("duplicate reversed is idempotent", cbRDupe.status === 200, `status ${cbRDupe.status}`);
  check("duplicate reversed restores nothing more (still 30)", (await balanceOf(C.walletId)) === 30);

  // --- C9: signature mandatory (P14) -----------------------------------------
  console.log("\n--- C9 signature mandatory (P14) ---");
  const wd = await withdraw(D.jar, { amount: "8", method: "momo_mtn", dest: D.phone, idempotencyKey: `pb-idem-${stamp}-d` });
  const refD = wd.body.ref as string;
  track.withdrawalRefs.push(refD);
  const idD = await wdIdOf(refD);
  const apD = await adminAction(idD, "approve");
  const trfD = (apD.body.payout as { providerReference: string }).providerReference;
  const excBefore = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions");
  const evil = { event: "transfer.success", data: { transfer_code: trfD, reference: refD, amount: 784, currency: "GHS", status: "success" } };
  const cbUnsigned = await postCallback(evil, null);
  check("unsigned callback → 401", cbUnsigned.status === 401, `status ${cbUnsigned.status}`);
  const cbWrongKey = await postCallback(evil, "sk_test_wrong_key_000");
  check("wrong-key callback → 401", cbWrongKey.status === 401, `status ${cbWrongKey.status}`);
  check("rejected callbacks change nothing (still processing)", ((await wdRow(refD))!).status === "processing");
  const excAfter = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions");
  check("rejected callbacks create no exceptions", (excAfter.rows[0]?.n as number) === (excBefore.rows[0]?.n as number));

  // --- C10: mismatches + unknown refs → exceptions (P18/P19) -----------------
  console.log("\n--- C10 mismatches + unknown refs (P18/P19) ---");
  const wrongAmt = { event: "transfer.success", data: { transfer_code: trfD, reference: refD, amount: 785, currency: "GHS", status: "success" } };
  const cbWA = await postCallback(wrongAmt, TEST_KEY);
  check("amount off-by-one → 400", cbWA.status === 400, `status ${cbWA.status}`);
  check("amount_mismatch exception created", (await exceptionCount("amount_mismatch", refD)) === 1);
  check("mismatched withdrawal stays processing", ((await wdRow(refD))!).status === "processing");
  check("mismatched ledger stays pending", ((await ledgerRow(refD))!).status === "pending");
  const wrongCur = { event: "transfer.success", data: { transfer_code: trfD, reference: refD, amount: 784, currency: "NGN", status: "success" } };
  const cbWC = await postCallback(wrongCur, TEST_KEY);
  check("currency mismatch → 400", cbWC.status === 400, `status ${cbWC.status}`);
  check("currency_mismatch exception created", (await exceptionCount("currency_mismatch", refD)) === 1);
  const unknown = { event: "transfer.success", data: { transfer_code: `TRF-PB-UNKNOWN-${stamp}`, reference: `WDL-PB-NOPE-${stamp}`, amount: 100, currency: "GHS", status: "success" } };
  const cbU = await postCallback(unknown, TEST_KEY);
  check("unknown provider reference → 404", cbU.status === 404, `status ${cbU.status}`);
  check("unknown_provider_reference exception created", (await exceptionCount("unknown_provider_reference")) >= 1);
  const other = { event: "charge.success", data: { reference: refD } };
  const excBeforeOther = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions");
  const cbOther = await postCallback(other, TEST_KEY);
  check("non-transfer event acked-and-ignored (200)", cbOther.status === 200 && cbOther.body.ignored === true, JSON.stringify(cbOther.body).slice(0, 80));
  const excAfterOther = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions");
  check("ignored event creates no exception", (excAfterOther.rows[0]?.n as number) === (excBeforeOther.rows[0]?.n as number));
  // The D withdrawal still settles correctly afterwards (mismatches are not terminal).
  const goodD = { event: "transfer.success", data: { transfer_code: trfD, reference: refD, amount: 784, currency: "GHS", status: "success" } };
  const cbD = await postCallback(goodD, TEST_KEY);
  check("correct callback after mismatches still settles", cbD.status === 200 && cbD.body.status === "successful", JSON.stringify(cbD.body).slice(0, 80));

  // --- C11: access control (P22/P23) ------------------------------------------
  console.log("\n--- C11 access control (P22/P23) ---");
  const anonList = await fetch(`${base}/api/wallet/withdrawals`);
  check("anon withdrawal list → 401", anonList.status === 401, `status ${anonList.status}`);
  const listA = (await (await A.jar.req(base, "/api/wallet/withdrawals")).json()) as { withdrawals: Array<{ ref: string }> };
  const listB = (await (await B.jar.req(base, "/api/wallet/withdrawals")).json()) as { withdrawals: Array<{ ref: string }> };
  const refsA = (listA.withdrawals ?? []).map((w) => w.ref);
  const refsB = (listB.withdrawals ?? []).map((w) => w.ref);
  check("A sees own withdrawal", refsA.includes(refA));
  check("B cannot see A's withdrawal", !refsB.includes(refA));
  check("A cannot see B's withdrawal", !refsA.includes(refB));
  const anonAdmin = await fetch(`${base}/api/admin/withdrawals/${idA}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) });
  check("anon admin action → 404 (no oracle)", anonAdmin.status === 404, `status ${anonAdmin.status}`);
  const userAdmin = await B.jar.req(base, `/api/admin/withdrawals/${idA}/action`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
  check("non-admin admin action → 404", userAdmin.status === 404, `status ${userAdmin.status}`);
  const anonRecon = await fetch(`${base}/api/admin/payout-reconciliation`);
  check("anon reconciliation → 404", anonRecon.status === 404, `status ${anonRecon.status}`);
  const userRecon = await B.jar.req(base, "/api/admin/payout-reconciliation");
  check("non-admin reconciliation → 404", userRecon.status === 404, `status ${userRecon.status}`);
  const adminAudit = await pool.query("select action, target_ref from admin_audit_logs where target_ref = $1", [refA]);
  check("approve audited in admin_audit_logs", adminAudit.rows.some((r) => r.action === "approve_withdrawal" && r.target_ref === refA));
  const wAudit = await pool.query("select event, actor_type, actor_id from withdrawal_audit_logs where withdrawal_ref = $1 order by id", [refA]);
  const wEvents = wAudit.rows.map((r) => r.event as string);
  check("withdrawal audit chain complete", ["created", "approved", "moved_to_processing", "marked_successful"].every((e) => wEvents.includes(e)), wEvents.join(","));
  check("provider callback attributed to provider", wAudit.rows.some((r) => r.event === "marked_successful" && r.actor_type === "provider"));

  // --- C12: reconciliation API (P20/P23) --------------------------------------
  console.log("\n--- C12 reconciliation API (P20/P23) ---");
  const we = await withdraw(A.jar, { amount: "12", method: "momo_mtn", dest: A.phone, idempotencyKey: `pb-idem-${stamp}-e` });
  const refE = we.body.ref as string;
  track.withdrawalRefs.push(refE);
  const idE = await wdIdOf(refE);
  await adminAction(idE, "approve");
  await pool.query("update withdrawal_requests set processed_at = now() - interval '25 hours' where ref = $1", [refE]);
  const balBeforeRecon = await balanceOf(A.walletId);
  const ledBeforeRecon = await pool.query("select ref, status::text as status from transactions where ref = any($1) order by ref", [track.withdrawalRefs]);
  const runRes = await adminJar.req(base, "/api/admin/payout-reconciliation", { method: "POST", body: JSON.stringify({ action: "run" }) });
  const runBody = (await runRes.json().catch(() => ({}))) as { ok?: boolean; examined?: number; newExceptions?: number };
  check("reconciliation run → 200", runRes.status === 200 && runBody.ok === true, `status ${runRes.status}`);
  check("stuck withdrawal flagged via API run", (await exceptionCount("stuck_processing", refE)) === 1);
  const runRes2 = await adminJar.req(base, "/api/admin/payout-reconciliation", { method: "POST", body: JSON.stringify({ action: "run" }) });
  const runBody2 = (await runRes2.json().catch(() => ({}))) as { ok?: boolean; newExceptions?: number };
  check("second run → 200 (idempotent)", runRes2.status === 200 && runBody2.ok === true, `new=${runBody2.newExceptions ?? "?"}`);
  const stuckTotal = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'stuck_processing'", [refE]);
  check("no duplicate stuck exception after rerun", (stuckTotal.rows[0]?.n as number) === 1, `n=${stuckTotal.rows[0]?.n}`);
  const listRes = await adminJar.req(base, "/api/admin/payout-reconciliation?type=stuck_processing&resolved=false");
  const listBody = (await listRes.json().catch(() => ({}))) as { ok?: boolean; data?: Array<{ withdrawal_ref: string }> };
  check("admin can list exceptions", listRes.status === 200 && (listBody.data ?? []).some((r) => r.withdrawal_ref === refE));
  const excRow = (await pool.query("select id from payout_reconciliation_exceptions where withdrawal_ref = $1 and exception_type = 'stuck_processing' and resolved = false", [refE])).rows[0];
  const resRes = await adminJar.req(base, "/api/admin/payout-reconciliation", { method: "POST", body: JSON.stringify({ action: "resolve", exceptionId: excRow.id, note: "suite resolved" }) });
  check("admin can resolve exception", resRes.status === 200, `status ${resRes.status}`);
  const resolvedRow = (await pool.query("select resolved, resolved_by, resolution_note from payout_reconciliation_exceptions where id = $1", [excRow.id])).rows[0];
  const adminId = Number((await pool.query("select id from users where email = $1", [ADMIN_EMAIL])).rows[0].id);
  check("resolution audited (by + note)", resolvedRow.resolved === true && Number(resolvedRow.resolved_by) === adminId && resolvedRow.resolution_note === "suite resolved");
  // NOTE: a still-stuck withdrawal legitimately re-flags on the NEXT run
  // after its exception was resolved (dedup is on *unresolved* rows) — that
  // re-fire path is covered by the focused reconciliation suite, not here.
  check("reconciliation run moves no money", (await balanceOf(A.walletId)) === balBeforeRecon);
  const ledAfterRecon = await pool.query("select ref, status::text as status from transactions where ref = any($1) order by ref", [track.withdrawalRefs]);
  check("reconciliation run touches no ledger rows", JSON.stringify(ledAfterRecon.rows) === JSON.stringify(ledBeforeRecon.rows));
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  await phaseA();

  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const baseUrl = (process.env.BASE_URL?.trim() ?? "").replace(/\/$/, "");

  if (baseUrl && process.env.ALLOW_PRODUCTION !== "1" && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)) {
    console.log(
      `\nRefusing to run: BASE_URL (${baseUrl}) does not look like a local test server (127.0.0.1 / localhost).\n` +
        "This script creates and deletes database rows; pass ALLOW_PRODUCTION=1 to force it.",
    );
    process.exit(2);
  }
  if (!databaseUrl) {
    note("Phase B skipped", "set DATABASE_URL to probe the database objects");
    note("Phase C skipped", "set DATABASE_URL + BASE_URL to drive the real API end to end");
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    const track: Track = { userEmails: [], walletIds: [], withdrawalRefs: [], depositRefs: [] };
    const protectedBefore = await protectedSnapshot(pool).catch(() => "unavailable");
    try {
      await phaseB(pool, track);
      if (!baseUrl) {
        note("Phase C skipped", "set BASE_URL to drive the real API end to end");
      } else {
        await phaseC(baseUrl, pool, track);
      }
    } finally {
      await cleanup(pool, track).catch((e) => note("cleanup warning", (e as Error)?.message ?? String(e)));
      const residue = await pool.query(
        "select (select count(*)::int from users where email like $1) as users, (select count(*)::int from withdrawal_requests where ref like 'WDL-PB-%') as wds",
        [`${PREFIX}%`],
      ).catch(() => null);
      if (residue) {
        check("no suite residue left behind", (residue.rows[0]?.users as number) === 0 && (residue.rows[0]?.wds as number) === 0, JSON.stringify(residue.rows[0]));
      }
      const protectedAfter = await protectedSnapshot(pool).catch(() => "unavailable");
      check("genuine deposit DP-MTMZN2P8SSBR byte-identical", protectedAfter === protectedBefore, protectedBefore === "absent" ? "absent in this DB (both)" : "compared");
      await pool.end().catch(() => undefined);
    }
  }

  console.log(`\n${checks} checks, ${failures} failures\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("suite crashed:", e);
  process.exit(1);
});
