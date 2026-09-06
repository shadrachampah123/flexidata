import type { AdminList } from "@/lib/admin/filters";
import type { DiagnosisFinding, DiagnosisVerdict, PaystackProbeView } from "@/lib/admin/diagnosis";

/**
 * JSON-safe shapes returned by the Phase 1 admin read layer.
 *
 * Every type here is serialisable: the admin pages render them on the server and
 * the `/api/admin/*` handlers return exactly the same objects to the browser.
 * There is no `Date`, no `BigInt`, no Drizzle row and no raw JSONB payload
 * anywhere in this file — provider payloads are deliberately never exposed (see
 * §L-10 of the assessment) because they are free-form text from external
 * systems and may contain PII.
 */

export type AdminSeverity = "healthy" | "attention" | "critical" | "unknown";

/** A single operational problem surfaced at the top of the overview. */
export type AdminIssue = {
  id: string;
  label: string;
  count: number;
  severity: AdminSeverity;
  detail: string;
  /** Where to go to work the queue. */
  href: string;
};

/** Which optional parts of the schema this database actually has. */
export type AdminCapsView = {
  chargedAt: boolean;
  refundedAt: boolean;
  fulfilledAt: boolean;
  fulfillmentStatus: boolean;
  lastProviderSyncAt: boolean;
  reversedStatus: boolean;
  checkoutTable: boolean;
  floatTable: boolean;
  reconciliation: { id: string; label: string; exact: boolean; note: string };
};

export type AdminOverviewCounts = {
  users: number | null;
  wallets: number | null;
  totalWalletBalance: number | null;
  successfulDeposits: number | null;
  successfulDepositsValue: number | null;
  pendingDeposits: number | null;
  failedDeposits: number | null;
  abandonedDeposits: number | null;
  successfulPurchases: number | null;
  successfulPurchasesValue: number | null;
  fulfilledCheckoutOrders: number | null;
  pendingTransactions: number | null;
  failedTransactions: number | null;
  reversedTransactions: number | null;
  pendingDeliveries: number | null;
  failedDeliveries: number | null;
  inFlightCheckoutOrders: number | null;
  stuckCheckoutOrders: number | null;
  supportQueue: number | null;
  walletDiscrepancies: number | null;
  /**
   * Refund reviews recorded by an administrator and not yet resolved
   * (Phase 2, Step 3). `null` when the database cannot answer — the
   * order-reference column is missing — which renders as "Not available"
   * rather than a misleading zero.
   */
  openRefundReviews: number | null;
};

export type AdminFloatRow = {
  id: number;
  providerCode: string;
  network: string;
  availableBalance: number;
  reservedBalance: number;
  lowBalanceThreshold: number;
  lastReference: string | null;
  lastStatus: string | null;
  lastSyncedAt: string | null;
  belowThreshold: boolean;
};

export type AdminOverview = {
  generatedAt: string;
  /** Safe to display: `test` / `live` / `unconfigured`. Never a key. */
  paystackMode: "test" | "live" | "unconfigured";
  counts: AdminOverviewCounts;
  issues: AdminIssue[];
  float: { available: boolean; rows: AdminFloatRow[] };
  caps: AdminCapsView;
};

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export type WalletDiffStatus = "matched" | "mismatch" | "unknown";

export type AdminWalletRow = {
  walletId: number;
  walletName: string;
  walletNumber: string;
  userId: number | null;
  userName: string | null;
  /** Masked in list views (see `src/lib/admin/redact.ts`). */
  userEmail: string;
  userPhone: string;
  /** The authoritative figure, straight from `wallets.balance`. */
  storedBalance: number;
  points: number;
  /** Diagnostically derived from the ledger. Never authoritative. */
  calculatedBalance: number | null;
  difference: number | null;
  diffStatus: WalletDiffStatus;
  transactionsExamined: number | null;
  lastTransactionAt: string | null;
  isAgent: boolean;
  agentTier: string | null;
  createdAt: string;
};

export type AdminWalletDetail = {
  wallet: AdminWalletRow;
  reconciliation: {
    rule: { id: string; label: string; exact: boolean; note: string };
    storedBalance: number;
    calculatedBalance: number | null;
    difference: number | null;
    status: WalletDiffStatus;
    severity: AdminSeverity;
    label: string;
    guidance: string;
    transactionsExamined: number | null;
    lastTransactionAt: string | null;
    causes: readonly string[];
  };
  totals: {
    credits: number;
    debits: number;
    successfulCredits: number;
    successfulDebits: number;
    reversals: number;
  };
  contributions: AdminTransactionRow[];
  contributionsTotal: number;
  page: number;
  pageSize: number;
};

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type AdminTransactionRow = {
  id: number;
  ref: string;
  walletId: number;
  walletNumber: string | null;
  userId: number | null;
  userName: string | null;
  userEmail: string;
  type: string;
  status: string;
  direction: string;
  fulfillmentStatus: string | null;
  title: string;
  subtitle: string;
  amount: number;
  points: number;
  network: string | null;
  recipient: string;
  provider: string | null;
  providerReference: string | null;
  providerStatus: string | null;
  /** True when the ledger row says money actually moved. */
  charged: boolean;
  chargedAt: string | null;
  fulfilledAt: string | null;
  refundedAt: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Data operations
// ---------------------------------------------------------------------------

export type AdminDataChannel = "wallet" | "checkout";

/**
 * Order-level support actions recorded through the Phase 2 Step 2 write
 * surface. They come from `admin_audit_logs`, NOT from the order row —
 * `refund_review` in particular never changes the order: it records that a
 * finance review is pending.
 */
export type AdminOrderSupportAction = "delivery_resolved" | "refund_review";

export type AdminDataOrderRow = {
  channel: AdminDataChannel;
  id: number;
  ref: string;
  userId: number | null;
  customerName: string | null;
  customerEmail: string;
  /** Masked in list views. */
  phone: string;
  network: string | null;
  bundle: string;
  amount: number;
  paymentStatus: string;
  /** `Debited` / `Not charged` / `Paid via Paystack (wallet untouched)`. */
  walletDebit: string;
  provider: string | null;
  providerReference: string | null;
  providerStatus: string | null;
  providerMessage: string | null;
  /** Raw enum value for filtering; `delivery` is the display label. */
  deliveryStatus: string | null;
  delivery: string;
  deliverySeverity: AdminSeverity;
  /** Latest support action recorded for this order, if any (checkout only). */
  supportAction: AdminOrderSupportAction | null;
  /** When that action was recorded (checkout channel only). */
  supportAt: string | null;
  createdAt: string;
  updatedAt: string | null;
};

// ---------------------------------------------------------------------------
// Orders requiring attention
// ---------------------------------------------------------------------------

export type AdminAttentionSource = "checkout" | "wallet" | "deposit";

export type AdminAttentionRow = {
  source: AdminAttentionSource;
  id: number;
  ref: string;
  customerName: string | null;
  customerEmail: string;
  phone: string;
  amount: number;
  bundle: string;
  status: string;
  reason: string;
  severity: AdminSeverity;
  /**
   * The latest support action recorded for this queue item, if any. Only
   * checkout orders carry one — and `delivery_resolved` normally removes the
   * order from this queue, so seeing it here means the record predates the
   * queue refresh.
   */
  supportAction: AdminOrderSupportAction | null;
  /** When that support action was recorded. */
  supportAt: string | null;
  /** Name of the admin who recorded it (admin-to-admin context, list-safe). */
  supportAdminName: string | null;
  /**
   * Whether a support action MAY be attempted. True only for Paystack
   * checkout orders with a captured payment whose delivery failed or has been
   * stuck beyond the queue's window — the wallet-channel items are ledger rows
   * (financial records this dashboard must never mutate) and deposits belong
   * to the funding flow, so both stay read-only diagnostics by design.
   */
  actionable: boolean;
  createdAt: string;
  updatedAt: string | null;
};

// ---------------------------------------------------------------------------
// Payments / deposits
// ---------------------------------------------------------------------------

export type AdminDepositCreditState = "credited" | "not-credited" | "reversed" | "unknown";

export type AdminPaymentRow = {
  id: number;
  ref: string;
  walletId: number;
  walletNumber: string | null;
  userId: number | null;
  userName: string | null;
  userEmail: string;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  method: string;
  channel: string | null;
  gatewayResponse: string | null;
  paystackTransactionId: string | null;
  /** Whether the matching wallet credit exists in the ledger. */
  walletCredit: AdminDepositCreditState;
  walletCreditedAt: string | null;
  initiatedAt: string;
  paidAt: string | null;
  verifiedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** `null` when the database predates the customer-management migration. */
export type AccountStatusView = "active" | "suspended" | null;

/** One suspend / activate event from `admin_audit_logs`, for the customer page. */
export type AdminAccountActionRow = {
  id: number;
  adminUserId: number;
  adminName: string | null;
  adminEmail: string | null;
  action: "suspend" | "activate";
  reason: string | null;
  createdAt: string;
};

export type AdminUserRow = {
  userId: number;
  name: string;
  /** Masked in list views. */
  email: string;
  phone: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  isAdmin: boolean;
  referralCode: string | null;
  /** Account status; null = not available on a pre-migration database. */
  status: AccountStatusView;
  walletId: number | null;
  /** More than one wallet for one user is a reconciliation finding, not a fix. */
  walletCount: number;
  balance: number;
  points: number;
  activeSessions: number | null;
  lastSeenAt: string | null;
};

export type AdminUserWalletRow = {
  walletId: number;
  walletNumber: string;
  balance: number;
  points: number;
  isAgent: boolean;
  agentTier: string | null;
  createdAt: string;
};

export type AdminUserSessionRow = {
  sessionId: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  expired: boolean;
  ip: string | null;
  userAgent: string | null;
};

export type AdminUserDetail = {
  user: {
    userId: number;
    name: string;
    email: string;
    phone: string;
    createdAt: string;
    updatedAt: string | null;
    emailVerifiedAt: string | null;
    isAdmin: boolean;
    status: AccountStatusView;
    referralCode: string | null;
    referredBy: number | null;
    referralRewardedAt: string | null;
    notifyPromos: boolean;
    notifyTx: boolean;
  };
  wallets: AdminUserWalletRow[];
  sessions: AdminUserSessionRow[];
  recentTransactions: AdminTransactionRow[];
  recentOrders: AdminDataOrderRow[];
  /** Suspend / activate history for this account (most recent first). */
  accountActions: AdminAccountActionRow[];
  totals: {
    successfulDeposits: number | null;
    successfulDepositValue: number | null;
    successfulPurchases: number | null;
    successfulPurchaseValue: number | null;
    failedDeliveries: number | null;
  };
};

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type AdminReconciliationRow = {
  walletId: number;
  walletName: string;
  walletNumber: string;
  userId: number | null;
  userName: string | null;
  userEmail: string;
  storedBalance: number;
  calculatedBalance: number | null;
  difference: number | null;
  status: WalletDiffStatus;
  severity: AdminSeverity;
  label: string;
  guidance: string;
  transactionsExamined: number | null;
  lastTransactionAt: string | null;
};

export type AdminReconciliationResult = AdminList<AdminReconciliationRow> & {
  rule: { id: string; label: string; exact: boolean; note: string };
  walletsExamined: number;
  mismatches: number;
  notAvailable: boolean;
};

// ---------------------------------------------------------------------------
// Phase 2, Step 3 — investigation, audit trail and refund-review backlog
// ---------------------------------------------------------------------------
//
// Every shape below is produced by `src/lib/admin/queries-investigation.ts`
// inside `withReadOnlyTx` and classified by the PURE engine in
// `src/lib/admin/diagnosis.ts`. They are diagnosis payloads: a findings list,
// the stored facts it was derived from, and — for the Paystack probe — the
// gateway's own answer next to ours. None of them carries a control, an
// instruction or a value this dashboard could write back.

/** One recorded administrator action, as shown on an investigation page. */
export type AdminRecordedAction = {
  id: number;
  action: string;
  adminUserId: number;
  adminName: string | null;
  reason: string | null;
  targetRef: string | null;
  createdAt: string;
};

/** The stored `checkout_orders` facts an investigator needs, nothing more. */
export type AdminOrderRecord = {
  id: number;
  ref: string;
  userId: number | null;
  walletId: number | null;
  customerName: string | null;
  /** Unmasked: this is a deliberately-opened single record. */
  customerEmail: string;
  customerPhone: string;
  accountStatus: AccountStatusView;
  walletNumber: string | null;
  network: string | null;
  category: string | null;
  planLabel: string | null;
  providerProductCode: string | null;
  recipient: string;
  amount: number;
  /** The integer pesewas Paystack was asked to charge — the authoritative figure. */
  amountSubunits: number | null;
  currency: string;
  paymentStatus: string;
  orderStatus: string;
  fulfillmentStatus: string | null;
  paystackTransactionId: string | null;
  paystackChannel: string | null;
  paystackGatewayResponse: string | null;
  providerReference: string | null;
  providerStatus: string | null;
  providerMessage: string | null;
  paidAt: string | null;
  verifiedAt: string | null;
  fulfilledAt: string | null;
  failedAt: string | null;
  abandonedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  /** True when the order is eligible for a Step 2 support action. */
  supportActionable: boolean;
};

export type AdminOrderInvestigation = {
  order: AdminOrderRecord;
  /** The ledger mirror row `checkout.ts` writes, when it exists. */
  mirror: AdminTransactionRow | null;
  /** Delivery timeline, from the existing pure `buildTrackingInfo()`. */
  tracking: {
    phase: string;
    progress: number;
    overdue: boolean;
    etaLabel: string;
    stages: { id: string; label: string; hint: string; state: string; at: string | null }[];
  };
  findings: DiagnosisFinding[];
  verdict: DiagnosisVerdict;
  /** Every admin action recorded against this ref (Step 2 support actions). */
  recordedActions: AdminRecordedAction[];
  /** Suspend / activate history for the customer who owns the order. */
  accountActions: AdminRecordedAction[];
  /** False on a database without the audit trail; the panels degrade. */
  auditAvailable: boolean;
  /** False when the database predates `target_ref` (migration 0003). */
  refTrailAvailable: boolean;
  /** Whether the read-only Paystack probe can run at all here. */
  probe: { available: boolean; mode: "test" | "live" | "unconfigured"; reason: string | null };
};

/** The stored `deposit_requests` facts, plus whether the credit landed. */
export type AdminDepositRecord = {
  id: number;
  ref: string;
  walletId: number;
  walletNumber: string | null;
  userId: number | null;
  customerName: string | null;
  customerEmail: string;
  customerPhone: string;
  provider: string;
  method: string;
  amount: number;
  amountSubunits: number | null;
  currency: string;
  status: string;
  paystackTransactionId: string | null;
  paystackChannel: string | null;
  paystackGatewayResponse: string | null;
  initiatedAt: string;
  paidAt: string | null;
  verifiedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  creditRows: number;
  successfulCredits: number;
  reversedRows: number;
  creditedAmount: number | null;
  creditedAt: string | null;
  walletCredit: AdminDepositCreditState;
};

export type AdminDepositInvestigation = {
  deposit: AdminDepositRecord;
  /** The ledger rows carrying this reference — evidence, never an accusation. */
  creditRows: AdminTransactionRow[];
  /** The owning wallet's stored-vs-calculated verdict, from the existing rule. */
  walletReconciliation: {
    available: boolean;
    storedBalance: number | null;
    calculatedBalance: number | null;
    difference: number | null;
    status: WalletDiffStatus;
    severity: AdminSeverity;
    label: string;
    guidance: string;
  };
  findings: DiagnosisFinding[];
  verdict: DiagnosisVerdict;
  accountActions: AdminRecordedAction[];
  auditAvailable: boolean;
  probe: { available: boolean; mode: "test" | "live" | "unconfigured"; reason: string | null };
};

/** The read-only Paystack probe result (S3.6). Nothing here was written. */
export type AdminPaystackProbeResult = {
  ok: true;
  kind: "order" | "deposit";
  ref: string;
  mode: "test" | "live";
  probedAt: string;
  elapsedMs: number;
  verification: PaystackProbeView;
  findings: DiagnosisFinding[];
  verdict: DiagnosisVerdict;
  /** Restated on every response so the payload can never be read as a settle. */
  notice: string;
};

export type AdminPaystackProbeRefusal = {
  ok: false;
  kind: "order" | "deposit";
  ref: string;
  error: "not-found" | "unavailable" | "throttled" | "upstream" | "timeout";
  message: string;
  retryAfterSeconds?: number;
};

/** One row of the admin activity log (`/admin/audit`). */
export type AdminAuditRow = {
  id: number;
  action: string;
  /** Human label for the action value. */
  actionLabel: string;
  adminUserId: number;
  adminName: string | null;
  /** Masked in the list view. */
  adminEmail: string;
  targetUserId: number;
  targetName: string | null;
  targetEmail: string;
  targetRef: string | null;
  /** `order` when a ref is present, otherwise `account`. */
  targetKind: "order" | "account";
  reason: string | null;
  createdAt: string;
};

export type AdminAuditResult = AdminList<AdminAuditRow> & {
  /** False on a database without `admin_audit_logs` (pre-migration 0002). */
  available: boolean;
  /** False when `target_ref` is missing (pre-migration 0003). */
  refTrailAvailable: boolean;
  summary: {
    all: number | null;
    inRange: number | null;
    admins: number | null;
    byAction: { action: string; label: string; count: number }[];
  };
  /** Administrators that can appear in the filter (id + name only). */
  adminOptions: { id: number; name: string }[];
  actionOptions: { value: string; label: string }[];
};

/** One refund review from the audit trail, joined to the order it concerns. */
export type AdminRefundReviewRow = {
  ref: string;
  orderId: number | null;
  userId: number | null;
  customerName: string | null;
  customerEmail: string;
  phone: string;
  network: string | null;
  bundle: string;
  amount: number;
  currency: string;
  orderStatus: string | null;
  paymentStatus: string | null;
  /** Open = no `delivery_resolved` recorded at or after the review. */
  state: "open" | "closed";
  reviewCount: number;
  firstReviewAt: string;
  lastReviewAt: string | null;
  resolvedAt: string | null;
  /** Age of the review in whole hours (open reviews only). */
  ageHours: number | null;
  reviewedBy: string | null;
  reason: string | null;
  orderCreatedAt: string | null;
};

export type AdminRefundReviewResult = AdminList<AdminRefundReviewRow> & {
  available: boolean;
  summary: {
    open: number | null;
    closed: number | null;
    /** Total value of the OPEN reviews — the money finance still has to decide on. */
    openValue: number | null;
    oldestOpenHours: number | null;
  };
};
