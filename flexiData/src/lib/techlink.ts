import "server-only";
import { toGhanaMsisdn } from "@/lib/format";
import { normalizeGhanaMobileStrict } from "@/lib/ghana-mobile";
import type { DataBundleOrder, GatewayResult } from "@/lib/data-gateway";

/**
 * Techlink's verified server-only boundary. The official paths and payloads
 * below are limited to the contract supplied for this integration. Provider
 * status vocabulary and callback authenticity remain deliberately unresolved;
 * neither is guessed by this module.
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

export type TechlinkTransportFailureCategory = "timeout" | "network";

export class TechlinkTransportError extends Error {
  constructor(readonly category: TechlinkTransportFailureCategory = "network") {
    // Never include URL, headers, provider messages, or exception text.
    super(category === "timeout"
      ? "Techlink catalogue request timed out."
      : "Techlink catalogue request could not reach the provider.");
    this.name = "TechlinkTransportError";
  }
}

export class TechlinkContractError extends Error {
  constructor(readonly httpStatus: number | null = null) {
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
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
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
    throw new TechlinkTransportError(timedOut ? "timeout" : "network");
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

// ---------------------------------------------------------------------------
// Verified endpoint transport from the official contract supplied for this
// integration. The status vocabulary is intentionally not guessed: the
// Postman summary available to this runtime names the `status` field but does
// not provide its terminal values. Until those values are independently
// captured, verify responses remain unresolved.
// ---------------------------------------------------------------------------

export const TECHLINK_API_BASE_URL = "https://api.techlinkgh.com/api/v1";
export const TECHLINK_MODE = "sandbox" as const;

export type TechlinkRuntimeStatus = {
  safe: boolean;
  readOnlySafe: boolean;
  mode: "sandbox" | "unavailable";
  missing: Array<"mode" | "credentials" | "purchase_opt_in" | "rollout_approval">;
  warning: string;
};

const TECHLINK_PRODUCTION_WARNING =
  "Techlink fulfillment is disabled in production pending sandbox verification and rollout approval.";
const TECHLINK_CONFIG_WARNING =
  "Techlink requires TECHLINK_MODE=sandbox and a server-side TECHLINK_TEST_API_KEY.";
const TECHLINK_PURCHASE_WARNING =
  "Techlink catalogue reads are available, but purchase submission requires explicit sandbox opt-in.";
const TECHLINK_PREVIEW_WARNING =
  "Techlink Preview is read-only; purchase submission is disabled.";

/**
 * Vercel Preview functions run with NODE_ENV=production. Treat an explicit
 * Vercel Preview deployment as sandbox read-only, while keeping ordinary
 * production runtimes and Vercel Production deployments fail-closed.
 */
export function isTechlinkPreviewRuntime(): boolean {
  return process.env.VERCEL_ENV?.trim().toLowerCase() === "preview";
}

export function isTechlinkProductionRuntime(): boolean {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim().toLowerCase();
  return vercelEnvironment === "production" ||
    (process.env.NODE_ENV === "production" && vercelEnvironment !== "preview");
}

export function getTechlinkRuntimeStatus(): TechlinkRuntimeStatus {
  const preview = isTechlinkPreviewRuntime();
  if (isTechlinkProductionRuntime()) {
    return {
      safe: false,
      readOnlySafe: false,
      mode: "unavailable",
      missing: ["rollout_approval"],
      warning: TECHLINK_PRODUCTION_WARNING,
    };
  }
  const missing: TechlinkRuntimeStatus["missing"] = [];
  if (process.env.TECHLINK_MODE?.trim().toLowerCase() !== TECHLINK_MODE) missing.push("mode");
  if (!process.env.TECHLINK_TEST_API_KEY?.trim()) missing.push("credentials");
  const readOnlySafe = missing.length === 0;
  if (!readOnlySafe) {
    return { safe: false, readOnlySafe: false, mode: "unavailable", missing, warning: TECHLINK_CONFIG_WARNING };
  }
  if (preview || process.env.TECHLINK_ALLOW_PURCHASES?.trim().toLowerCase() !== "true") {
    missing.push("purchase_opt_in");
    return {
      safe: false,
      readOnlySafe: true,
      mode: "sandbox",
      missing,
      warning: preview ? TECHLINK_PREVIEW_WARNING : TECHLINK_PURCHASE_WARNING,
    };
  }
  return { safe: true, readOnlySafe: true, mode: "sandbox", missing: [], warning: "" };
}

type TechlinkConfigured = {
  baseUrl: string;
  apiKey: string;
};

function configuredTechlink(readOnly: boolean): TechlinkConfigured {
  const status = getTechlinkRuntimeStatus();
  if ((!readOnly && !status.safe) || (readOnly && !status.readOnlySafe)) {
    throw new TechlinkConfigurationError(status.warning);
  }
  const apiKey = process.env.TECHLINK_TEST_API_KEY?.trim();
  if (!apiKey) throw new TechlinkConfigurationError(TECHLINK_CONFIG_WARNING);
  return { baseUrl: `${TECHLINK_API_BASE_URL}/`, apiKey };
}

export type TechlinkApiFailureCategory =
  | "authentication"
  | "authorization"
  | "rate_limited"
  | "http_status"
  | "provider_rejected";

export class TechlinkApiError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
    readonly category: TechlinkApiFailureCategory = "http_status",
  ) {
    super(message);
    this.name = "TechlinkApiError";
  }
}

export type TechlinkApiFailureDiagnostic = {
  category: TechlinkApiFailureCategory;
  code:
    | "techlink_authentication_failed"
    | "techlink_authorization_failed"
    | "techlink_rate_limited"
    | "techlink_http_error"
    | "techlink_provider_rejected";
  message: string;
  upstreamStatus: number;
  /** HTTP status exposed by FlexiData for this upstream failure. */
  responseStatus: 502 | 503;
};

/**
 * Convert provider failure metadata into a safe operator/client diagnostic.
 * This intentionally contains only a category and HTTP status: never provider
 * response text, the request URL, the recipient phone, or the API key.
 */
export function describeTechlinkApiError(error: TechlinkApiError): TechlinkApiFailureDiagnostic {
  const responseStatus: 502 | 503 = error.httpStatus === 401 ? 503 : 502;
  switch (error.category) {
    case "authentication":
      return {
        category: error.category,
        code: "techlink_authentication_failed",
        message: "Techlink authentication failed",
        upstreamStatus: error.httpStatus,
        responseStatus,
      };
    case "authorization":
      return {
        category: error.category,
        code: "techlink_authorization_failed",
        message: "Techlink authorization failed",
        upstreamStatus: error.httpStatus,
        responseStatus,
      };
    case "rate_limited":
      return {
        category: error.category,
        code: "techlink_rate_limited",
        message: "Techlink rate limit reached",
        upstreamStatus: error.httpStatus,
        responseStatus,
      };
    case "provider_rejected":
      return {
        category: error.category,
        code: "techlink_provider_rejected",
        message: "Techlink rejected the catalogue request",
        upstreamStatus: error.httpStatus,
        responseStatus,
      };
    case "http_status":
      return {
        category: error.category,
        code: "techlink_http_error",
        message: "Techlink returned an upstream HTTP error",
        upstreamStatus: error.httpStatus,
        responseStatus,
      };
  }
}

export type TechlinkTransportFailureDiagnostic = {
  category: TechlinkTransportFailureCategory;
  code: "techlink_timeout" | "techlink_network_failure";
  message: string;
  upstreamStatus: null;
  responseStatus: 503;
};

export function describeTechlinkTransportError(error: TechlinkTransportError): TechlinkTransportFailureDiagnostic {
  if (error.category === "timeout") {
    return {
      category: error.category,
      code: "techlink_timeout",
      message: "Techlink catalogue request timed out",
      upstreamStatus: null,
      responseStatus: 503,
    };
  }
  return {
    category: error.category,
    code: "techlink_network_failure",
    message: "Techlink catalogue provider could not be reached",
    upstreamStatus: null,
    responseStatus: 503,
  };
}

export type TechlinkContractFailureDiagnostic = {
  category: "contract";
  code: "techlink_response_invalid";
  message: "Techlink catalogue response could not be verified";
  upstreamStatus: number | null;
  responseStatus: 502;
};

export function describeTechlinkContractError(error: TechlinkContractError): TechlinkContractFailureDiagnostic {
  return {
    category: "contract",
    code: "techlink_response_invalid",
    message: "Techlink catalogue response could not be verified",
    upstreamStatus: error.httpStatus,
    responseStatus: 502,
  };
}

export class TechlinkCatalogueError extends Error {
  constructor(message = "The current Techlink catalogue does not contain the requested bundle.") {
    super(message);
    this.name = "TechlinkCatalogueError";
  }
}

export type TechlinkBundle = {
  id: string;
  name: string;
  size: string;
  price: number;
  validity: string;
};

export type TechlinkCatalogue = {
  provider: string;
  bundles: TechlinkBundle[];
};

function apiObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function apiString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function apiNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function apiBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isTechlinkNetwork(value: unknown): value is DataBundleOrder["network"] {
  return value === "MTN" || value === "TELECEL";
}

function normalizeTechlinkPhone(value: string): string {
  const normalized = normalizeGhanaMobileStrict(value);
  if (!normalized.ok) throw new TechlinkCatalogueError("A valid Ghana mobile number is required for Techlink.");
  return toGhanaMsisdn(normalized.msisdn10);
}

function requestPath(path: string, query?: Record<string, string>): string {
  const relativePath = path.replace(/^\/+/, "");
  const url = new URL(relativePath, TECHLINK_API_BASE_URL.endsWith("/") ? TECHLINK_API_BASE_URL : `${TECHLINK_API_BASE_URL}/`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

async function officialRequest(
  config: TechlinkConfigured,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<TechlinkHttpResponse> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "x-api-key": config.apiKey,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetchTechlinkTransport({ method, path, headers, body }, config.baseUrl, DEFAULT_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof TechlinkConfigurationError || error instanceof TechlinkTransportError) throw error;
    throw new TechlinkTransportError("network");
  }
}

function responseObject(response: TechlinkHttpResponse): Record<string, unknown> {
  const body = apiObject(response.body);
  if (!body) throw new TechlinkContractError(response.status);
  return body;
}

function categoryForTechlinkHttpStatus(status: number): TechlinkApiFailureCategory {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 429) return "rate_limited";
  return "http_status";
}

function ensureSuccessEnvelope(response: TechlinkHttpResponse): Record<string, unknown> {
  // Classify the HTTP response before parsing the body. An upstream 401/403/
  // other error may be HTML or empty, but its status is still safe and useful
  // diagnostic evidence; it must not be downgraded to a generic schema error.
  if (!isSuccessHttpStatus(response.status)) {
    const category = categoryForTechlinkHttpStatus(response.status);
    throw new TechlinkApiError(response.status, response.status === 401
      ? "Techlink authentication was rejected."
      : "Techlink request was not accepted.", category);
  }
  const body = responseObject(response);
  if (apiBoolean(body.success) !== true) {
    throw new TechlinkApiError(response.status, "Techlink returned an unsuccessful response.", "provider_rejected");
  }
  return body;
}

function parseCatalogue(response: TechlinkHttpResponse): TechlinkCatalogue {
  const body = ensureSuccessEnvelope(response);
  if (!Array.isArray(body.bundles) || !apiString(body.provider, 80)) throw new TechlinkContractError(response.status);
  const bundles: TechlinkBundle[] = [];
  for (const raw of body.bundles) {
    const item = apiObject(raw);
    const id = apiString(item?.id, MAX_REFERENCE_LENGTH);
    const name = apiString(item?.name, 120);
    const size = apiString(item?.size, 80);
    const price = apiNumber(item?.price);
    const validity = apiString(item?.validity, 80);
    if (!id || !name || !size || price === null || price < 0 || !validity) throw new TechlinkContractError(response.status);
    bundles.push({ id, name, size, price, validity });
  }
  return { provider: apiString(body.provider, 80)!, bundles };
}

/** Read-only live catalogue call. It never creates an order. */
export async function fetchTechlinkCatalogue(network: DataBundleOrder["network"], phone: string): Promise<TechlinkCatalogue> {
  if (!isTechlinkNetwork(network)) throw new TechlinkCatalogueError("Unsupported Techlink network.");
  const config = configuredTechlink(true);
  const response = await officialRequest(config, "GET", requestPath("/data/bundles", {
    network,
    phone: normalizeTechlinkPhone(phone),
  }));
  return parseCatalogue(response);
}

/** Resolve only an exact ID returned by the current live catalogue. */
export async function fetchTechlinkBundle(
  network: DataBundleOrder["network"],
  phone: string,
  bundleId: string,
): Promise<TechlinkBundle> {
  const wanted = apiString(bundleId, MAX_REFERENCE_LENGTH);
  if (!wanted) throw new TechlinkCatalogueError();
  const catalogue = await fetchTechlinkCatalogue(network, phone);
  const bundle = catalogue.bundles.find((candidate) => candidate.id === wanted);
  if (!bundle) throw new TechlinkCatalogueError();
  return bundle;
}

export type TechlinkOrderEnvelope = {
  httpStatus: number;
  body: Record<string, unknown>;
};

/** Read-only order history for operator/reconciliation tooling. */
export async function fetchTechlinkOrderHistory(page = 1, limit = 25): Promise<TechlinkOrderEnvelope> {
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 25;
  const config = configuredTechlink(true);
  const response = await officialRequest(config, "GET", requestPath("/orders", {
    page: String(safePage),
    limit: String(safeLimit),
  }));
  if (!isSuccessHttpStatus(response.status)) throw new TechlinkApiError(response.status, "Techlink order history request was not accepted.");
  return { httpStatus: response.status, body: responseObject(response) };
}

/** Read-only single-order lookup. */
export async function fetchTechlinkOrder(orderId: string): Promise<TechlinkOrderEnvelope> {
  const id = apiString(orderId, MAX_REFERENCE_LENGTH);
  if (!id) throw new TechlinkCatalogueError("A valid Techlink order ID is required.");
  const config = configuredTechlink(true);
  const response = await officialRequest(config, "GET", requestPath(`/orders/${encodeURIComponent(id)}`));
  if (!isSuccessHttpStatus(response.status)) throw new TechlinkApiError(response.status, "Techlink order lookup was not accepted.");
  return { httpStatus: response.status, body: responseObject(response) };
}

export type TechlinkVerification = {
  orderId: string;
  status: string;
  changed: boolean | null;
  message: string | null;
  success: boolean | null;
};

/**
 * Verify an order with the documented POST endpoint. No request body is added:
 * the documented contract identifies the order in the path and does not define
 * additional POST fields.
 */
export async function verifyTechlinkOrder(orderId: string): Promise<TechlinkVerification> {
  const id = apiString(orderId, MAX_REFERENCE_LENGTH);
  if (!id) throw new TechlinkCatalogueError("A valid Techlink order ID is required.");
  const config = configuredTechlink(true);
  const response = await officialRequest(config, "POST", requestPath(`/orders/${encodeURIComponent(id)}/verify`));
  if (!isSuccessHttpStatus(response.status)) throw new TechlinkApiError(response.status, "Techlink order verification was not accepted.");
  const body = responseObject(response);
  const responseOrderId = apiString(body.orderId, MAX_REFERENCE_LENGTH);
  const status = apiString(body.status, MAX_STATUS_LENGTH);
  const changed = apiBoolean(body.changed);
  const success = apiBoolean(body.success);
  const message = apiString(body.message, MAX_MESSAGE_LENGTH);
  if (!responseOrderId || responseOrderId !== id || !status || changed === null || success === null || !message) {
    throw new TechlinkContractError(response.status);
  }
  return {
    orderId: responseOrderId,
    status,
    changed,
    message,
    success,
  };
}

export type TechlinkStatusClassification = "delivered" | "failed" | "pending" | "unknown";
export type TechlinkStatusClassifier = (providerStatus: string) => TechlinkStatusClassification;

/**
 * The status strings are deliberately supplied by the verified contract rather
 * than guessed here. Until the exact Postman status vocabulary is captured,
 * this default keeps every verify response unresolved.
 */
export const unresolvedTechlinkStatus: TechlinkStatusClassifier = () => "unknown";

export function techlinkVerificationResult(
  reference: string,
  verification: TechlinkVerification,
  classify: TechlinkStatusClassifier = unresolvedTechlinkStatus,
): GatewayResult {
  const classification = verification.success === true ? classify(verification.status) : "unknown";
  const common = {
    providerCode: TECHLINK_PROVIDER_CODE,
    providerReference: verification.orderId,
    providerStatus: verification.status.slice(0, MAX_STATUS_LENGTH),
    providerMessage: verification.message,
    floatBalance: null,
    rawRequest: {},
    rawResponse: cleanAudit({
      orderId: verification.orderId,
      status: verification.status,
      changed: verification.changed,
      message: verification.message,
      success: verification.success,
    }),
  } satisfies Pick<GatewayResult, "providerCode" | "providerReference" | "providerStatus" | "providerMessage" | "floatBalance" | "rawRequest" | "rawResponse">;
  if (classification === "delivered") return { ...common, status: "successful", fulfillmentStatus: "delivered" };
  if (classification === "failed") return { ...common, status: "failed", fulfillmentStatus: "failed" };
  return { ...common, status: "pending", fulfillmentStatus: "processing" };
}

/** Reconciliation lookup with conservative unresolved default. */
export async function lookupTechlinkSandbox(
  reference: string,
  providerReference: string,
  classify: TechlinkStatusClassifier = unresolvedTechlinkStatus,
): Promise<GatewayResult> {
  const verification = await verifyTechlinkOrder(providerReference);
  if (verification.orderId !== providerReference) {
    return {
      status: "pending",
      fulfillmentStatus: "processing",
      providerCode: TECHLINK_PROVIDER_CODE,
      providerReference,
      providerStatus: "unknown",
      providerMessage: "Techlink order correlation could not be verified.",
      floatBalance: null,
      rawRequest: {},
      rawResponse: {},
    };
  }
  return techlinkVerificationResult(reference, verification, classify);
}

/**
 * Submit exactly one purchase request. HTTP 201 + success/orderId means
 * accepted/pending, never delivered. A response with no authoritative order ID
 * remains unresolved so the lifecycle will not resubmit it.
 */
export async function submitTechlinkPurchase(order: DataBundleOrder): Promise<GatewayResult> {
  const config = configuredTechlink(false);
  if (!isTechlinkNetwork(order.network) || !apiString(order.providerProductCode, MAX_REFERENCE_LENGTH)) {
    throw new TechlinkContractError();
  }
  const phone = normalizeTechlinkPhone(order.recipient);
  let response: TechlinkHttpResponse;
  try {
    response = await officialRequest(config, "POST", requestPath("/data/purchase"), {
      network: order.network,
      phone: phone,
      bundleId: order.providerProductCode,
    });
  } catch {
    return {
      status: "pending",
      fulfillmentStatus: "processing",
      providerCode: TECHLINK_PROVIDER_CODE,
      providerReference: null,
      providerStatus: "unknown",
      providerMessage: "Techlink submission outcome is unresolved; do not resubmit automatically.",
      floatBalance: null,
      rawRequest: {},
      rawResponse: {},
    };
  }
  let body: Record<string, unknown>;
  try {
    body = responseObject(response);
  } catch {
    return {
      status: "pending", fulfillmentStatus: "processing", providerCode: TECHLINK_PROVIDER_CODE,
      providerReference: null, providerStatus: "unknown",
      providerMessage: "Techlink submission response could not be verified.", floatBalance: null,
      rawRequest: {}, rawResponse: {},
    };
  }
  const success = apiBoolean(body.success);
  const orderId = apiString(body.orderId, MAX_REFERENCE_LENGTH);
  const message = apiString(body.message, MAX_MESSAGE_LENGTH);
  const newBalance = apiNumber(body.newBalance);
  const audit = cleanAudit({ success, message, orderId, newBalance });
  if (response.status === 201 && success === true && orderId && message && newBalance !== null) {
    return {
      status: "pending", fulfillmentStatus: "processing", providerCode: TECHLINK_PROVIDER_CODE,
      providerReference: orderId, providerStatus: "accepted", providerMessage: message ?? "Techlink accepted the order; delivery is not confirmed.",
      floatBalance: null, rawRequest: { network: order.network, phone: phone, bundleId: order.providerProductCode }, rawResponse: audit,
    };
  }
  if (success === false && !orderId && response.status >= 400 && response.status < 500) {
    return {
      status: "failed", fulfillmentStatus: "failed", providerCode: TECHLINK_PROVIDER_CODE,
      providerReference: null, providerStatus: "rejected", providerMessage: message ?? "Techlink rejected the order.",
      floatBalance: null, rawRequest: { network: order.network, phone: phone, bundleId: order.providerProductCode }, rawResponse: audit,
    };
  }
  return {
    status: "pending", fulfillmentStatus: "processing", providerCode: TECHLINK_PROVIDER_CODE,
    providerReference: orderId, providerStatus: "unknown",
    providerMessage: "Techlink submission outcome is unresolved; do not resubmit automatically.",
    floatBalance: null, rawRequest: { network: order.network, phone: phone, bundleId: order.providerProductCode }, rawResponse: audit,
  };
}
