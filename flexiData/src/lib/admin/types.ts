import type { AdminList } from "@/lib/admin/filters";

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
