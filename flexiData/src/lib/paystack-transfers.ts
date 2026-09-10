import "server-only";

import {
  isPaystackConfigured,
  paystackApiRequest,
  PaystackConfigError,
  PaystackRequestError,
  PAYSTACK_CURRENCY,
} from "@/lib/paystack";
import {
  normalizeGhanaMobileStrict,
  WITHDRAWAL_METHOD_META,
  type WithdrawalMethod,
} from "@/lib/ghana-mobile";
import { parseCedisAmount } from "@/lib/money";
import { assertWithdrawalsEnabled } from "@/lib/withdrawal-flag";

export { PaystackConfigError, PaystackRequestError };

/**
 * Server-only Paystack Transfer (payout) client — Phase B.
 *
 * Every real-money payout in FlexiData goes through this module so that:
 *
 *  - Real Paystack transfer calls happen ONLY when the explicit production
 *    transfer flag is enabled (`PAYSTACK_TRANSFERS_ENABLED=true`) AND a
 *    Paystack secret key is configured. The flag defaults to OFF: without it,
 *    every function below refuses before touching the network.
 *  - The temporary withdrawal kill switch (`WITHDRAWALS_ENABLED`, see
 *    `src/lib/withdrawal-flag.ts`) additionally gates the three CREATION
 *    entries (`createMomoRecipient`, `createBankRecipient`,
 *    `initiateTransfer`): while it is not explicitly `true`, no transfer
 *    recipient is created and no transfer is initiated. Read-only entries
 *    (`fetchTransfer`, bank-code resolution) stay available so historical
 *    payouts keep reconciling while new payouts are paused.
 *  - The secret key stays inside `src/lib/paystack.ts` (`server-only`): this
 *    module never reads `process.env.PAYSTACK_SECRET_KEY` directly, never
 *    logs it, and never serialises it into an error.
 *  - Amounts are exact integer pesewas end to end (parsed once with the shared
 *    money module — never floats).
 *  - Recipients are validated server-side (strict Ghana mobile + method↔network
 *    match for mobile money; strict bank-code + account-number shape for banks).
 *  - Ambiguous outcomes (timeout / network failure / duplicate-reference on a
 *    retry) NEVER mint a new transfer reference: they throw
 *    {@link PaystackTransferAmbiguousError} so the caller keeps the withdrawal
 *    in `processing` under its SAME stable reference instead of creating a
 *    second transfer.
 *
 * Paystack API surface consumed (all server → Paystack, secret key):
 *   POST /transferrecipient  (create recipient → RCP_ code)
 *   POST /transfer           (initiate transfer → TRF_ code)
 *   GET  /transfer/:code     (fetch transfer status)
 *   GET  /bank               (resolve Ghana mobile-money / bank codes)
 */

/** Currency every FlexiData payout is sent in. */
export const PAYOUT_CURRENCY = PAYSTACK_CURRENCY;

/** Per-request timeout for Paystack transfer calls (ambiguous on expiry). */
export const PAYSTACK_TRANSFER_TIMEOUT_MS = 20_000;

/** Ghana mobile-money bank-code cache TTL (codes rarely change). */
const BANK_CODE_CACHE_MS = 6 * 60 * 60_000;

/**
 * Thrown when a transfer initiation reached an AMBIGUOUS outcome: the request
 * may or may not have created a transfer at Paystack (timeout, network failure,
 * or Paystack reporting our stable reference as already used). The caller MUST
 * NOT mint a new reference and MUST NOT re-initiate blindly — the withdrawal
 * stays in `processing` under the same reference until reconciled.
 */
export class PaystackTransferAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaystackTransferAmbiguousError";
  }
}

/**
 * Thrown when a payout destination fails server-side validation. Pure input
 * refusal — no network call is made and no reference is consumed.
 */
export class PaystackTransferValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaystackTransferValidationError";
  }
}

function envBool(key: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[key] ?? "").trim().toLowerCase());
}

/**
 * The explicit production transfer flag. Real Paystack transfer/recipient
 * calls are made ONLY when this is true. Defaults to false everywhere —
 * enabling real payouts is a deliberate deployment action.
 */
export function isPaystackTransfersEnabled(): boolean {
  return envBool("PAYSTACK_TRANSFERS_ENABLED") && isPaystackConfigured();
}

/**
 * Guard every real-money call. Throws before any network I/O unless the
 * explicit flag is on AND Paystack is configured (which itself enforces the
 * live-key lock). The error carries no key material.
 */
function assertTransfersEnabled(): void {
  if (!envBool("PAYSTACK_TRANSFERS_ENABLED")) {
    throw new PaystackConfigError(
      "Paystack transfers are disabled. Set PAYSTACK_TRANSFERS_ENABLED=true to enable real payouts.",
    );
  }
  if (!isPaystackConfigured()) {
    throw new PaystackConfigError(
      "Paystack is not configured on the server. Set PAYSTACK_SECRET_KEY in the environment.",
    );
  }
}

/** Wrap a Paystack call with the transfer timeout (ambiguous on expiry). */
async function transferRequest(
  path: string,
  init: RequestInit,
  context: string,
): Promise<Record<string, unknown>> {
  try {
    return await paystackApiRequest(
      path,
      { ...init, signal: AbortSignal.timeout(PAYSTACK_TRANSFER_TIMEOUT_MS) },
      context,
    );
  } catch (error) {
    if (error instanceof PaystackConfigError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // Timeouts and network failures are AMBIGUOUS for money movement: the
    // request may have reached Paystack and created the object.
    if (
      error instanceof PaystackRequestError &&
      /could not reach Paystack|timed out|timeout|abort|fetch failed|network/i.test(message)
    ) {
      throw new PaystackTransferAmbiguousError(`${context}: ambiguous outcome (${message})`);
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new PaystackTransferAmbiguousError(`${context}: timed out after ${PAYSTACK_TRANSFER_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Bank / mobile-money code resolution
// ---------------------------------------------------------------------------

export type GhanaBankEntry = { name: string; code: string };

let momoBankCache: { at: number; entries: GhanaBankEntry[] } | null = null;
let nubanBankCache: { at: number; entries: GhanaBankEntry[] } | null = null;

/** Test seam: forget cached bank codes. */
export function resetPaystackBankCodeCache(): void {
  momoBankCache = null;
  nubanBankCache = null;
}

async function listGhanaBanks(type: "mobile_money" | "nuban"): Promise<GhanaBankEntry[]> {
  const cached = type === "mobile_money" ? momoBankCache : nubanBankCache;
  if (cached && Date.now() - cached.at < BANK_CODE_CACHE_MS) return cached.entries;
  const body = await transferRequest(
    `/bank?currency=GHS&type=${type}`,
    { method: "GET" },
    "Paystack bank list",
  );
  const data = body.data;
  const entries: GhanaBankEntry[] = Array.isArray(data)
    ? data
        .filter(
          (row): row is Record<string, unknown> =>
            !!row && typeof row === "object" &&
            typeof (row as Record<string, unknown>).code === "string" &&
            typeof (row as Record<string, unknown>).name === "string",
        )
        .map((row) => ({
          name: (row.name as string).trim(),
          code: (row.code as string).trim(),
        }))
        .filter((row) => row.name !== "" && row.code !== "")
    : [];
  const fresh = { at: Date.now(), entries };
  if (type === "mobile_money") momoBankCache = fresh;
  else nubanBankCache = fresh;
  return entries;
}

/**
 * Resolve the Paystack mobile-money "bank" code for a withdrawal method's
 * network (e.g. MTN / Telecel on the Ghana mobile_money rail).
 *
 * Resolution order: explicit env pin (`PAYSTACK_MTN_BANK_CODE` /
 * `PAYSTACK_TELECEL_BANK_CODE`) → live `/bank` lookup matched by network name.
 * Nothing is hardcoded: Paystack owns these codes and they are read from
 * Paystack at runtime.
 */
export async function resolveMomoBankCode(method: WithdrawalMethod): Promise<string> {
  assertTransfersEnabled();
  const network = WITHDRAWAL_METHOD_META[method]?.network;
  if (!network) throw new PaystackTransferValidationError("Unsupported withdrawal method.");
  const pinned =
    network === "MTN"
      ? process.env.PAYSTACK_MTN_BANK_CODE?.trim()
      : process.env.PAYSTACK_TELECEL_BANK_CODE?.trim();
  if (pinned) return pinned;

  const entries = await listGhanaBanks("mobile_money");
  const needle = network.toLowerCase();
  const match = entries.find((entry) => {
    const name = entry.name.toLowerCase();
    if (needle === "mtn") return name.includes("mtn");
    return name.includes("telecel");
  });
  if (!match) {
    throw new PaystackTransferValidationError(
      `No Paystack mobile-money code found for ${network}. Set ${
        network === "MTN" ? "PAYSTACK_MTN_BANK_CODE" : "PAYSTACK_TELECEL_BANK_CODE"
      } explicitly.`,
    );
  }
  return match.code;
}

/**
 * Resolve + validate a Ghana bank (nuban rail) code. The code must exist in
 * Paystack's live `/bank` list unless explicitly pinned — an unknown code is
 * refused rather than sent.
 */
export async function resolveBankCode(bankCode: string): Promise<GhanaBankEntry> {
  assertTransfersEnabled();
  const code = bankCode.trim();
  if (!/^[0-9A-Za-z_-]{2,20}$/.test(code)) {
    throw new PaystackTransferValidationError("Invalid bank code.");
  }
  const pinnedName = process.env.PAYSTACK_BANK_NAME?.trim();
  const entries = await listGhanaBanks("nuban");
  const match = entries.find((entry) => entry.code.toLowerCase() === code.toLowerCase());
  if (!match) {
    throw new PaystackTransferValidationError(
      `Unknown Ghana bank code "${code}".${pinnedName ? "" : " Check the code and try again."}`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Transfer recipients
// ---------------------------------------------------------------------------

export type CreateMomoRecipientParams = {
  /** Withdrawal method — determines the network (server-side whitelist). */
  method: WithdrawalMethod;
  /** Destination digits in ANY accepted spelling; strictly normalized here. */
  destination: string;
  /** Account holder display name (server-derived, e.g. wallet name). */
  accountName: string;
};

export type CreateBankRecipientParams = {
  /** Ghana bank code (validated against Paystack's live bank list). */
  bankCode: string;
  /** Bank account number: digits only, 10–16 chars. */
  accountNumber: string;
  /** Account holder display name (server-derived). */
  accountName: string;
};

export type TransferRecipientResult = {
  recipientCode: string;
  type: "mobile_money" | "nuban";
  name: string;
};

function cleanAccountName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ").slice(0, 60);
  if (name.length < 2) throw new PaystackTransferValidationError("Invalid account name.");
  return name;
}

/**
 * Create a Ghana mobile-money transfer recipient (Paystack `mobile_money`
 * type). The destination is strictly normalized + method↔network matched
 * server-side — an invalid or mismatched destination throws BEFORE any
 * network call, consuming no reference and creating nothing at Paystack.
 */
export async function createMomoRecipient(
  params: CreateMomoRecipientParams,
): Promise<TransferRecipientResult> {
  // Temporary kill switch FIRST: no recipient while withdrawals are paused —
  // before the transfers-flag check and before any network I/O.
  assertWithdrawalsEnabled();
  assertTransfersEnabled();
  const network = WITHDRAWAL_METHOD_META[params.method]?.network;
  if (!network) throw new PaystackTransferValidationError("Unsupported withdrawal method.");
  const normalized = normalizeGhanaMobileStrict(params.destination, { networks: [network] });
  if (!normalized.ok) throw new PaystackTransferValidationError(normalized.error);
  const bankCode = await resolveMomoBankCode(params.method);
  const name = cleanAccountName(params.accountName);

  const body = await transferRequest(
    "/transferrecipient",
    {
      method: "POST",
      body: JSON.stringify({
        type: "mobile_money",
        name,
        account_number: normalized.msisdn10,
        bank_code: bankCode,
        currency: PAYOUT_CURRENCY,
      }),
    },
    "Paystack recipient creation",
  );
  const data = (body.data ?? {}) as Record<string, unknown>;
  const recipientCode = typeof data.recipient_code === "string" ? data.recipient_code.trim() : "";
  if (!recipientCode) {
    throw new PaystackRequestError("Paystack recipient creation failed: no recipient code returned.");
  }
  return { recipientCode, type: "mobile_money", name };
}

/**
 * Create a Ghana bank (nuban) transfer recipient. Strict server-side shape
 * validation; the bank code must exist in Paystack's live bank list.
 */
export async function createBankRecipient(
  params: CreateBankRecipientParams,
): Promise<TransferRecipientResult> {
  // Temporary kill switch FIRST: no recipient while withdrawals are paused —
  // before the transfers-flag check and before any network I/O.
  assertWithdrawalsEnabled();
  assertTransfersEnabled();
  const accountNumber = params.accountNumber.trim().replace(/[\s-]/g, "");
  if (!/^\d{10,16}$/.test(accountNumber)) {
    throw new PaystackTransferValidationError("Invalid bank account number.");
  }
  const bank = await resolveBankCode(params.bankCode);
  const name = cleanAccountName(params.accountName);

  const body = await transferRequest(
    "/transferrecipient",
    {
      method: "POST",
      body: JSON.stringify({
        type: "nuban",
        name,
        account_number: accountNumber,
        bank_code: bank.code,
        currency: PAYOUT_CURRENCY,
      }),
    },
    "Paystack recipient creation",
  );
  const data = (body.data ?? {}) as Record<string, unknown>;
  const recipientCode = typeof data.recipient_code === "string" ? data.recipient_code.trim() : "";
  if (!recipientCode) {
    throw new PaystackRequestError("Paystack recipient creation failed: no recipient code returned.");
  }
  return { recipientCode, type: "nuban", name };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export type InitiateTransferParams = {
  /** Exact integer pesewas to send (already validated by the caller). */
  amountPesewas: number;
  /** Paystack recipient code (RCP_…) from recipient creation. */
  recipientCode: string;
  /**
   * Stable, caller-owned reference — the withdrawal ref (e.g. `WDL-…`).
   * Reused verbatim on every retry of the same withdrawal; NEVER regenerated,
   * so Paystack itself dedupes double-submits and a timeout can never fork a
   * second transfer.
   */
  reference: string;
  /** Human-readable reason (server-derived, bounded length). */
  reason: string;
};

export type InitiateTransferResult = {
  /** Paystack's canonical transfer id (TRF_…) — stored as provider_reference. */
  transferCode: string;
  /** Our stable reference, echoed back. */
  reference: string;
  /** Raw Paystack status string (pending/success/otp/…). */
  rawStatus: string;
};

export type FetchTransferResult = {
  transferCode: string;
  reference: string | null;
  /** Raw Paystack status string. */
  rawStatus: string;
  /** Exact integer pesewas Paystack reports. */
  amountPesewas: number | null;
  currency: string | null;
  recipientCode: string | null;
};

/**
 * Initiate a Paystack transfer. The `reference` MUST be the withdrawal's
 * stable reference — this function never generates one.
 *
 * Definitive failures (4xx validation, insufficient balance, bad recipient)
 * throw `PaystackRequestError` (safe to surface as "payout failed", retryable
 * later under the SAME reference). Ambiguous outcomes (timeout, network
 * failure, or Paystack reporting the reference as already used) throw
 * `PaystackTransferAmbiguousError` — the caller must keep the SAME reference
 * and reconcile rather than re-initiate.
 */
export async function initiateTransfer(
  params: InitiateTransferParams,
): Promise<InitiateTransferResult> {
  // Temporary kill switch FIRST: no transfer while withdrawals are paused —
  // before the transfers-flag check and before any network I/O.
  assertWithdrawalsEnabled();
  assertTransfersEnabled();
  if (!Number.isInteger(params.amountPesewas) || params.amountPesewas <= 0) {
    throw new PaystackTransferValidationError("Invalid transfer amount.");
  }
  const recipientCode = params.recipientCode.trim();
  if (!recipientCode || recipientCode.length > 80) {
    throw new PaystackTransferValidationError("Invalid recipient code.");
  }
  const reference = params.reference.trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(reference)) {
    throw new PaystackTransferValidationError("Invalid transfer reference.");
  }
  const reason = params.reason.trim().slice(0, 100) || `FlexiData payout ${reference}`;

  let body: Record<string, unknown>;
  try {
    body = await transferRequest(
      "/transfer",
      {
        method: "POST",
        body: JSON.stringify({
          source: "balance",
          amount: params.amountPesewas,
          recipient: recipientCode,
          reason,
          reference,
          currency: PAYOUT_CURRENCY,
        }),
      },
      "Paystack transfer initiation",
    );
  } catch (error) {
    if (error instanceof PaystackTransferAmbiguousError) throw error;
    // "Reference already exists / already used": a previous attempt with this
    // SAME reference reached Paystack. That is ambiguous for us (we hold no
    // transfer_code) — never mint a new reference; reconcile instead.
    const message = error instanceof Error ? error.message : String(error);
    if (/reference.*(already|exist|used|duplicate)/i.test(message)) {
      throw new PaystackTransferAmbiguousError(
        `Paystack reports reference ${reference} as already used — a previous attempt may have created the transfer. Reconcile before retrying.`,
      );
    }
    throw error;
  }

  const data = (body.data ?? {}) as Record<string, unknown>;
  const transferCode = typeof data.transfer_code === "string" ? data.transfer_code.trim() : "";
  if (!transferCode) {
    // Paystack said OK but gave no transfer id — ambiguous, not a failure.
    throw new PaystackTransferAmbiguousError(
      "Paystack accepted the transfer but returned no transfer code.",
    );
  }
  return {
    transferCode,
    reference: typeof data.reference === "string" ? data.reference : reference,
    rawStatus: typeof data.status === "string" ? data.status : "pending",
  };
}

/**
 * Fetch a transfer's current state from Paystack by transfer code.
 * Read-only and safe to call any number of times (reconciliation, retries).
 */
export async function fetchTransfer(transferCode: string): Promise<FetchTransferResult> {
  assertTransfersEnabled();
  const code = transferCode.trim();
  if (!code || code.length > 80) {
    throw new PaystackTransferValidationError("Invalid transfer code.");
  }
  const body = await transferRequest(`/transfer/${encodeURIComponent(code)}`, { method: "GET" }, "Paystack transfer fetch");
  const data = (body.data ?? {}) as Record<string, unknown>;
  const amount = data.amount;
  return {
    transferCode: typeof data.transfer_code === "string" ? data.transfer_code : code,
    reference: typeof data.reference === "string" ? data.reference : null,
    rawStatus: typeof data.status === "string" ? data.status : "unknown",
    amountPesewas: typeof amount === "number" && Number.isInteger(amount) && amount >= 0 ? amount : null,
    currency: typeof data.currency === "string" ? data.currency : null,
    recipientCode:
      typeof (data.recipient as Record<string, unknown> | undefined)?.recipient_code === "string"
        ? ((data.recipient as Record<string, unknown>).recipient_code as string)
        : typeof data.recipient_code === "string"
          ? (data.recipient_code as string)
          : null,
  };
}

/**
 * Map a raw Paystack transfer status to the provider-neutral payout outcome.
 * Unknown statuses map to `pending` (never success): an outcome we do not
 * understand must never settle money.
 */
export function mapPaystackTransferStatus(rawStatus: string): "successful" | "failed" | "pending" | "reversed" {
  const s = rawStatus.trim().toLowerCase();
  if (s === "success" || s === "successful") return "successful";
  if (s === "failed" || s === "failure") return "failed";
  if (s === "reversed" || s === "reversal") return "reversed";
  // pending / processing / queued / otp / abandoned-at-provider / unknown:
  // "not settled yet" — the withdrawal stays in processing.
  return "pending";
}

/**
 * Exact GHS → pesewas conversion for payout amounts stored as `numeric(12,2)`
 * strings. Rejects anything inexact (never floats, never rounding).
 */
export function payoutCedisToPesewas(value: string): number {
  const parsed = parseCedisAmount(value);
  if (!parsed.ok) {
    throw new PaystackTransferValidationError(`Invalid payout amount: ${parsed.error}`);
  }
  return parsed.pesewas;
}
