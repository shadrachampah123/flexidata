import "server-only";

import {
  isPaystackConfigured,
  paystackMode,
  paystackVerifyTransaction,
  PaystackConfigError,
  PaystackRequestError,
} from "@/lib/paystack";
import { clampText } from "@/lib/admin/redact";
import {
  diagnosePaystackProbe,
  summarizeFindings,
  type PaystackProbeView,
  type ProbeSubject,
} from "@/lib/admin/diagnosis";
import type {
  AdminPaystackProbeRefusal,
  AdminPaystackProbeResult,
} from "@/lib/admin/types";

/**
 * Phase 2, Step 3 (S3.6) — the READ-ONLY Paystack status probe.
 *
 * An investigator looking at an order parked by the verification-mismatch
 * guard, or a deposit left `pending` for a day, needs to know one thing: **what
 * does Paystack actually hold for this reference right now?** Until now the only
 * code that could answer that was `reconcileCheckoutOrder()` /
 * `reconcileDeposit()` — and both of those SETTLE: they run a conditional
 * UPDATE, increment a wallet balance and insert a ledger row. Asking the
 * question therefore moved money. This module answers the question without
 * touching anything.
 *
 * What it is:
 *  - one `GET /transaction/verify/:ref` call through the existing, audited
 *    Paystack client, and
 *  - a pure comparison of the answer against the stored values, using the SAME
 *    three predicates (reference, integer pesewas, currency) that
 *    `src/lib/checkout.ts` and `src/lib/deposits.ts` apply before they will
 *    settle anything.
 *
 * What it is NOT, and how that is guaranteed rather than promised:
 *  - **No database access at all.** This module does not import `@/db` or any
 *    table from `@/db/schema`; it cannot read or write a row. The stored values
 *    it compares against are passed IN by the caller (the route handler, which
 *    read them through `withReadOnlyTx`).
 *  - **No settlement path.** It imports exactly five symbols from
 *    `@/lib/paystack` — `paystackVerifyTransaction`, `paystackMode`,
 *    `isPaystackConfigured` and the two error classes — and nothing from
 *    `@/lib/deposits`, `@/lib/checkout`, `@/lib/payments` or
 *    `@/lib/data-gateway`. `reconcileDeposit`, `reconcileCheckoutOrder`,
 *    `settleAtomic`, `initPayment` and `submitDataBundleOrder` are unreachable
 *    from here, and the Step 3 harness asserts that by scanning this file.
 *  - **No key material.** Only `paystackMode()` ("test" | "live" |
 *    "unconfigured") is ever reported; the existing live-key lock
 *    (`PAYSTACK_LIVE_MODE`) is inherited unchanged, so a deployment that has not
 *    deliberately opted into live money refuses the probe.
 *  - **Bounded.** A per-administrator and per-reference token window throttles
 *    the outbound call, and the call itself is time-bounded so a hung gateway
 *    cannot pin an admin request.
 *
 * The throttle is in-memory and therefore best-effort per server instance —
 * there is no rate-limiting infrastructure in this codebase to hook into
 * (assessment L-6). It exists to stop a stuck button or a scripted client from
 * hammering the gateway with the secret key, not to be a security boundary; the
 * security boundary is the Phase 0 admin gate, which the route re-runs first.
 */

/** Sliding window the throttle counts inside. */
export const PROBE_WINDOW_MS = 5 * 60 * 1000;
/** Probes one administrator may run per window. */
export const PROBE_ADMIN_LIMIT = 10;
/** Probes one administrator may run for one reference per window. */
export const PROBE_REF_LIMIT = 3;
/** Longest we wait for Paystack before giving up on the request. */
export const PROBE_TIMEOUT_MS = 8_000;

/** Restated on every successful response so the payload cannot be misread. */
export const PROBE_NOTICE =
  "Diagnostic only — nothing was written, settled, credited, refunded or retried.";

type HitLog = Map<string, number[]>;

const adminHits: HitLog = new Map();
const refHits: HitLog = new Map();

function prune(hits: number[], windowStart: number): number[] {
  return hits.filter((at) => at >= windowStart);
}

function record(log: HitLog, key: string, now: number): void {
  log.set(key, [...prune(log.get(key) ?? [], now - PROBE_WINDOW_MS), now]);
}

/** Clear the throttle. Test-only; production never calls this. */
export function resetProbeThrottle(): void {
  adminHits.clear();
  refHits.clear();
}

export type ProbeThrottleDecision =
  | { allowed: true; retryAfterSeconds: null }
  | { allowed: false; retryAfterSeconds: number; scope: "admin" | "reference" };

/**
 * PURE throttle decision — exported so the harness can exercise the window
 * arithmetic directly (including its expiry) without waiting five minutes.
 */
export function probeThrottleDecision(input: {
  adminUserId: number;
  kind: ProbeSubject["kind"];
  ref: string;
  now: number;
  adminHits?: number[];
  refHits?: number[];
}): ProbeThrottleDecision {
  const windowStart = input.now - PROBE_WINDOW_MS;
  const admin = prune(input.adminHits ?? [], windowStart);
  const perRef = prune(input.refHits ?? [], windowStart);

  if (admin.length >= PROBE_ADMIN_LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((admin[0] + PROBE_WINDOW_MS - input.now) / 1000)),
      scope: "admin",
    };
  }
  if (perRef.length >= PROBE_REF_LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((perRef[0] + PROBE_WINDOW_MS - input.now) / 1000)),
      scope: "reference",
    };
  }
  return { allowed: true, retryAfterSeconds: null };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe-timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Ask Paystack what it holds for one reference and compare it with what we
 * stored. Returns a refusal instead of throwing, so the route can answer with a
 * clean status code and the operator sees a reason rather than a 500.
 *
 * @param adminUserId the acting administrator, from the server-side gate. Used
 *                    for throttling and for the server-side log line only — it
 *                    is never sent to Paystack and never persisted.
 */
export async function probePaystackStatus(input: {
  adminUserId: number;
  subject: ProbeSubject;
}): Promise<AdminPaystackProbeResult | AdminPaystackProbeRefusal> {
  const { adminUserId, subject } = input;
  const kind = subject.kind;
  const ref = subject.ref;

  if (!isPaystackConfigured()) {
    return {
      ok: false,
      kind,
      ref,
      error: "unavailable",
      message: "Paystack is not configured on this server, so there is nothing to ask it.",
    };
  }

  const now = Date.now();
  const decision = probeThrottleDecision({
    adminUserId,
    kind,
    ref,
    now,
    adminHits: adminHits.get(String(adminUserId)),
    refHits: refHits.get(`${adminUserId}:${kind}:${ref}`),
  });
  if (!decision.allowed) {
    return {
      ok: false,
      kind,
      ref,
      error: "throttled",
      message:
        decision.scope === "admin"
          ? `Too many Paystack status checks. Try again in ${decision.retryAfterSeconds}s.`
          : `This reference has already been checked ${PROBE_REF_LIMIT} times in the last five minutes. Try again in ${decision.retryAfterSeconds}s.`,
      retryAfterSeconds: decision.retryAfterSeconds,
    };
  }

  record(adminHits, String(adminUserId), now);
  record(refHits, `${adminUserId}:${kind}:${ref}`, now);

  const startedAt = Date.now();
  try {
    const verification = await withTimeout(paystackVerifyTransaction(ref), PROBE_TIMEOUT_MS);
    const elapsedMs = Date.now() - startedAt;

    const probe: PaystackProbeView = {
      status: verification.status,
      rawStatus: verification.rawStatus,
      reference: verification.reference,
      amountSubunits: verification.amountSubunits,
      currency: verification.currency,
      transactionId: verification.transactionId,
      channel: verification.channel,
      paidAt:
        verification.paidAt && !Number.isNaN(verification.paidAt.getTime())
          ? verification.paidAt.toISOString()
          : null,
      gatewayResponse: clampText(verification.gatewayResponse, 240),
    };

    const findings = diagnosePaystackProbe({ subject, probe });

    // Structured server-side log: who asked, about what, and what came back.
    // Never key material, never a full payload, never a customer email.
    console.info(
      `[flexidata:admin] paystack status probe (read-only) admin=${adminUserId} kind=${kind} ` +
        `ref=${ref} mode=${paystackMode()} status=${probe.status} elapsedMs=${elapsedMs}`,
    );

    return {
      ok: true,
      kind,
      ref,
      mode: paystackMode() === "live" ? "live" : "test",
      probedAt: new Date().toISOString(),
      elapsedMs,
      verification: probe,
      findings,
      verdict: summarizeFindings(findings),
      notice: PROBE_NOTICE,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;

    if (error instanceof PaystackConfigError) {
      // The message names environment variables, never values — but an admin
      // API response is not the place for deployment configuration detail, so
      // the specifics stay in the server log.
      console.warn(
        `[flexidata:admin] paystack status probe refused by configuration admin=${adminUserId} ` +
          `kind=${kind} ref=${ref}: ${error.message}`,
      );
      return {
        ok: false,
        kind,
        ref,
        error: "unavailable",
        message:
          "Paystack verification is locked on this deployment (the gateway configuration refuses the call). The detail is in the server log.",
      };
    }

    if (error instanceof Error && error.message === "probe-timeout") {
      console.warn(
        `[flexidata:admin] paystack status probe timed out admin=${adminUserId} kind=${kind} ` +
          `ref=${ref} elapsedMs=${elapsedMs}`,
      );
      return {
        ok: false,
        kind,
        ref,
        error: "timeout",
        message: `Paystack did not answer within ${PROBE_TIMEOUT_MS / 1000}s. Nothing was changed; try again shortly.`,
      };
    }

    if (error instanceof PaystackRequestError) {
      // Paystack's own public message plus the HTTP status — the client already
      // guarantees no headers, no request body and no key material.
      console.warn(
        `[flexidata:admin] paystack status probe failed admin=${adminUserId} kind=${kind} ` +
          `ref=${ref} elapsedMs=${elapsedMs}: ${error.message}`,
      );
      return {
        ok: false,
        kind,
        ref,
        error: "upstream",
        message: clampText(error.message, 240) ?? "Paystack could not confirm this reference.",
      };
    }

    console.error(
      `[flexidata:admin] paystack status probe error admin=${adminUserId} kind=${kind} ref=${ref}`,
      error,
    );
    return {
      ok: false,
      kind,
      ref,
      error: "upstream",
      message: "The Paystack status check could not be completed. Check the server logs.",
    };
  }
}
