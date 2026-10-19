import "server-only";
import type { DataBundleOrder, GatewayResult } from "@/lib/data-gateway";

/**
 * Techlink is intentionally contract-injected. This module contains the
 * provider boundary and conservative lifecycle rules, but no endpoint paths,
 * payload fields, status strings, product IDs or callback rules. Those values
 * must come from an approved official Techlink contract before a production
 * contract object is added or the provider runtime guard is unlocked.
 */
export const TECHLINK_PROVIDER_CODE = "techlink" as const;

const MAX_REFERENCE_LENGTH = 120;
const MAX_STATUS_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 240;
const DEFAULT_TIMEOUT_MS = 20_000;

type TechlinkOutcome = "accepted" | "rejected" | "unknown";
type TechlinkLookupOutcome = "delivered" | "failed" | "pending" | "unknown";

export type TechlinkHttpRequest = {
  /** The method/path are supplied by the verified contract, never guessed here. */
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export type TechlinkHttpResponse = {
  status: number;
  body: unknown;
};

export type TechlinkRequestContext = {
  clientReference: string;
  providerReference?: string;
  /** The test secret is passed only to the contract's request builder. */
  apiKey: string;
};

export type TechlinkSubmission = {
  /** A submission response can never confirm delivery. */
  outcome: TechlinkOutcome;
  providerReference: string | null;
  providerStatus: string | null;
  providerMessage: string | null;
  /** Contract-owned, redacted audit data; never the raw HTTP body by default. */
  auditResponse: unknown;
};

export type TechlinkLookup = {
  outcome: TechlinkLookupOutcome;
  clientReference: string | null;
  providerReference: string | null;
  /** True only when the contract has verified this as authoritative. */
  trusted: boolean;
  providerStatus: string | null;
  providerMessage: string | null;
  /** Contract-owned, redacted audit data; never the raw HTTP body by default. */
  auditResponse: unknown;
};

export type TechlinkCallback = TechlinkLookup;

/**
 * The only place where a future verified Techlink API schema belongs. A
 * contract implementation must be written from official documentation and
 * reviewed separately; this generic module deliberately has no defaults.
 */
export type TechlinkContract = {
  buildSubmissionRequest: (
    order: DataBundleOrder,
    context: TechlinkRequestContext,
  ) => TechlinkHttpRequest;
  parseSubmission: (
    response: TechlinkHttpResponse,
    context: TechlinkRequestContext,
  ) => TechlinkSubmission;
  buildLookupRequest: (
    context: Required<Pick<TechlinkRequestContext, "clientReference" | "providerReference">> &
      Pick<TechlinkRequestContext, "apiKey">,
  ) => TechlinkHttpRequest;
  parseLookup: (
    response: TechlinkHttpResponse,
    context: Required<Pick<TechlinkRequestContext, "clientReference" | "providerReference">>,
  ) => TechlinkLookup;
  /** No callback is accepted unless the official contract defines verification. */
  verifyCallback?: (
    payload: unknown,
    context: Required<Pick<TechlinkRequestContext, "clientReference" | "providerReference">>,
  ) => TechlinkCallback | null;
};

export type TechlinkTransport = (
  request: TechlinkHttpRequest,
  baseUrl: string,
  timeoutMs: number,
) => Promise<TechlinkHttpResponse>;

export class TechlinkConfigurationError extends Error {
  constructor(message = "Techlink test adapter is unavailable until its verified contract and test configuration exist.") {
    super(message);
    this.name = "TechlinkConfigurationError";
  }
}

export class TechlinkTransportError extends Error {
  constructor() {
    // Never include URL, headers, provider messages, or exception text.
    super("Techlink request outcome is unresolved; do not resubmit automatically.");
    this.name = "TechlinkTransportError";
  }
}

export class TechlinkContractError extends Error {
  constructor() {
    // Contract/parser failures are deliberately generic and nonterminal.
    super("Techlink response could not be verified.");
    this.name = "TechlinkContractError";
  }
}

function cleanReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_REFERENCE_LENGTH ? trimmed : null;
}

function cleanStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_STATUS_LENGTH ? trimmed : null;
}

function cleanMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_MESSAGE_LENGTH) : null;
}

function cleanAudit(value: unknown, secret?: string): unknown {
  // Contract implementations must return already-redacted audit data. Keep the
  // boundary conservative for primitive messages and otherwise retain only a
  // shallow JSON-safe value supplied by the contract. Never retain a string
  // containing the configured credential, even if the contract misbehaves.
  const cleanString = (item: string): string | null => {
    if (secret && item.includes(secret)) return null;
    return item.slice(0, MAX_MESSAGE_LENGTH);
  };
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => {
      if (typeof item === "string") return cleanString(item);
      if (item === null || typeof item === "number" || typeof item === "boolean") return item;
      return null;
    });
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (/key|token|secret|authorization|password/i.test(key)) continue;
      if (item === null || typeof item === "number" || typeof item === "boolean") {
        output[key] = item;
      } else if (typeof item === "string") {
        const cleaned = cleanString(item);
        if (cleaned !== null) output[key] = cleaned;
      }
    }
    return output;
  }
  return null;
}

function isSuccessHttpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function requestBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

/** One request, no redirects, no retries, and no raw error propagation. */
export const fetchTechlinkTransport: TechlinkTransport = async (request, baseUrl, timeoutMs) => {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(request.path, base);
  } catch {
    throw new TechlinkConfigurationError("Techlink test base URL is invalid.");
  }
  if (base.protocol !== "https:" || target.origin !== base.origin) {
    throw new TechlinkConfigurationError("Techlink test transport requires one HTTPS origin.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.method === "POST" ? requestBody(request.body) : undefined,
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON or empty reply is malformed and will remain unresolved.
    }
    return { status: response.status, body };
  } catch {
    throw new TechlinkTransportError();
  } finally {
    clearTimeout(timer);
  }
};

function safeSubmission(value: unknown, secret: string): TechlinkSubmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Partial<TechlinkSubmission>;
  if (parsed.outcome !== "accepted" && parsed.outcome !== "rejected" && parsed.outcome !== "unknown") return null;
  return {
    outcome: parsed.outcome,
    providerReference: cleanReference(parsed.providerReference),
    providerStatus: cleanStatus(parsed.providerStatus),
    providerMessage: cleanMessage(parsed.providerMessage),
    auditResponse: cleanAudit(parsed.auditResponse, secret),
  };
}

function safeLookup(value: unknown, secret: string): TechlinkLookup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Partial<TechlinkLookup>;
  if (parsed.outcome !== "delivered" && parsed.outcome !== "failed" && parsed.outcome !== "pending" && parsed.outcome !== "unknown") return null;
  return {
    outcome: parsed.outcome,
    clientReference: cleanReference(parsed.clientReference),
    providerReference: cleanReference(parsed.providerReference),
    trusted: parsed.trusted === true,
    providerStatus: cleanStatus(parsed.providerStatus),
    providerMessage: cleanMessage(parsed.providerMessage),
    auditResponse: cleanAudit(parsed.auditResponse, secret),
  };
}

function pendingResult(
  providerReference: string | null,
  providerStatus: string | null,
  providerMessage: string,
  rawRequest: Record<string, unknown>,
  rawResponse: unknown,
): GatewayResult {
  return {
    status: "pending",
    fulfillmentStatus: "processing",
    providerCode: TECHLINK_PROVIDER_CODE,
    providerReference,
    providerStatus,
    providerMessage,
    floatBalance: null,
    rawRequest,
    rawResponse,
  };
}

function unknownLookupResult(providerReference: string, rawResponse: unknown): GatewayResult {
  return pendingResult(
    providerReference,
    "unknown",
    "Techlink outcome requires authoritative reconciliation; do not resubmit or refund.",
    {},
    rawResponse,
  );
}

export type TechlinkTestAdapter = {
  providerCode: typeof TECHLINK_PROVIDER_CODE;
  submit(order: DataBundleOrder): Promise<GatewayResult>;
  lookup(clientReference: string, providerReference: string): Promise<GatewayResult>;
  verifyCallback(clientReference: string, providerReference: string, payload: unknown): GatewayResult | null;
};

export function createTechlinkTestAdapter(input: {
  baseUrl: string;
  contract: TechlinkContract;
  transport?: TechlinkTransport;
  timeoutMs?: number;
}): TechlinkTestAdapter {
  if (process.env.NODE_ENV === "production") throw new TechlinkConfigurationError();
  const configuredApiKey = process.env.TECHLINK_TEST_API_KEY?.trim();
  if (!configuredApiKey) throw new TechlinkConfigurationError("TECHLINK_TEST_API_KEY is required for the disabled test adapter.");
  const apiKey: string = configuredApiKey;
  let base: URL;
  try {
    base = new URL(input.baseUrl);
  } catch {
    throw new TechlinkConfigurationError("Techlink test base URL is invalid.");
  }
  if (base.protocol !== "https:") throw new TechlinkConfigurationError("Techlink test base URL must use HTTPS.");
  const timeoutMs = Number.isFinite(input.timeoutMs) && (input.timeoutMs ?? 0) > 0
    ? Math.min(input.timeoutMs!, 30_000)
    : DEFAULT_TIMEOUT_MS;
  const transport = input.transport ?? fetchTechlinkTransport;

  async function submit(order: DataBundleOrder): Promise<GatewayResult> {
    let request: TechlinkHttpRequest;
    try {
      request = input.contract.buildSubmissionRequest(order, { clientReference: order.reference, apiKey });
    } catch {
      throw new TechlinkContractError();
    }
    let response: TechlinkHttpResponse;
    try {
      response = await transport(request, base.toString(), timeoutMs);
    } catch {
      return pendingResult(null, "unknown", "Techlink submission outcome is unresolved; do not resubmit automatically.", {}, {});
    }
    let parsed: TechlinkSubmission | null = null;
    try {
      parsed = safeSubmission(input.contract.parseSubmission(response, { clientReference: order.reference, apiKey }), apiKey);
    } catch {
      parsed = null;
    }
    if (!parsed || !isSuccessHttpStatus(response.status)) {
      return pendingResult(
        parsed?.providerReference ?? null,
        parsed?.outcome === "accepted" ? "accepted" : "unknown",
        "Techlink submission outcome is unresolved; do not resubmit automatically",
        {},
        parsed?.auditResponse ?? {},
      );
    }
    if (parsed.outcome === "rejected") {
      return {
        status: "failed",
        fulfillmentStatus: "failed",
        providerCode: TECHLINK_PROVIDER_CODE,
        providerReference: parsed.providerReference,
        providerStatus: "rejected",
        providerMessage: parsed.providerMessage,
        floatBalance: null,
        rawRequest: {},
        rawResponse: parsed.auditResponse,
      };
    }
    // Accepted/unknown submission responses are never delivery evidence.
    return pendingResult(
      parsed.providerReference,
      parsed.outcome === "accepted" ? "accepted" : "unknown",
      parsed.outcome === "accepted"
        ? parsed.providerMessage ?? "Techlink accepted the submission; delivery is not confirmed."
        : "Techlink submission outcome is unresolved; do not resubmit automatically.",
      {},
      parsed.auditResponse,
    );
  }

  async function lookup(clientReference: string, providerReference: string): Promise<GatewayResult> {
    const expectedClientReference = cleanReference(clientReference);
    const expectedProviderReference = cleanReference(providerReference);
    if (!expectedClientReference || !expectedProviderReference) {
      return unknownLookupResult(providerReference, {});
    }
    let request: TechlinkHttpRequest;
    try {
      request = input.contract.buildLookupRequest({
        clientReference: expectedClientReference,
        providerReference: expectedProviderReference,
        apiKey,
      });
    } catch {
      return unknownLookupResult(expectedProviderReference, {});
    }
    let response: TechlinkHttpResponse;
    try {
      response = await transport(request, base.toString(), timeoutMs);
    } catch {
      return unknownLookupResult(expectedProviderReference, {});
    }
    let parsed: TechlinkLookup | null = null;
    try {
      parsed = safeLookup(input.contract.parseLookup(response, {
        clientReference: expectedClientReference,
        providerReference: expectedProviderReference,
      }), apiKey);
    } catch {
      parsed = null;
    }
    if (!parsed || !isSuccessHttpStatus(response.status)) return unknownLookupResult(expectedProviderReference, parsed?.auditResponse ?? {});

    const correlated = parsed.clientReference === expectedClientReference &&
      parsed.providerReference === expectedProviderReference;
    if (!correlated || !parsed.trusted) return unknownLookupResult(expectedProviderReference, parsed.auditResponse);
    if (parsed.outcome === "delivered") {
      return {
        status: "successful",
        fulfillmentStatus: "delivered",
        providerCode: TECHLINK_PROVIDER_CODE,
        providerReference: expectedProviderReference,
        providerStatus: "delivered",
        providerMessage: parsed.providerMessage,
        floatBalance: null,
        rawRequest: {},
        rawResponse: parsed.auditResponse,
      };
    }
    if (parsed.outcome === "failed") {
      return {
        status: "failed",
        fulfillmentStatus: "failed",
        providerCode: TECHLINK_PROVIDER_CODE,
        providerReference: expectedProviderReference,
        providerStatus: "rejected",
        providerMessage: parsed.providerMessage,
        floatBalance: null,
        rawRequest: {},
        rawResponse: parsed.auditResponse,
      };
    }
    return pendingResult(
      expectedProviderReference,
      parsed.outcome === "pending" ? "accepted" : "unknown",
      parsed.providerMessage ?? "Techlink delivery is not terminally confirmed.",
      {},
      parsed.auditResponse,
    );
  }

  function verifyCallback(clientReference: string, providerReference: string, payload: unknown): GatewayResult | null {
    if (!input.contract.verifyCallback) return null;
    const expectedClientReference = cleanReference(clientReference);
    const expectedProviderReference = cleanReference(providerReference);
    if (!expectedClientReference || !expectedProviderReference) return null;
    let parsed: TechlinkCallback | null = null;
    try {
      parsed = safeLookup(input.contract.verifyCallback(payload, {
        clientReference: expectedClientReference,
        providerReference: expectedProviderReference,
      }), apiKey);
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.trusted || parsed.clientReference !== expectedClientReference || parsed.providerReference !== expectedProviderReference) return null;
    if (parsed.outcome === "delivered") {
      return {
        status: "successful", fulfillmentStatus: "delivered", providerCode: TECHLINK_PROVIDER_CODE,
        providerReference: expectedProviderReference, providerStatus: "delivered",
        providerMessage: parsed.providerMessage, floatBalance: null, rawRequest: {}, rawResponse: parsed.auditResponse,
      };
    }
    if (parsed.outcome === "failed") {
      return {
        status: "failed", fulfillmentStatus: "failed", providerCode: TECHLINK_PROVIDER_CODE,
        providerReference: expectedProviderReference, providerStatus: "rejected",
        providerMessage: parsed.providerMessage, floatBalance: null, rawRequest: {}, rawResponse: parsed.auditResponse,
      };
    }
    return pendingResult(expectedProviderReference, parsed.outcome === "pending" ? "accepted" : "unknown", "Techlink callback is not terminally confirmed.", {}, parsed.auditResponse);
  }

  return { providerCode: TECHLINK_PROVIDER_CODE, submit, lookup, verifyCallback };
}
