import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { providerFloatBalances } from "@/db/schema";
import { toGhanaMsisdn } from "@/lib/format";
import { PROVIDER_FLOAT_TABLE, getSchemaCapabilities, isMissingRelationError } from "@/lib/schema-compat";

export type GatewayTxStatus = "successful" | "pending" | "failed" | "reversed";
export type GatewayFulfillmentStatus =
  | "queued"
  | "submitted"
  | "processing"
  | "delivered"
  | "failed"
  | "refunded";

type GatewayAuthType = "none" | "basic" | "bearer" | "headers";
type HttpMethod = "GET" | "POST";

type GatewayConfig = {
  provider: string;
  baseUrl: string | null;
  purchasePath: string;
  purchaseMethod: HttpMethod;
  balancePath: string | null;
  balanceMethod: HttpMethod;
  authType: GatewayAuthType;
  key: string | null;
  secret: string | null;
  token: string | null;
  accountId: string | null;
  callbackUrl: string | null;
  timeoutMs: number;
  syncFloatOnPurchase: boolean;
};

export type DataBundleOrder = {
  reference: string;
  walletId: number;
  network: "MTN" | "TELECEL";
  recipient: string;
  planLabel: string;
  category: string;
  providerProductCode: string;
  amount: number;
};

export type GatewayResult = {
  status: GatewayTxStatus;
  fulfillmentStatus: GatewayFulfillmentStatus;
  providerCode: string;
  providerReference: string | null;
  providerStatus: string | null;
  providerMessage: string | null;
  floatBalance: number | null;
  rawRequest: Record<string, unknown>;
  rawResponse: unknown;
};

export type StoredFloatBalance = {
  providerCode: string;
  network: string;
  availableBalance: number;
  reservedBalance: number;
  lowBalanceThreshold: number;
  lastSyncedAt: Date | null;
};

export class DataProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataProviderConfigError";
  }
}

export class DataProviderFloatError extends Error {
  constructor(
    message: string,
    readonly availableBalance: number | null,
  ) {
    super(message);
    this.name = "DataProviderFloatError";
  }
}

export class DataProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataProviderRequestError";
  }
}

function env(key: string): string | null {
  const value = process.env[key]?.trim();
  return value ? value : null;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value);
}

function envMethod(key: string, defaultValue: HttpMethod): HttpMethod {
  const value = process.env[key]?.trim().toUpperCase();
  return value === "GET" || value === "POST" ? value : defaultValue;
}

function envNumber(key: string, defaultValue: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

/**
 * Deterministic aggregator SKU for a plan, used when the database has no
 * `bundle_plans.provider_product_code` column (or it has not been populated
 * with real SKUs yet).
 */
export function deriveProviderProductCode(network: string, category: string, label: string): string {
  return `${network}-${category}-${label}`
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase();
}

export function getDataProviderCode(): string {
  return env("DATA_API_PROVIDER")?.toLowerCase() ?? "mock";
}

function getGatewayConfig(): GatewayConfig {
  const authType = (env("DATA_API_AUTH_TYPE")?.toLowerCase() ?? "headers") as GatewayAuthType;
  if (!["none", "basic", "bearer", "headers"].includes(authType)) {
    throw new DataProviderConfigError(
      "DATA_API_AUTH_TYPE must be one of: none, basic, bearer, headers.",
    );
  }

  return {
    provider: getDataProviderCode(),
    baseUrl: env("DATA_API_BASE_URL"),
    purchasePath: env("DATA_API_PURCHASE_PATH") ?? "/api/v1/data/purchase",
    purchaseMethod: envMethod("DATA_API_PURCHASE_METHOD", "POST"),
    balancePath: env("DATA_API_BALANCE_PATH"),
    balanceMethod: envMethod("DATA_API_BALANCE_METHOD", "GET"),
    authType,
    key: env("DATA_API_KEY"),
    secret: env("DATA_API_SECRET"),
    token: env("DATA_API_TOKEN"),
    accountId: env("DATA_API_ACCOUNT_ID"),
    callbackUrl: env("DATA_API_CALLBACK_URL"),
    timeoutMs: envNumber("DATA_API_TIMEOUT_MS", 20_000),
    syncFloatOnPurchase: envBool("DATA_API_SYNC_FLOAT_ON_PURCHASE", true),
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function buildHeaders(config: GatewayConfig): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  switch (config.authType) {
    case "basic": {
      if (!config.key || !config.secret) {
        throw new DataProviderConfigError("DATA_API_KEY and DATA_API_SECRET are required for basic auth.");
      }
      headers.Authorization = `Basic ${Buffer.from(`${config.key}:${config.secret}`).toString("base64")}`;
      break;
    }
    case "bearer": {
      const token = config.token ?? config.key;
      if (!token) {
        throw new DataProviderConfigError("DATA_API_TOKEN or DATA_API_KEY is required for bearer auth.");
      }
      headers.Authorization = `Bearer ${token}`;
      break;
    }
    case "headers": {
      if (!config.key) {
        throw new DataProviderConfigError("DATA_API_KEY is required when DATA_API_AUTH_TYPE=headers.");
      }
      headers["X-API-Key"] = config.key;
      if (config.secret) headers["X-API-Secret"] = config.secret;
      break;
    }
    case "none":
      break;
  }

  if (config.accountId) {
    headers["X-Account-Id"] = config.accountId;
  }

  return headers;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function readBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "ok", "success", "successful"].includes(normalized)) return true;
      if (["false", "0", "no", "failed", "error"].includes(normalized)) return false;
    }
    if (typeof value === "number") return value > 0;
  }
  return null;
}

function readNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function extractDataBlock(raw: unknown): Record<string, unknown> | null {
  const obj = readObject(raw);
  if (!obj) return null;
  return readObject(obj.data) ?? readObject(obj.result) ?? readObject(obj.response) ?? obj;
}

function extractMessage(raw: unknown): string | null {
  const obj = readObject(raw);
  if (!obj) return null;
  const data = extractDataBlock(raw);
  return readString(
    obj.message,
    obj.Message,
    obj.description,
    obj.ResponseMessage,
    data?.message,
    data?.description,
    data?.ResponseMessage,
  );
}

function extractProviderReference(raw: unknown): string | null {
  const obj = readObject(raw);
  if (!obj) return null;
  const data = extractDataBlock(raw);
  return readString(
    obj.providerReference,
    obj.transactionId,
    obj.TransactionId,
    obj.id,
    obj.reference,
    data?.providerReference,
    data?.transactionId,
    data?.TransactionId,
    data?.id,
    data?.reference,
  );
}

function extractStatusText(raw: unknown): string | null {
  const obj = readObject(raw);
  if (!obj) return null;
  const data = extractDataBlock(raw);
  return readString(
    obj.status,
    obj.Status,
    obj.state,
    obj.ResponseCode,
    obj.code,
    data?.status,
    data?.Status,
    data?.state,
    data?.ResponseCode,
    data?.code,
  );
}

function extractFloatBalance(raw: unknown): number | null {
  const obj = readObject(raw);
  if (!obj) return null;
  const data = extractDataBlock(raw);
  return readNumber(
    obj.floatBalance,
    obj.balance,
    obj.walletBalance,
    data?.floatBalance,
    data?.balance,
    data?.walletBalance,
  );
}

function normalizeStatus(
  raw: unknown,
  ok: boolean,
): Pick<GatewayResult, "status" | "fulfillmentStatus" | "providerStatus" | "providerMessage" | "providerReference" | "floatBalance"> {
  const successFlag = readBoolean(
    readObject(raw)?.ok,
    readObject(raw)?.success,
    readObject(raw)?.Success,
    extractDataBlock(raw)?.ok,
    extractDataBlock(raw)?.success,
  );
  const statusText = extractStatusText(raw)?.toLowerCase() ?? null;
  const message = extractMessage(raw);
  const providerReference = extractProviderReference(raw);
  const floatBalance = extractFloatBalance(raw);

  let status: GatewayTxStatus = "pending";
  let fulfillmentStatus: GatewayFulfillmentStatus = "processing";

  if (statusText?.includes("revers") || statusText?.includes("refund") || statusText?.includes("cancel")) {
    status = "reversed";
    fulfillmentStatus = "refunded";
  } else if (
    statusText?.includes("success") ||
    statusText?.includes("complete") ||
    statusText?.includes("deliver") ||
    statusText === "00" ||
    statusText === "ok"
  ) {
    status = "successful";
    fulfillmentStatus = "delivered";
  } else if (
    statusText?.includes("pend") ||
    statusText?.includes("queue") ||
    statusText?.includes("process") ||
    statusText?.includes("submit") ||
    statusText?.includes("accept")
  ) {
    status = "pending";
    fulfillmentStatus = statusText.includes("queue") || statusText.includes("submit") ? "submitted" : "processing";
  } else if (
    statusText?.includes("fail") ||
    statusText?.includes("error") ||
    statusText?.includes("declin") ||
    statusText?.includes("reject")
  ) {
    status = "failed";
    fulfillmentStatus = "failed";
  } else if (successFlag === true) {
    status = "successful";
    fulfillmentStatus = "delivered";
  } else if (successFlag === false || !ok) {
    status = "failed";
    fulfillmentStatus = "failed";
  }

  return {
    status,
    fulfillmentStatus,
    providerStatus: extractStatusText(raw),
    providerMessage: message,
    providerReference,
    floatBalance,
  };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let raw: unknown = text;

    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = { message: text };
      }
    } else {
      raw = {};
    }

    if (!response.ok) {
      const message = extractMessage(raw) ?? `Gateway request failed with HTTP ${response.status}`;
      return {
        ok: false,
        status: response.status,
        message,
        response: raw,
      };
    }

    return raw;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DataProviderConfigError(`Data gateway timed out after ${timeoutMs}ms.`);
    }
    throw new DataProviderRequestError(
      error instanceof Error ? error.message : "Could not reach the data gateway.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildPurchasePayload(order: DataBundleOrder, config: GatewayConfig): Record<string, unknown> {
  return {
    reference: order.reference,
    clientReference: order.reference,
    network: order.network,
    recipient: toGhanaMsisdn(order.recipient),
    amount: order.amount,
    bundleCode: order.providerProductCode,
    planLabel: order.planLabel,
    category: order.category,
    accountId: config.accountId,
    callbackUrl: config.callbackUrl,
    metadata: {
      walletId: order.walletId,
      source: "flexidata",
    },
  };
}

export async function submitDataBundleOrder(order: DataBundleOrder): Promise<GatewayResult> {
  const config = getGatewayConfig();
  const payload = buildPurchasePayload(order, config);

  if (config.provider === "mock") {
    const r = Math.random();
    const status: GatewayTxStatus = r < 0.9 ? "successful" : r < 0.98 ? "pending" : "failed";
    return {
      status,
      fulfillmentStatus:
        status === "successful" ? "delivered" : status === "pending" ? "submitted" : "failed",
      providerCode: config.provider,
      providerReference: `mock-${order.reference}`,
      providerStatus: status,
      providerMessage:
        status === "successful"
          ? "Mock data bundle delivered"
          : status === "pending"
            ? "Mock data order queued"
            : "Mock data order rejected",
      floatBalance: Math.max(0, 2_500 - order.amount),
      rawRequest: payload,
      rawResponse: {
        ok: status !== "failed",
        status,
        providerReference: `mock-${order.reference}`,
        floatBalance: Math.max(0, 2_500 - order.amount),
      },
    };
  }

  if (!config.baseUrl) {
    throw new DataProviderConfigError(
      "DATA_API_BASE_URL is required when DATA_API_PROVIDER is not set to mock.",
    );
  }

  const rawResponse = await fetchJson(
    joinUrl(config.baseUrl, config.purchasePath),
    {
      method: config.purchaseMethod,
      headers: buildHeaders(config),
      body: config.purchaseMethod === "POST" ? JSON.stringify(payload) : undefined,
    },
    config.timeoutMs,
  );

  const normalized = normalizeStatus(
    rawResponse,
    readObject(rawResponse)?.ok !== false && readObject(rawResponse)?.status !== 500,
  );

  return {
    ...normalized,
    providerCode: config.provider,
    rawRequest: payload,
    rawResponse,
  };
}

/**
 * Read the cached float row for a network. The ledger is optional by design: a
 * database that predates the gateway rollout has no `provider_float_balances`
 * table yet, and a missing ledger must never block a customer purchase —
 * `null` means "no float data available".
 */
export async function getStoredProviderFloatBalance(
  network: string,
): Promise<StoredFloatBalance | null> {
  const caps = await getSchemaCapabilities();
  if (!caps.floatTable) return null;

  const providerCode = getDataProviderCode();
  let rows: (typeof providerFloatBalances.$inferSelect)[];

  try {
    rows = await db
      .select()
      .from(providerFloatBalances)
      .where(
        and(
          eq(providerFloatBalances.providerCode, providerCode),
          eq(providerFloatBalances.network, network),
        ),
      )
      .limit(1);
  } catch (error) {
    if (isMissingRelationError(error)) {
      caps.floatTable = false;
      console.warn(
        `[flexidata] ${PROVIDER_FLOAT_TABLE} is not available yet; float tracking is disabled until the schema is pushed.`,
      );
      return null;
    }
    throw error;
  }

  const row = rows[0];
  if (!row) return null;

  return {
    providerCode: row.providerCode,
    network: row.network,
    availableBalance: Number(row.availableBalance),
    reservedBalance: Number(row.reservedBalance),
    lowBalanceThreshold: Number(row.lowBalanceThreshold),
    lastSyncedAt: row.lastSyncedAt,
  };
}

/**
 * Persist a float snapshot. Returns false when the ledger is unavailable, which
 * callers must treat as "skipped" rather than an error.
 */
export async function upsertProviderFloatBalance(input: {
  providerCode?: string;
  network: string;
  availableBalance: number;
  reservedBalance?: number;
  lowBalanceThreshold?: number;
  lastReference?: string | null;
  lastStatus?: string | null;
  notes?: string | null;
  lastSyncedAt?: Date | null;
}): Promise<boolean> {
  const caps = await getSchemaCapabilities();
  if (!caps.floatTable) return false;

  const providerCode = input.providerCode ?? getDataProviderCode();
  const now = new Date();

  const values = {
    providerCode,
    network: input.network,
    availableBalance: input.availableBalance.toFixed(2),
    reservedBalance: (input.reservedBalance ?? 0).toFixed(2),
    lowBalanceThreshold: (input.lowBalanceThreshold ?? 0).toFixed(2),
    lastReference: input.lastReference ?? null,
    lastStatus: input.lastStatus ?? null,
    notes: input.notes ?? null,
    lastSyncedAt: input.lastSyncedAt ?? now,
    updatedAt: now,
  };

  try {
    await db
      .insert(providerFloatBalances)
      .values(values)
      .onConflictDoUpdate({
        target: [providerFloatBalances.providerCode, providerFloatBalances.network],
        set: {
          availableBalance: values.availableBalance,
          reservedBalance: values.reservedBalance,
          lowBalanceThreshold: values.lowBalanceThreshold,
          lastReference: values.lastReference,
          lastStatus: values.lastStatus,
          notes: values.notes,
          lastSyncedAt: values.lastSyncedAt,
          updatedAt: values.updatedAt,
        },
      });
    return true;
  } catch (error) {
    if (isMissingRelationError(error)) {
      caps.floatTable = false;
      return false;
    }
    throw error;
  }
}

export async function syncProviderFloatBalance(network: "MTN" | "TELECEL"): Promise<number | null> {
  const config = getGatewayConfig();

  if (config.provider === "mock") {
    await upsertProviderFloatBalance({
      network,
      availableBalance: 2_500,
      reservedBalance: 0,
      lowBalanceThreshold: 300,
      lastStatus: "mock",
      notes: "Local mock gateway float snapshot",
      lastSyncedAt: new Date(),
    });
    return 2_500;
  }

  if (!config.baseUrl || !config.balancePath) return null;

  const url = new URL(joinUrl(config.baseUrl, config.balancePath));
  if (config.balanceMethod === "GET") {
    url.searchParams.set("network", network);
  }

  const raw = await fetchJson(
    url.toString(),
    {
      method: config.balanceMethod,
      headers: buildHeaders(config),
      body:
        config.balanceMethod === "POST"
          ? JSON.stringify({ network, accountId: config.accountId })
          : undefined,
    },
    config.timeoutMs,
  );

  const balance = extractFloatBalance(raw);
  if (balance == null) return null;

  const stored = await getStoredProviderFloatBalance(network);
  await upsertProviderFloatBalance({
    network,
    availableBalance: balance,
    reservedBalance: stored?.reservedBalance ?? 0,
    lowBalanceThreshold: stored?.lowBalanceThreshold ?? 0,
    lastStatus: extractStatusText(raw),
    notes: extractMessage(raw),
    lastSyncedAt: new Date(),
  });

  return balance;
}

export async function ensureProviderFloatCapacity(
  network: "MTN" | "TELECEL",
  amount: number,
): Promise<number | null> {
  const config = getGatewayConfig();
  if (config.syncFloatOnPurchase) {
    try {
      const synced = await syncProviderFloatBalance(network);
      if (synced != null && synced < amount) {
        throw new DataProviderFloatError(
          `Insufficient ${config.provider} float to complete this bundle purchase.`,
          synced,
        );
      }
      if (synced != null) return synced;
    } catch (error) {
      if (error instanceof DataProviderFloatError || error instanceof DataProviderConfigError) {
        throw error;
      }
      console.warn("float sync warning", error);
    }
  }

  const stored = await getStoredProviderFloatBalance(network);
  if (stored?.lastSyncedAt && stored.availableBalance < amount) {
    throw new DataProviderFloatError(
      `Insufficient ${stored.providerCode} float to complete this bundle purchase.`,
      stored.availableBalance,
    );
  }

  return stored?.availableBalance ?? null;
}

export async function projectProviderFloatUsage(input: {
  providerCode?: string;
  network: "MTN" | "TELECEL";
  amount: number;
  status: GatewayTxStatus;
  reference?: string | null;
  message?: string | null;
}): Promise<void> {
  const stored = await getStoredProviderFloatBalance(input.network);
  if (!stored) return;

  let availableBalance = stored.availableBalance;
  let reservedBalance = stored.reservedBalance;

  if (input.status === "successful") {
    availableBalance = Math.max(0, availableBalance - input.amount);
  } else if (input.status === "pending") {
    availableBalance = Math.max(0, availableBalance - input.amount);
    reservedBalance += input.amount;
  } else if (input.status === "reversed") {
    availableBalance += input.amount;
    reservedBalance = Math.max(0, reservedBalance - input.amount);
  } else {
    return;
  }

  await upsertProviderFloatBalance({
    providerCode: input.providerCode ?? stored.providerCode,
    network: input.network,
    availableBalance,
    reservedBalance,
    lowBalanceThreshold: stored.lowBalanceThreshold,
    lastReference: input.reference,
    lastStatus: input.status,
    notes: input.message,
    lastSyncedAt: stored.lastSyncedAt,
  });
}

export function normalizeCallbackStatus(payload: unknown): Pick<GatewayResult, "status" | "fulfillmentStatus" | "providerStatus" | "providerMessage" | "providerReference" | "floatBalance"> {
  return normalizeStatus(payload, true);
}

export function extractCallbackReference(payload: unknown): string | null {
  const obj = readObject(payload);
  if (!obj) return null;
  const data = extractDataBlock(payload);
  return readString(
    obj.reference,
    obj.clientReference,
    obj.externalId,
    obj.orderReference,
    data?.reference,
    data?.clientReference,
    data?.externalId,
    data?.orderReference,
  );
}

export function getWebhookSecret(): string | null {
  return env("DATA_API_WEBHOOK_SECRET");
}
