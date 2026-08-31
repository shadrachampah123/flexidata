/**
 * Shared simulation used by the schema-compatibility verification scripts.
 *
 * `installSim()` swaps `pg.Pool` for an in-memory stand-in that enforces which
 * tables / columns / enum labels exist, so the app's real route handlers can be
 * driven against a database that has — or has not — received the data-gateway
 * schema. Drizzle's own behaviour is preserved: it names every column of the
 * table definition in an INSERT (emitting `default`) and maps rows positionally
 * with `rowMode: "array"`.
 */
process.env.DATABASE_URL ??= "postgresql://harness:harness@localhost:5432/harness";
process.env.DATA_API_PROVIDER = "mock";
process.env.DATA_API_SCHEMA_PROBE_MS = "600000";

type Schema = {
  tables: Record<string, string[]>;
  enums: Record<string, string[]>;
};

export const BASE_TX = [
  "id",
  "ref",
  "wallet_id",
  "type",
  "status",
  "direction",
  "title",
  "subtitle",
  "amount",
  "points",
  "network",
  "recipient",
  "created_at",
];
export const GATEWAY_TX = [
  "fulfillment_status",
  "provider",
  "provider_product_code",
  "provider_reference",
  "provider_status",
  "provider_message",
  "fulfillment_attempts",
  "charged_at",
  "fulfilled_at",
  "refunded_at",
  "last_provider_sync_at",
  "provider_payload",
  "provider_response",
];
export const BASE_PLANS = [
  "id",
  "network",
  "category",
  "label",
  "validity",
  "price",
  "retail_price",
  "badge",
  "sort_order",
];
export const FLOAT_COLS = [
  "id",
  "provider_code",
  "network",
  "currency",
  "available_balance",
  "reserved_balance",
  "low_balance_threshold",
  "last_reference",
  "last_status",
  "notes",
  "last_synced_at",
  "created_at",
  "updated_at",
];
const WALLETS = [
  "id",
  "user_id",
  "name",
  "number",
  "balance",
  "points",
  "is_agent",
  "agent_tier",
  "referral_code",
  "created_at",
];
const USERS = [
  "id",
  "name",
  "email",
  "phone",
  "password_hash",
  "referral_code",
  "referred_by",
  "referral_rewarded_at",
  "email_verified_at",
  "notify_promos",
  "notify_tx",
  "is_admin",
  "created_at",
  "updated_at",
];
const SESSIONS = [
  "id",
  "user_id",
  "token_hash",
  "user_agent",
  "ip",
  "last_seen_at",
  "created_at",
  "expires_at",
];
const PASSWORD_RESETS = ["id", "user_id", "token_hash", "used_at", "expires_at", "created_at"];
const DEPOSIT_REQUESTS = [
  "id",
  "ref",
  "wallet_id",
  "provider",
  "method",
  "amount",
  "status",
  "provider_reference",
  "initiated_at",
  "completed_at",
  "provider_payload",
  "created_at",
];


export const SIM_TABLES = { BASE_TX, GATEWAY_TX, BASE_PLANS, FLOAT_COLS };

function makeSimSchema(migrated: boolean): Schema {
const schema: Schema = {
  tables: {
    wallets: WALLETS,
    users: USERS,
    sessions: SESSIONS,
    password_resets: PASSWORD_RESETS,
    deposit_requests: DEPOSIT_REQUESTS,
    transactions: migrated ? [...BASE_TX, ...GATEWAY_TX] : [...BASE_TX],
    bundle_plans: migrated ? [...BASE_PLANS, "provider_product_code"] : [...BASE_PLANS],
    provider_float_balances: migrated ? FLOAT_COLS : [],
    price_alerts: ["id", "network", "title", "body", "tag", "active", "created_at"],
    scheduled_topups: [
      "id",
      "wallet_id",
      "network",
      "plan_label",
      "price",
      "recipient",
      "day_of_month",
      "active",
      "created_at",
    ],
    agent_profiles: ["id", "wallet_id", "tier", "referral_code", "referrals", "commission", "volume", "created_at"],
  },
  enums: {
    tx_status: migrated
      ? ["successful", "pending", "failed", "reversed"]
      : ["successful", "pending", "failed"],
    // the fulfillment enum type only ships with the gateway migration
    ...(migrated
      ? { fulfillment_status: ["queued", "submitted", "processing", "delivered", "failed", "refunded"] }
      : {}),
  },
};
  return schema;
}

function pgError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function splitTop(input: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const lower = input.toLowerCase();
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && lower.startsWith(separator, i)) {
      out.push(current);
      current = "";
      i += separator.length - 1;
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}

const stripQuotes = (value: string) => value.trim().replace(/"/g, "");

class FakePg {
  rows: Record<string, Record<string, unknown>[]> = {
    wallets: [],
    users: [],
    sessions: [],
    password_resets: [],
    deposit_requests: [],
    transactions: [],
    bundle_plans: [],
    provider_float_balances: [],
    price_alerts: [],
    scheduled_topups: [],
    agent_profiles: [],
  };
  captured: { kind: string; table: string; columns: string[] }[] = [];
  errors: string[] = [];
  serials: Record<string, number> = {};

  constructor(
    public schema: Schema,
    public breakCatalog: boolean,
  ) {}

  /** drizzle sets rowMode:"array" and maps result rows positionally */
  private arrayMode = false;
  private selectOrder: string[] = [];

  async query(config: unknown, params?: unknown[]) {
    const cfg = config as { text?: string; rowMode?: string };
    const text = typeof config === "string" ? config : cfg.text ?? "";
    this.arrayMode = typeof config === "object" && cfg.rowMode === "array";
    const result = await Promise.resolve(this.run(text, (params ?? []) as unknown[]));
    if (this.arrayMode && this.selectOrder.length > 0 && Array.isArray(result.rows)) {
      const order = this.selectOrder;
      return {
        ...result,
        rows: result.rows.map((row: Record<string, unknown>) => order.map((column) => row?.[column] ?? null)),
      };
    }
    return result;
  }

  async connect() {
    return this;
  }

  async end() {}

  private columnsOf(table: string) {
    return this.schema.tables[table] ?? [];
  }

  private assertTable(table: string) {
    if (this.columnsOf(table).length === 0) {
      throw pgError(`relation "${table}" does not exist`, "42P01");
    }
  }

  private assertColumn(table: string, column: string, qualified: boolean) {
    if (this.columnsOf(table).includes(column)) return;
    throw pgError(
      qualified
        ? `column "${table}.${column}" does not exist`
        : `column "${column}" of relation "${table}" does not exist`,
      "42703",
    );
  }

  /** Validate every `"table"."column"` reference in a statement. */
  private assertRefs(sql: string) {
    for (const match of sql.matchAll(/"([a-z_]+)"\."([a-z_]+)"/g)) {
      const [, table, column] = match;
      if (this.schema.tables[table] === undefined) continue;
      this.assertTable(table);
      this.assertColumn(table, column, true);
    }
  }

  /** Postgres rejects values the enum type does not define. */
  private assertEnumValue(table: string, column: string, value: unknown) {
    if (value == null) return;
    const enumName =
      column === "status" ? "tx_status" : column === "fulfillment_status" ? "fulfillment_status" : null;
    if (!enumName) return;
    const labels = this.schema.enums[enumName];
    if (!labels) {
      if (column === "fulfillment_status") {
        throw pgError(`type "${enumName}" does not exist`, "42704");
      }
      return;
    }
    if (!labels.includes(String(value))) {
      throw pgError(`invalid input value for enum ${enumName}: "${value}"`, "22P02");
    }
  }

  private nextId(table: string) {
    this.serials[table] = (this.serials[table] ?? 0) + 1;
    return this.serials[table];
  }

  /** Column defaults the real schema declares. */
  private defaults(table: string): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const column of this.columnsOf(table)) {
      if (column === "created_at" || column === "updated_at") row[column] = new Date();
      else if (column === "points" || column === "fulfillment_attempts") row[column] = 0;
      else if (column === "subtitle") row[column] = "";
      else if (column === "fulfillment_status") row[column] = "queued";
      else if (column === "currency") row[column] = "GHS";
      else if (column === "is_agent" || column === "active") row[column] = false;
      else if (column === "balance" || column === "amount" || column === "price" || column === "retail_price")
        row[column] = "0.00";
      else if (column.includes("balance") || column.includes("threshold")) row[column] = "0.00";
      else row[column] = null;
    }
    return row;
  }

  private pick(row: Record<string, unknown>, columns: string[]) {
    const out: Record<string, unknown> = {};
    for (const column of columns) out[column] = row[column] ?? null;
    return out;
  }

  private matchCondition(cond: string, params: unknown[], row: Record<string, unknown>): boolean {
    const m = cond.match(/(?:"([a-z_]+)"\.)?"?([a-z_]+)"?\s*=\s*\$(\d+)/i);
    if (!m) return true;
    const column = m[2];
    const expected = params[Number(m[3]) - 1];
    const actual = row[column];
    const norm = (v: unknown) => (v instanceof Date ? String(v.getTime()) : v == null ? null : String(v));
    if (norm(actual) === norm(expected)) return true;
    // jsonb/numeric round-trips are irrelevant for matching
    return false;
  }

  private filter(table: string, where: string | undefined, params: unknown[]) {
    let rows = this.rows[table] ?? [];
    if (!where) return rows;
    const groups = splitTop(where, " or ");
    return rows.filter((row) =>
      groups.some((group) => splitTop(group, " and ").every((cond) => this.matchCondition(cond, params, row))),
    );
  }

  run(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.replace(/\s+/g, " ").trim();
    const lower = sql.toLowerCase();
    if (process.env.DEBUG) console.log("SQL>>>", sql.includes("conflict") ? sql : sql.slice(0, 260));

    if (lower.includes("information_schema.columns")) {
      if (this.breakCatalog) {
        throw pgError('permission denied for view "information_schema.columns"', "42501");
      }
      const tables = [...sql.matchAll(/\('([a-z_]+)'\)/g)].map((m) => m[1]);
      return {
        rows: tables.map((table) => ({ table_name: table, columns: this.columnsOf(table) })),
        rowCount: tables.length,
      };
    }

    if (lower.includes("pg_enum")) {
      if (this.breakCatalog) throw pgError("catalog access denied", "42501");
      const name = sql.match(/values \('([a-z_]+)'\)/i)?.[1] ?? "tx_status";
      return { rows: [{ enum_name: name, labels: this.schema.enums[name as "tx_status"] ?? [] }], rowCount: 1 };
    }

    const countMatch = lower.match(/select count\(\*\)::int as c from ([a-z_]+)/);
    if (countMatch) {
      const table = countMatch[1];
      return { rows: [{ c: (this.rows[table] ?? []).length }], rowCount: 1 };
    }

    let m: RegExpMatchArray | null;

    if ((m = sql.match(/^insert into "?([a-z_]+)"? \(([^)]*)\) values ([\s\S]*?)( on conflict [\s\S]*?)?( returning ([\s\S]*))?$/i))) {
      const table = m[1];
      const columns = m[2].split(",").map(stripQuotes);
      this.assertTable(table);
      // Drizzle names every column of the table definition and emits `default`
      // for the ones not supplied, so a legacy table still fails here unless the
      // statement was built with an explicit column list.
      for (const column of columns) this.assertColumn(table, column, false);

      // drizzle emits `(..), (..)` per row, with no nested parens in a VALUES list
      const tuples = [...m[3].matchAll(/\(([^()]*)\)/g)].map((t) => t[1]);
      const conflict = m[4] ?? "";
      const touched: string[] = [];
      const updates: Record<string, unknown> = {};

      if (/on conflict[\s\S]*?do update set/i.test(conflict)) {
        const setPart = conflict.match(/do update set ([\s\S]*?)( where | returning |$)/i)?.[1] ?? "";
        for (const assignment of splitTop(setPart, ",")) {
          const a = assignment.match(/"([a-z_]+)"\s*=\s*\$(\d+)/i);
          if (a) updates[a[1]] = params[Number(a[2]) - 1];
        }
      }

      for (const tuple of tuples) {
        const tokens = tuple.split(",");
        const row = this.defaults(table);
        const keys: Record<string, unknown> = {};
        columns.forEach((column, index) => {
          const token = (tokens[index] ?? "").trim();
          if (/^default$/i.test(token)) return;
          const value = token.startsWith("$") ? params[Number(token.slice(1)) - 1] : token;
          this.assertEnumValue(table, column, value);
          row[column] = value === undefined ? null : value;
          keys[column] = value;
          if (!touched.includes(column)) touched.push(column);
        });
        row.id = this.nextId(table);

        if (Object.keys(updates).length > 0) {
          const keyOf = (r: Record<string, unknown>) => `${r.provider_code}|${r.network ?? ""}`;
          const existing = (this.rows[table] ?? []).find((r) => keyOf(r) === keyOf(keys));
          if (existing) {
            Object.assign(existing, updates);
            this.captured.push({ kind: "upsert", table, columns: Object.keys(updates) });
            continue;
          }
        }

        this.rows[table] = [...(this.rows[table] ?? []), row];
      }
      this.captured.push({ kind: "insert", table, columns: touched });
      const returning = m[6]
        ? splitTop(m[6], ",").map(stripQuotes).filter((c) => this.columnsOf(table).includes(c))
        : [];
      this.selectOrder = returning;
      const created = (this.rows[table] ?? []).slice(-tuples.length);
      return {
        rows: returning.length > 0 ? created.map((row) => this.pick(row, returning)) : [],
        rowCount: tuples.length,
        command: "INSERT",
      };
    }

    if ((m = sql.match(/^select ([\s\S]*?) from "?([a-z_]+)"?( where ([\s\S]*?))?( order by ([\s\S]*?))?( limit (\d+))?$/i))) {
      const table = m[2];
      this.assertRefs(sql);
      if (this.columnsOf(table).length === 0) throw pgError(`relation "${table}" does not exist`, "42P01");

      const items = splitTop(m[1], ",");
      const requested: string[] = [];
      for (const item of items) {
        const aliased = item.match(/"([a-z_]+)"$/i);
        const bare = item.match(/^\$?([a-z_]+)/i);
        const column = (aliased?.[1] ?? bare?.[1] ?? "").toLowerCase();
        if (!column || column === "count" || column === "as") continue;
        if (!/^[\w]+$/.test(column)) continue;
        requested.push(column);
      }

      this.selectOrder = requested;
      let rows = this.filter(table, m[4], params);
      if (m[6]) {
        const orderCol = m[6].match(/"([a-z_]+)"\.?"?([a-z_]+)?"?/i);
        const column = orderCol?.[2] ?? orderCol?.[1] ?? "created_at";
        const desc = /desc/i.test(m[6]);
        rows = [...rows].sort((a, b) => {
          const av = a[column] as any;
          const bv = b[column] as any;
          const norm = (v: any) => (v instanceof Date ? v.getTime() : v);
          if (norm(av) === norm(bv)) return 0;
          return norm(av) > norm(bv) ? (desc ? -1 : 1) : desc ? 1 : -1;
        });
      }
      if (m[8]) rows = rows.slice(0, Number(m[8]));

      const projected =
        requested.length === 0 || items.length === 0
          ? rows
          : rows.map((row) => {
              const out: Record<string, unknown> = {};
              for (const column of requested) out[column] = row[column] ?? null;
              return out;
            });
      if (process.env.DEBUG) {
        console.log("SELECT>>>", sql.slice(0, 300));
        console.log("ITEMS>>>", JSON.stringify(items), "REQUESTED>>>", JSON.stringify(requested));
        console.log("PROJECTED>>>", JSON.stringify(projected[0])?.slice(0, 400));
      }
      return { rows: projected, rowCount: projected.length, command: "SELECT" };
    }

    if ((m = sql.match(/^update "?([a-z_]+)"? set ([\s\S]*?)( where ([\s\S]*?))?$/i))) {
      const table = m[1];
      this.assertTable(table);
      const assignments = splitTop(m[2], ",");
      const written: string[] = [];
      const parsed: { column: string; value: unknown }[] = [];
      for (const assignment of assignments) {
        const a = assignment.match(/"([a-z_]+)"\s*=\s*\$(\d+)/i);
        if (!a) continue;
        this.assertColumn(table, a[1], true);
        parsed.push({ column: a[1], value: params[Number(a[2]) - 1] });
        written.push(a[1]);
      }
      const targets = this.filter(table, m[4], params);
      for (const row of targets) {
        for (const { column, value } of parsed) {
          this.assertEnumValue(table, column, value);
          row[column] = value;
        }
      }
      this.captured.push({ kind: "update", table, columns: written });
      return { rows: targets, rowCount: targets.length, command: "UPDATE" };
    }

    if (lower.startsWith("delete from")) {
      const table = sql.match(/delete from "?([a-z_]+)"?/i)?.[1] ?? "";
      this.assertTable(table);
      return { rows: [], rowCount: 0, command: "DELETE" };
    }

    if (lower === "select 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };

    if (process.env.DEBUG) console.log("UNHANDLED>>>", sql.slice(0, 200));
    return { rows: [], rowCount: 0 };
  }
}

export function installSim(options: { migrated: boolean; breakCatalog?: boolean }) {
  const schema = makeSimSchema(options.migrated);
  let instance: FakePg | null = null;

  function pool() {
    instance ??= new FakePg(schema, Boolean(options.breakCatalog));
    return instance;
  }

  function FakePoolCtor(this: unknown) {
    return pool();
  }

  const pgModule = require("pg");
  pgModule.Pool = FakePoolCtor;

  return { pool, schema, FakePg };
}
