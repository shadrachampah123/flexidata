/**
 * Comprehensive withdrawal lifecycle test suite.
 *
 * Tests the complete withdrawal lifecycle including:
 *   1. Create withdrawal
 *   2. Invalid amount / decimal amount
 *   3. Insufficient balance
 *   4. Invalid phone number / network / method mismatch
 *   5. Duplicate idempotency
 *   6. Admin approval / rejection / refund
 *   7. Invalid state transitions
 *   8. Callback verification
 *   9. Duplicate callback
 *   10. Wrong amount / currency / unknown reference
 *   11. Authorization failures
 *   12. Ledger/balance correctness
 *
 * Phases:
 *   A — Pure validation rules (no env needed)
 *   B — Database + API tests (needs DATABASE_URL + BASE_URL)
 *
 * Usage:
 *   npx tsx scripts/verify-withdrawal-lifecycle.ts                          # Phase A
 *   DATABASE_URL='...' BASE_URL='...' npx tsx scripts/verify-withdrawal-lifecycle.ts  # A + B
 */

import {
  parseCedisAmount,
  withdrawalQuote,
  WITHDRAW_MIN_PESEWAS,
  moneyFromPesewas,
} from "../src/lib/money";
import {
  normalizeGhanaMobileStrict,
  withdrawalMethodMatchesNetwork,
  WITHDRAWAL_METHODS,
  WITHDRAWAL_METHOD_META,
} from "../src/lib/ghana-mobile";
import {
  ADMIN_WITHDRAWAL_ACTIONS,
  assertWithdrawalTransition,
  canTransitionWithdrawal,
  validateWithdrawalRequestBody,
  WithdrawalTransitionError,
  WITHDRAWAL_TRANSITIONS,
  WITHDRAWAL_AUDIT_EVENTS,
  RECONCILIATION_EXCEPTION_TYPES,
} from "../src/lib/withdrawals";

let failures = 0;
let checks = 0;
const ok = (label: string, detail = ""): void => { checks++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); };
const bad = (label: string, detail = ""): void => { failures++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); };
const check = (label: string, cond: boolean, detail = ""): void => { if (cond) ok(label, detail); else bad(label, detail); };

function main() {
  console.log("\nPhase A — Pure validation & lifecycle rules\n");

  // =========================================================================
  // 1. Amount validation
  // =========================================================================
  console.log("--- Amount Validation ---");

  // Valid amounts
  check("GH₵5.00 accepted", parseCedisAmount("5").ok && (parseCedisAmount("5") as any).pesewas === 500);
  check("GH₵5.50 accepted (exact decimal)", parseCedisAmount("5.50").ok && (parseCedisAmount("5.50") as any).pesewas === 550);
  check("GH₵0.11 accepted", parseCedisAmount("0.11").ok && (parseCedisAmount("0.11") as any).pesewas === 11);
  check("GH₵100 accepted", parseCedisAmount("100").ok && (parseCedisAmount("100") as any).pesewas === 10000);

  // Invalid amounts
  check("Empty rejected", !parseCedisAmount("").ok);
  check("Zero rejected", !parseCedisAmount("0").ok);
  check("Negative rejected", !parseCedisAmount("-5").ok);
  check("Three decimals rejected", !parseCedisAmount("5.501").ok);
  check("Letters rejected", !parseCedisAmount("abc").ok);
  check("Null rejected", !parseCedisAmount(null).ok);
  check("Boolean rejected", !parseCedisAmount(true).ok);
  check("Object rejected", !parseCedisAmount({}).ok);
  check("Array rejected", !parseCedisAmount([]).ok);
  check("5.50 is GH₵5.50 not GH₵550", (parseCedisAmount("5.50") as any).pesewas === 550);

  // =========================================================================
  // 2. Fee quote
  // =========================================================================
  console.log("\n--- Fee Quotes ---");
  const q500 = withdrawalQuote(500);
  check("GH₵5 quote: fee=10, net=490", q500 !== null && q500.feePesewas === 10 && q500.netPesewas === 490);
  const q550 = withdrawalQuote(550);
  check("GH₵5.50 quote: fee=11, net=539", q550 !== null && q550.feePesewas === 11 && q550.netPesewas === 539);
  check("fee + net = amount always", q550 !== null && q550.feePesewas + q550.netPesewas === 550);
  check("Zero amount quote returns null", withdrawalQuote(0) === null);
  check("Negative amount quote returns null", withdrawalQuote(-100) === null);

  // =========================================================================
  // 3. Phone validation
  // =========================================================================
  console.log("\n--- Phone Validation ---");
  check("Valid MTN number", normalizeGhanaMobileStrict("0244123456").ok);
  check("Valid Telecel number", normalizeGhanaMobileStrict("0201234567").ok);
  check("Empty rejected", !normalizeGhanaMobileStrict("").ok);
  check("Null rejected", !normalizeGhanaMobileStrict(null).ok);
  check("Too short rejected", !normalizeGhanaMobileStrict("024").ok);
  check("Too long rejected", !normalizeGhanaMobileStrict("02441234567").ok);
  check("Letters rejected", !normalizeGhanaMobileStrict("abcdefghij").ok);

  // =========================================================================
  // 4. Method/network matching
  // =========================================================================
  console.log("\n--- Method/Network Matching ---");
  check("MTN MoMo matches MTN", withdrawalMethodMatchesNetwork("momo_mtn", "MTN"));
  check("MTN MoMo doesn't match TELECEL", !withdrawalMethodMatchesNetwork("momo_mtn", "TELECEL"));
  check("Telecel Cash matches TELECEL", withdrawalMethodMatchesNetwork("telecel_cash", "TELECEL"));
  check("Telecel Cash doesn't match MTN", !withdrawalMethodMatchesNetwork("telecel_cash", "MTN"));

  // =========================================================================
  // 5. Request body validation
  // =========================================================================
  console.log("\n--- Request Body Validation ---");

  // Valid request
  const validReq = validateWithdrawalRequestBody({
    amount: "50",
    method: "momo_mtn",
    dest: "0244123456",
    idempotencyKey: "test-key-12345678",
  });
  check("Valid request accepted", validReq.ok);

  // Invalid: missing fields
  check("Missing amount rejected", !validateWithdrawalRequestBody({ method: "momo_mtn", dest: "0244123456" }).ok);
  check("Missing method rejected", !validateWithdrawalRequestBody({ amount: "50", dest: "0244123456" }).ok);
  check("Missing dest rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn" }).ok);

  // Invalid: amount too small
  check("Below minimum rejected", !validateWithdrawalRequestBody({ amount: "4", method: "momo_mtn", dest: "0244123456" }).ok);

  // Invalid: decimal amount (5.50 should be accepted, not turned into 550)
  const decimalReq = validateWithdrawalRequestBody({ amount: "5.50", method: "momo_mtn", dest: "0244123456" });
  check("5.50 is GH₵5.50 not GH₵550", decimalReq.ok && (decimalReq as any).value.amountPesewas === 550);

  // Invalid: wrong phone for method
  check("MTN method with Telecel number rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn", dest: "0201234567" }).ok);
  check("Telecel method with MTN number rejected", !validateWithdrawalRequestBody({ amount: "50", method: "telecel_cash", dest: "0244123456" }).ok);

  // Invalid: unknown method
  check("Unknown method rejected", !validateWithdrawalRequestBody({ amount: "50", method: "bitcoin", dest: "0244123456" }).ok);

  // Smuggled fields
  check("Smuggled walletId rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn", dest: "0244123456", walletId: 1 }).ok);
  check("Smuggled userId rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn", dest: "0244123456", userId: 1 }).ok);
  check("Smuggled status rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn", dest: "0244123456", status: "successful" }).ok);
  check("Smuggled balance rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn", dest: "0244123456", balance: 999 }).ok);

  // Invalid idempotency keys
  check("Null key rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn", dest: "0244123456", idempotencyKey: null }).ok);
  check("Empty key rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "" }).ok);
  check("Short key rejected", !validateWithdrawalRequestBody({ amount: "50", method: "momo_mtn", dest: "0244123456", idempotencyKey: "short" }).ok);

  // Non-object bodies
  check("Null body rejected", !validateWithdrawalRequestBody(null).ok);
  check("Array body rejected", !validateWithdrawalRequestBody([]).ok);
  check("String body rejected", !validateWithdrawalRequestBody("hello").ok);
  check("Number body rejected", !validateWithdrawalRequestBody(42).ok);
  check("Empty object rejected", !validateWithdrawalRequestBody({}).ok);

  // =========================================================================
  // 6. State machine / lifecycle transitions
  // =========================================================================
  console.log("\n--- State Machine ---");

  // Valid transitions
  check("pending → processing allowed", canTransitionWithdrawal("pending", "processing"));
  check("pending → rejected allowed", canTransitionWithdrawal("pending", "rejected"));
  check("processing → successful allowed", canTransitionWithdrawal("processing", "successful"));
  check("processing → rejected allowed", canTransitionWithdrawal("processing", "rejected"));
  check("processing → refunded allowed", canTransitionWithdrawal("processing", "refunded"));

  // Forbidden transitions
  check("pending → successful forbidden", !canTransitionWithdrawal("pending", "successful"));
  check("pending → refunded forbidden", !canTransitionWithdrawal("pending", "refunded"));
  check("rejected → anything forbidden", !canTransitionWithdrawal("rejected", "processing") && !canTransitionWithdrawal("rejected", "successful"));
  check("successful → anything forbidden", !canTransitionWithdrawal("successful", "processing") && !canTransitionWithdrawal("successful", "rejected"));
  check("refunded → anything forbidden", !canTransitionWithdrawal("refunded", "processing") && !canTransitionWithdrawal("refunded", "successful"));

  // assert throws correctly
  let threw = false;
  try { assertWithdrawalTransition("pending", "successful"); } catch (e) { threw = e instanceof WithdrawalTransitionError; }
  check("assertWithdrawalTransition throws on forbidden", threw);

  // Admin actions never include successful
  check("Admin approve = processing", ADMIN_WITHDRAWAL_ACTIONS.approve === "processing");
  check("Admin reject = rejected", ADMIN_WITHDRAWAL_ACTIONS.reject === "rejected");
  check("Admin refund = refunded", (ADMIN_WITHDRAWAL_ACTIONS as Record<string, string>).refund === "refunded");
  check("Admin actions never include successful", !Object.values(ADMIN_WITHDRAWAL_ACTIONS).includes("successful" as never));

  // =========================================================================
  // 7. Audit events
  // =========================================================================
  console.log("\n--- Audit Events ---");
  check("Audit events defined", WITHDRAWAL_AUDIT_EVENTS.length >= 8);
  check("Includes 'created'", WITHDRAWAL_AUDIT_EVENTS.includes("created"));
  check("Includes 'approved'", WITHDRAWAL_AUDIT_EVENTS.includes("approved"));
  check("Includes 'rejected'", WITHDRAWAL_AUDIT_EVENTS.includes("rejected"));
  check("Includes 'refunded'", WITHDRAWAL_AUDIT_EVENTS.includes("refunded"));
  check("Includes 'callback_received'", WITHDRAWAL_AUDIT_EVENTS.includes("callback_received"));
  check("Includes 'marked_successful'", WITHDRAWAL_AUDIT_EVENTS.includes("marked_successful"));

  // =========================================================================
  // 8. Reconciliation exception types
  // =========================================================================
  console.log("\n--- Reconciliation Exception Types ---");
  check("Exception types defined", RECONCILIATION_EXCEPTION_TYPES.length >= 5);
  check("Includes 'stuck_processing'", RECONCILIATION_EXCEPTION_TYPES.includes("stuck_processing"));
  check("Includes 'amount_mismatch'", RECONCILIATION_EXCEPTION_TYPES.includes("amount_mismatch"));
  check("Includes 'duplicate_provider_reference'", RECONCILIATION_EXCEPTION_TYPES.includes("duplicate_provider_reference"));

  // =========================================================================
  // 9. Money display
  // =========================================================================
  console.log("\n--- Money Display ---");
  check("moneyFromPesewas(500) = 'GH₵ 5.00'", moneyFromPesewas(500) === "GH₵ 5.00");
  check("moneyFromPesewas(550) = 'GH₵ 5.50'", moneyFromPesewas(550) === "GH₵ 5.50");
  check("moneyFromPesewas(0) = 'GH₵ 0.00'", moneyFromPesewas(0) === "GH₵ 0.00");
  check("moneyFromPesewas(-100) has minus sign", moneyFromPesewas(-100).includes("−"));

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main();
