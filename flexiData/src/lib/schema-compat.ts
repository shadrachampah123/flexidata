import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Schema compatibility helpers for the data gateway rollout.
 *
 * The gateway integration (fulfillment lifecycle, provider references and the
 * `provider_float_balances` table) widened the database schema, but the app is
 * often deployed before someone has had a chance to run `npx drizzle-kit push`
 * against the target database. Without a fallback, every request that touches
 * `transactions` or `bundle_plans` explodes with
 * `column "..." does not exist` / `relation "provider_float_balances" does not
 * exist`, which takes the whole app down with it.
 *
 * This module detects which gateway objects actually exist in the database and
 * lets callers degrade gracefully: skip the float ledger, name only the columns
 * that exist in a write, and retry after downgrading the cache when a probe
 * went stale or could not run.
 */

/** Optional columns the data gateway added to `transactions`. */
export const TRANSACTION_GATEWAY_FIELDS = {
  fulfillmentStatus: "fulfillment_status",
  provider: "provider",
  providerProductCode: "provider_product_code",
  providerReference: "provider_reference",
  providerStatus: "provider_status",
  providerMessage: "provider_message",
  fulfillmentAttempts: "fulfillment_attempts",
  chargedAt: "charged_at",
  fulfilledAt: "fulfilled_at",
  refundedAt: "refunded_at",
  lastProviderSyncAt: "last_provider_sync_at",
  providerPayload: "provider_payload",
  providerResponse: "provider_response",
} as const satisfies Record<string, string>;

/** Optional columns the data gateway added to `bundle_plans`. */
export const BUNDLE_PLAN_GATEWAY_FIELDS = {
  providerProductCode: "provider_product_code",
} as const satisfies Record<string, string>;

export const PROVIDER_FLOAT_TABLE = "provider_float_balances";

/**
 * Every writeable column of `transactions`, mapped from the Drizzle field name
 * to the SQL column name. Drizzle's `insert` always names all columns of the
 * table definition (using `default` for the ones not supplied), so a pre-gateway
 * database rejects it outright — the compatibility path builds the statement
 * from this map instead, listing only columns that really exist.
 */
export const TRANSACTION_INSERT_FIELDS = {
  ...TRANSACTION_GATEWAY_FIELDS,
  ref: "ref",
  walletId: "wallet_id",
  type: "type",
  status: "status",
  direction: "direction",
  title: "title",
  subtitle: "subtitle",
  amount: "amount",
  points: "points",
  network: "network",
  recipient: "recipient",
  createdAt: "created_at",
} as const satisfies Record<string, string>;

/** Writeable columns of `bundle_plans` (see {@link TRANSACTION_INSERT_FIELDS}). */
export const BUNDLE_PLAN_INSERT_FIELDS = {
  ...BUNDLE_PLAN_GATEWAY_FIELDS,
  id: "id",
  network: "network",
  category: "category",
  label: "label",
  validity: "validity",
  price: "price",
  retailPrice: "retail_price",
  badge: "badge",
  sortOrder: "sort_order",
} as const satisfies Record<string, string>;


type GatewayFieldMap = typeof TRANSACTION_GATEWAY_FIELDS | typeof BUNDLE_PLAN_GATEWAY_FIELDS;

export type GatewayTableName = "transactions" | "bundle_plans";

const GATEWAY_FIELDS: Record<GatewayTableName, GatewayFieldMap> = {
  transactions: TRANSACTION_GATEWAY_FIELDS,
  bundle_plans: BUNDLE_PLAN_GATEWAY_FIELDS,
};

const GATEWAY_COLUMNS: Record<GatewayTableName, string[]> = {
  transactions: Object.values(TRANSACTION_GATEWAY_FIELDS),
  bundle_plans: Object.values(BUNDLE_PLAN_GATEWAY_FIELDS),
};

/** `tx_status` values the gateway introduced; older enums only have the first three. */
const EXTENDED_TX_STATUS_VALUES = ["reversed"];

const MAX_SCHEMA_RETRIES = 3;

/** Postgres error codes that indicate the schema is behind, not a real failure. */
const MISSING_RELATION_CODES = new Set(["42P01"]);
const MISSING_COLUMN_CODES = new Set(["42703", "42704"]);
const INVALID_ENUM_VALUE_CODES = new Set(["22P02"]);

export type SchemaCapabilities = {
  /** False when the catalog probe could not run (DB unreachable, no privileges). */
  probed: boolean;
  /** Whether `provider_float_balances` exists and is queryable. */
  floatTable: boolean;
  /** Gateway columns that exist on `transactions`. */
  transactions: Set<string>;
  /** Gateway columns that exist on `bundle_plans`. */
  bundlePlans: Set<string>;
  /** Labels the `tx_status` enum accepts. Empty when unknown. */
  txStatusValues: Set<string>;
  /** When true the catalog was read but gateway objects are missing. */
  drifted: boolean;
  detectedAt: number;
};

type SchemaCompatState = {
  caps: SchemaCapabilities | null;
  probedAt: number;
  inflight: Promise<SchemaCapabilities> | null;
};

const globalForSchemaCompat = globalThis as typeof globalThis & {
  __flexidataSchemaCompat?: SchemaCompatState;
};

function state(): SchemaCompatState {
  globalForSchemaCompat.__flexidataSchemaCompat ??= {
    caps: null,
    probedAt: 0,
    inflight: null,
  };
  return globalForSchemaCompat.__flexidataSchemaCompat;
}

function envFlag(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value);
}

function envNumber(key: string, defaultValue: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

/** Set `DATA_API_SCHEMA_FALLBACKS=false` to fail loudly instead of degrading. */
export function schemaFallbacksEnabled(): boolean {
  return envFlag("DATA_API_SCHEMA_FALLBACKS", true);
}

function probeTtlMs(): number {
  return envNumber("DATA_API_SCHEMA_PROBE_MS", 60_000);
}

/** Failed probes are retried sooner so a transient outage doesn't pin optimistic caps. */
function retryProbeTtlMs(): number {
  return envNumber("DATA_API_SCHEMA_PROBE_RETRY_MS", 5_000);
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) return first as T[];
    if (first && typeof first === "object" && "rows" in first) {
      const rows = (first as { rows: unknown }).rows;
      return Array.isArray(rows) ? (rows as T[]) : [];
    }
    return result as T[];
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}

/**
 * Parse a Postgres array literal (`{a,b,"c d"}`) into a JS string array.
 * `node-postgres` does not convert `text[]` columns to JS arrays, so the
 * capability probe receives them as strings — without this parsing every
 * table looked empty and the app wrongly reported a "legacy" schema.
 */
function parsePgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== "{" || trimmed[trimmed.length - 1] !== "}") return [];
  const inner = trimmed.slice(1, -1);
  if (!inner) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(inner)) !== null) {
    out.push((match[1] ?? match[2] ?? "").replace(/\\"/g, '"').trim());
  }
  return out;
}

/**
 * Assume a fully migrated schema. Wrong guesses are self-healing: the first
 * query that fails with a schema error downgrades the cached capabilities.
 */
function optimisticCapabilities(): SchemaCapabilities {
  return {
    probed: false,
    floatTable: true,
    transactions: new Set(GATEWAY_COLUMNS.transactions),
    bundlePlans: new Set(GATEWAY_COLUMNS.bundle_plans),
    txStatusValues: new Set(["successful", "pending", "failed", ...EXTENDED_TX_STATUS_VALUES]),
    drifted: false,
    detectedAt: Date.now(),
  };
}

function columnsFor(table: GatewayTableName, present: string[]): Set<string> {
  const seen = new Set(present);
  return new Set(GATEWAY_COLUMNS[table].filter((column) => seen.has(column)));
}

async function probeCapabilities(): Promise<SchemaCapabilities> {
  const caps = optimisticCapabilities();

  try {
    const catalog = await db.execute(sql`
      select t.table_name as table_name,
             coalesce(array_agg(c.column_name), '{}'::text[]) as columns
      from (values ('transactions'), ('bundle_plans'), ('${sql.raw(PROVIDER_FLOAT_TABLE)}')) as t(table_name)
      left join information_schema.columns c
        on c.table_name = t.table_name
       and c.table_schema = current_schema()
      group by t.table_name
    `);

    const columnsByTable = new Map<string, string[]>();
    for (const row of asRows<{ table_name: string; columns: string[] | string | null }>(catalog)) {
      if (!row?.table_name) continue;
      columnsByTable.set(row.table_name, parsePgArray(row.columns));
    }

    const txColumns = columnsByTable.get("transactions") ?? [];
    const planColumns = columnsByTable.get("bundle_plans") ?? [];
    const floatColumns = columnsByTable.get(PROVIDER_FLOAT_TABLE) ?? [];

    caps.probed = true;
    caps.detectedAt = Date.now();
    caps.floatTable = floatColumns.length > 0;
    caps.transactions = columnsFor("transactions", txColumns);
    caps.bundlePlans = columnsFor("bundle_plans", planColumns);

    const enums = await db.execute(sql`
      select t.enum_name as enum_name,
             coalesce(array_agg(e.enumlabel), '{}'::text[]) as labels
      from (values ('tx_status')) as t(enum_name)
      left join pg_type ty
        on ty.typname = t.enum_name
      left join pg_enum e
        on e.enumtypid = ty.oid
      group by t.enum_name
    `);

    const labels = parsePgArray(asRows<{ enum_name: string; labels: string[] | string | null }>(enums)[0]?.labels);
    if (labels.length > 0) {
      caps.txStatusValues = new Set(labels);
    }

    caps.drifted =
      !caps.floatTable ||
      caps.transactions.size < GATEWAY_COLUMNS.transactions.length ||
      caps.bundlePlans.size < GATEWAY_COLUMNS.bundle_plans.length;
  } catch (error) {
    // The database may be down or the role may not be allowed to read the
    // catalog. Never let the probe mask the real error: keep optimistic
    // capabilities and let the query itself decide, with a retry as backup.
    console.warn("[flexidata] schema capability probe failed; assuming a current schema", error);
    caps.probed = false;
    caps.drifted = false;
  }

  return caps;
}

/** Everything the gateway writes is assumed available — used when fallbacks are off. */
function completeCapabilities(): SchemaCapabilities {
  return {
    probed: true,
    floatTable: true,
    transactions: new Set(GATEWAY_COLUMNS.transactions),
    bundlePlans: new Set(GATEWAY_COLUMNS.bundle_plans),
    txStatusValues: new Set(["successful", "pending", "failed", ...EXTENDED_TX_STATUS_VALUES]),
    drifted: false,
    detectedAt: Date.now(),
  };
}

export async function getSchemaCapabilities(): Promise<SchemaCapabilities> {
  // Strict mode never degrades: the app talks to the schema as documented and
  // any drift surfaces as a real error instead of a silent fallback.
  if (!schemaFallbacksEnabled()) return completeCapabilities();

  return resolveCapabilities();
}

async function resolveCapabilities(): Promise<SchemaCapabilities> {
  const cache = state();
  const ttl = cache.caps?.probed ? probeTtlMs() : retryProbeTtlMs();

  if (cache.caps && Date.now() - cache.probedAt < ttl) return cache.caps;
  if (cache.inflight) return cache.inflight;

  cache.inflight = probeCapabilities()
    .then((caps) => {
      cache.caps = caps;
      cache.probedAt = Date.now();
      return caps;
    })
    .finally(() => {
      cache.inflight = null;
    });

  return cache.inflight;
}

/** Drop cached capabilities (used after a migration, or by tests). */
export function resetSchemaCapabilitiesCache(): void {
  const cache = state();
  cache.caps = null;
  cache.probedAt = 0;
}

/**
 * Record drift discovered from a live query error so later requests skip the
 * gateway objects without waiting for the next probe.
 */
export function downgradeCapabilitiesFromError(
  caps: SchemaCapabilities,
  error: unknown,
): boolean {
  const message = readErrorMessage(error);
  let changed = false;

  for (const match of message.matchAll(/column\s+"?([a-z0-9_."]+)"?/gi)) {
    const raw = match[1]?.replace(/"/g, "");
    if (!raw) continue;
    const qualified = raw.includes(".");
    const tableGuess = qualified ? raw.slice(0, raw.lastIndexOf(".")) : null;
    const column = qualified ? raw.slice(raw.lastIndexOf(".") + 1) : raw;

    for (const table of Object.keys(GATEWAY_FIELDS) as GatewayTableName[]) {
      const columns = GATEWAY_COLUMNS[table];
      if (tableGuess && tableGuess !== table) continue;
      if (!columns.includes(column)) continue;

      // Postgres only names the first unknown column, and `drizzle-kit push`
      // applies the gateway columns as one unit, so treat the whole optional
      // group for that table as unavailable. That converges in a single retry
      // instead of chasing one column per failed statement.
      const set = table === "transactions" ? caps.transactions : caps.bundlePlans;
      if (set.size > 0) {
        set.clear();
        changed = true;
      }
    }
  }

  if (caps.floatTable) {
    for (const match of message.matchAll(/relation\s+"?([a-z0-9_.]+)"?/gi)) {
      const relation = match[1]?.split(".").pop();
      if (relation === PROVIDER_FLOAT_TABLE || relation?.endsWith(`.${PROVIDER_FLOAT_TABLE}`)) {
        caps.floatTable = false;
        changed = true;
      }
    }
  }

  const invalidEnum = message.match(/invalid input value for enum\s+"?([a-z0-9_]+)"?\s*:\s*"([^"]+)"/i);
  if (invalidEnum?.[1]?.toLowerCase() === "tx_status" && invalidEnum[2]) {
    if (caps.txStatusValues.delete(invalidEnum[2])) changed = true;
  }

  if (changed) {
    // A live query just proved the object is absent, so the capabilities are no
    // longer a guess — treat them as authoritative for the rest of this process.
    caps.probed = true;
    caps.drifted = true;
    caps.detectedAt = Date.now();
    state().probedAt = Date.now();
  }

  return changed;
}

const MAX_ERROR_CAUSE_DEPTH = 5;

/**
 * Drizzle wraps driver failures (e.g. `DrizzleQueryError`) and the Postgres
 * code/message we care about lives on `cause`, so classification has to walk
 * the whole chain rather than only the outermost error.
 */
function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH && current; depth += 1) {
    if (typeof current === "string") {
      chain.push({ message: current });
      break;
    }
    if (typeof current !== "object") break;
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }

  return chain;
}

function readErrorMessage(error: unknown): string {
  return errorChain(error)
    .map((entry) => (typeof entry.message === "string" ? entry.message : ""))
    .filter(Boolean)
    .join(" | ");
}

function readErrorCode(error: unknown): string | undefined {
  for (const entry of errorChain(error)) {
    if (typeof entry.code === "string") return entry.code;
  }
  return undefined;
}

export function isMissingRelationError(error: unknown): boolean {
  const code = readErrorCode(error);
  if (code && MISSING_RELATION_CODES.has(code)) return true;
  return /relation\s+"?[a-z0-9_.]+"?\s+does not exist/i.test(readErrorMessage(error));
}

export function isMissingColumnError(error: unknown): boolean {
  const code = readErrorCode(error);
  if (code && MISSING_COLUMN_CODES.has(code)) return true;
  return /column\s+"?[a-z0-9_."]+("?\s+does not exist|\s+of relation)/i.test(readErrorMessage(error));
}

export function isInvalidEnumValueError(error: unknown): boolean {
  const code = readErrorCode(error);
  if (code && INVALID_ENUM_VALUE_CODES.has(code)) return true;
  return /invalid input value for enum/i.test(readErrorMessage(error));
}

/** True when the failure is explained by an out-of-date schema. */
export function isSchemaIncompatibleError(error: unknown): boolean {
  return isMissingRelationError(error) || isMissingColumnError(error) || isInvalidEnumValueError(error);
}

export function hasTransactionColumn(caps: SchemaCapabilities, field: keyof typeof TRANSACTION_GATEWAY_FIELDS): boolean {
  return caps.transactions.has(TRANSACTION_GATEWAY_FIELDS[field]);
}

export function hasBundlePlanColumn(
  caps: SchemaCapabilities,
  field: keyof typeof BUNDLE_PLAN_GATEWAY_FIELDS,
): boolean {
  return caps.bundlePlans.has(BUNDLE_PLAN_GATEWAY_FIELDS[field]);
}

/** True when every listed gateway column on `transactions` is available. */
export function hasAllTransactionColumns(
  caps: SchemaCapabilities,
  fields: readonly (keyof typeof TRANSACTION_GATEWAY_FIELDS)[],
): boolean {
  return fields.every((field) => hasTransactionColumn(caps, field));
}

export function supportsTxStatusValue(caps: SchemaCapabilities, value: string): boolean {
  if (!caps.probed || caps.txStatusValues.size === 0) return true;
  return caps.txStatusValues.has(value);
}

/**
 * Remove keys whose columns are absent from the database, so an insert/update
 * built for the gateway schema still works on an older one.
 */
export function omitMissingGatewayColumns<T extends Record<string, unknown>>(
  caps: SchemaCapabilities,
  table: GatewayTableName,
  values: T,
): T {
  if (!caps.probed) return values;

  const present = table === "transactions" ? caps.transactions : caps.bundlePlans;
  const fields = GATEWAY_FIELDS[table];
  const next: Record<string, unknown> = { ...values };
  let dropped = false;

  for (const [field, column] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
    if (present.has(column)) continue;
    delete next[field];
    dropped = true;
  }

  return dropped ? (next as T) : values;
}

/**
 * Run a database operation with awareness of the live schema. The operation
 * receives the current capabilities so it can shape its own query, and is
 * retried with a downgraded view if Postgres reports drift we had not detected.
 */
export async function withSchemaFallback<T>(
  operation: (caps: SchemaCapabilities) => Promise<T>,
  label = "database operation",
): Promise<T> {
  const caps = await getSchemaCapabilities();

  try {
    return await operation(caps);
  } catch (error) {
    if (!schemaFallbacksEnabled() || !isSchemaIncompatibleError(error)) throw error;

    let changed = downgradeCapabilitiesFromError(caps, error);
    if (!changed) throw error;

    console.warn(
      `[flexidata] ${label} hit a missing schema object; retrying against the legacy gateway schema. ` +
        "Run `npx drizzle-kit push` to enable full provider fulfillment tracking.",
    );

    // Each retry drops another group of objects we have just learned are
    // missing, so a stale or impossible probe can still converge.
    for (let attempt = 0; attempt < MAX_SCHEMA_RETRIES; attempt += 1) {
      try {
        return await operation(caps);
      } catch (retryError) {
        if (!isSchemaIncompatibleError(retryError) || !downgradeCapabilitiesFromError(caps, retryError)) {
          throw retryError;
        }
      }
    }

    throw error;
  }
}

export type SchemaCompatibilityReport = {
  status: "current" | "legacy" | "unknown";
  fallbacks: "enabled" | "disabled";
  providerFloatTable: boolean;
  missingColumns: { transactions: string[]; bundlePlans: string[] };
  missingEnums: string[];
  missing: string[];
  hint?: string;
};

/**
 * True when the table can hold everything the gateway writes. When the probe
 * could not run we stay optimistic and let the query itself decide.
 */
export function isGatewaySchemaComplete(caps: SchemaCapabilities, table: GatewayTableName): boolean {
  if (!caps.probed) return true;
  const present = table === "transactions" ? caps.transactions : caps.bundlePlans;
  return GATEWAY_COLUMNS[table].every((column) => present.has(column));
}

/**
 * `INSERT` for a table that may be missing the gateway columns. Only columns
 * present in the database (and actually supplied) are named, so the statement
 * stays valid on both schema revisions.
 */
export function buildCompatInsert(
  caps: SchemaCapabilities,
  table: GatewayTableName,
  fields: Record<string, string>,
  rows: Record<string, unknown>[],
) {
  const gatewayColumns = new Set(GATEWAY_COLUMNS[table]);
  const present = table === "transactions" ? caps.transactions : caps.bundlePlans;

  const writable = Object.entries(fields).filter(
    ([, column]) => !gatewayColumns.has(column) || present.has(column),
  );
  const used = writable.filter(([field]) => rows.some((row) => row[field] !== undefined));

  if (used.length === 0) {
    throw new Error(`No writable columns left for ${table} after schema compatibility filtering.`);
  }

  const columnList = sql.join(
    used.map(([, column]) => sql.identifier(column)),
    sql`, `,
  );
  const tuples = rows.map(
    (row) => sql`(${sql.join(used.map(([field]) => sql`${row[field] ?? null}`), sql`, `)})`,
  );

  return sql`insert into ${sql.identifier(table)} (${columnList}) values ${sql.join(tuples, sql`, `)}`;
}

/** Human-readable drift summary, surfaced on `/api/health`. */
export async function describeSchemaCompatibility(): Promise<SchemaCompatibilityReport> {
  // Always probe for real: operators need the drift report even when the
  // runtime fallbacks are switched off.
  const caps = await resolveCapabilities();
  const fallbacks = schemaFallbacksEnabled() ? "enabled" : "disabled";

  if (!caps.probed) {
    return {
      status: "unknown",
      fallbacks,
      providerFloatTable: caps.floatTable,
      missingColumns: { transactions: [], bundlePlans: [] },
      missingEnums: [],
      missing: [],
    };
  }

  const missingTransactions = GATEWAY_COLUMNS.transactions.filter((column) => !caps.transactions.has(column));
  const missingPlans = GATEWAY_COLUMNS.bundle_plans.filter((column) => !caps.bundlePlans.has(column));
  const missingStatusValues = EXTENDED_TX_STATUS_VALUES.filter(
    (value) => caps.txStatusValues.size > 0 && !caps.txStatusValues.has(value),
  );

  const missing = [
    ...(caps.floatTable ? [] : [PROVIDER_FLOAT_TABLE]),
    ...missingTransactions.map((column) => `transactions.${column}`),
    ...missingPlans.map((column) => `bundle_plans.${column}`),
    ...missingStatusValues.map((value) => `tx_status:${value}`),
  ];

  return {
    status: missing.length > 0 ? "legacy" : "current",
    fallbacks,
    providerFloatTable: caps.floatTable,
    missingColumns: { transactions: missingTransactions, bundlePlans: missingPlans },
    missingEnums: missingStatusValues.map((value) => `tx_status:${value}`),
    missing,
    hint:
      missing.length > 0
        ? "Run `npx drizzle-kit push` against this database to enable full provider fulfillment tracking."
        : undefined,
  };
}
