/**
 * Withdrawal notification layer (Phase 8).
 *
 * Dispatches notifications for withdrawal lifecycle events. Uses the existing
 * notification infrastructure where possible. No external messaging provider
 * is connected yet — notifications are logged server-side for audit purposes
 * and can be extended with email/push/SMS transports later.
 *
 * The notification layer is purely additive: it observes state changes and
 * dispatches messages. It never modifies withdrawal or wallet state.
 */

import type { WithdrawalAuditEvent } from "@/lib/withdrawals";

/** Supported notification types for withdrawal events. */
export type WithdrawalNotificationType =
  | "withdrawal_submitted"
  | "withdrawal_processing"
  | "withdrawal_successful"
  | "withdrawal_rejected"
  | "withdrawal_refunded";

/** Data needed to construct a withdrawal notification. */
export type WithdrawalNotificationData = {
  /** The notification type to send. */
  type: WithdrawalNotificationType;
  /** User ID to notify. */
  userId: number;
  /** User email (for email notifications). */
  userEmail: string;
  /** Withdrawal reference. */
  withdrawalRef: string;
  /** Amount in cedis (e.g. "50.00"). */
  amount: string;
  /** Fee in cedis (e.g. "1.00"). */
  fee: string;
  /** Net amount in cedis (e.g. "49.00"). */
  netAmount: string;
  /** Destination mobile number. */
  destination: string;
  /** Withdrawal method (e.g. "MTN MoMo"). */
  method: string;
  /** Optional rejection/failure reason. */
  reason?: string | null;
};

/** Map audit events to notification types. */
export function eventToNotificationType(
  event: WithdrawalAuditEvent,
): WithdrawalNotificationType | null {
  switch (event) {
    case "created":
      return "withdrawal_submitted";
    case "moved_to_processing":
    case "approved":
      return "withdrawal_processing";
    case "marked_successful":
      return "withdrawal_successful";
    case "rejected":
      return "withdrawal_rejected";
    case "refunded":
    case "payout_failed":
      return "withdrawal_refunded";
    default:
      return null;
  }
}

/** Human-readable titles for notification types. */
export const NOTIFICATION_TITLES: Record<WithdrawalNotificationType, string> = {
  withdrawal_submitted: "Withdrawal Submitted",
  withdrawal_processing: "Withdrawal Processing",
  withdrawal_successful: "Withdrawal Successful",
  withdrawal_rejected: "Withdrawal Rejected",
  withdrawal_refunded: "Withdrawal Refunded",
};

/**
 * Build a human-readable notification message for a withdrawal event.
 */
export function buildNotificationMessage(data: WithdrawalNotificationData): string {
  const title = NOTIFICATION_TITLES[data.type];
  switch (data.type) {
    case "withdrawal_submitted":
      return `${title}: Your withdrawal of GH₵ ${data.amount} to ${data.destination} (${data.method}) has been submitted. Reference: ${data.withdrawalRef}.`;
    case "withdrawal_processing":
      return `${title}: Your withdrawal ${data.withdrawalRef} of GH₵ ${data.netAmount} is being processed for payout to ${data.destination}.`;
    case "withdrawal_successful":
      return `${title}: Your withdrawal ${data.withdrawalRef} of GH₵ ${data.netAmount} has been sent to ${data.destination} (${data.method}).`;
    case "withdrawal_rejected":
      return `${title}: Your withdrawal ${data.withdrawalRef} of GH₵ ${data.amount} has been rejected.${data.reason ? ` Reason: ${data.reason}` : ""} The amount has been refunded to your wallet.`;
    case "withdrawal_refunded":
      return `${title}: Your withdrawal ${data.withdrawalRef} of GH₵ ${data.amount} could not be completed and has been refunded to your wallet.${data.reason ? ` Reason: ${data.reason}` : ""}`;
    default:
      return `${title}: Withdrawal ${data.withdrawalRef}.`;
  }
}

/**
 * Dispatch a withdrawal notification.
 *
 * Currently logs the notification server-side. When email/push transports
 * are configured, this function will dispatch through those channels.
 *
 * This is a fire-and-forget operation: notification failures do not roll back
 * the withdrawal state change that triggered them.
 */
export async function dispatchWithdrawalNotification(
  data: WithdrawalNotificationData,
): Promise<void> {
  const message = buildNotificationMessage(data);
  // Log for audit/debugging. In production with a configured transport,
  // this would dispatch via email/push/SMS.
  console.info(
    `[flexidata:notification] ${data.type} user=${data.userId} ref=${data.withdrawalRef}: ${message}`,
  );

  // Future: dispatch via configured transport
  // if (process.env.NOTIFY_WEBHOOK_URL) { await sendViaWebhook(data, message); }
  // if (process.env.RESEND_API_KEY) { await sendViaEmail(data, message); }
}

/**
 * Dispatch a notification from an audit event.
 * Convenience wrapper that maps event → notification type.
 */
export async function dispatchNotificationFromEvent(
  event: WithdrawalAuditEvent,
  baseData: Omit<WithdrawalNotificationData, "type">,
): Promise<void> {
  const type = eventToNotificationType(event);
  if (!type) return; // Event does not generate a notification
  await dispatchWithdrawalNotification({ ...baseData, type });
}
