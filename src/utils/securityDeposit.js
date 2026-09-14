import { ApiError } from "./ApiError.js";
import { resolveBillEntryTotalAmount } from "./billing.js";
import { isCheckInPaymentEntry, resolveCheckoutAt } from "./billPhase.js";

export const SECURITY_DEPOSIT_AMOUNT = 800;
export const SECURITY_DEPOSIT_HOLD_DAYS = 15;

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatMoney(value) {
  return `$${money(value).toFixed(2)}`;
}

function entryId(entry) {
  if (!entry) return "";
  if (entry._id != null) return String(entry._id);
  return String(entry.entryId ?? "");
}

function resolveEntryStatus(entry) {
  if (entry?.status === "unpaid" || entry?.status === "paid" || entry?.status === "refund") {
    return entry.status;
  }
  return entry?.paid ? "paid" : "unpaid";
}

export function isDepositCollected(booking) {
  return Boolean(booking?.securityDepositHeldAt || booking?.securityDepositStatus);
}

export function isDepositPaidCharge(entry) {
  if (!entry || entry.paidVia !== "deposit") return false;
  if (entry.entryType === "payment") return false;
  return resolveEntryStatus(entry) === "paid";
}

export function depositDeductionAmount(entry) {
  if (!entry) return 0;
  if (entry.entryType === "charge") return money(resolveBillEntryTotalAmount(entry));
  return money(entry.amount);
}

export function sumDepositDeductions(entries = [], excludeEntryId) {
  const skip = excludeEntryId != null ? String(excludeEntryId) : "";
  return money(
    (entries ?? []).reduce((sum, entry) => {
      if (skip && entryId(entry) === skip) return sum;
      if (!isDepositPaidCharge(entry)) return sum;
      return sum + depositDeductionAmount(entry);
    }, 0),
  );
}

export function computeDepositTotals(booking, excludeEntryId) {
  const collected = isDepositCollected(booking);
  const amount = money(booking?.securityDepositAmount) || (collected ? SECURITY_DEPOSIT_AMOUNT : SECURITY_DEPOSIT_AMOUNT);
  const deductedAmount = sumDepositDeductions(booking?.billEntries, excludeEntryId);
  const remainingAmount = Math.max(0, money(amount - deductedAmount));
  return { amount, deductedAmount, remainingAmount };
}

export function applySecurityDepositOnCheckIn(booking, heldAt = new Date()) {
  booking.securityDepositAmount = SECURITY_DEPOSIT_AMOUNT;
  booking.securityDepositHeldAt = booking.securityDepositHeldAt ?? heldAt;
  if (booking.securityDepositStatus !== "refunded") {
    persistSecurityDepositStatus(booking);
  }
  return booking;
}

export function persistSecurityDepositStatus(booking) {
  if (booking.securityDepositStatus === "refunded") return booking;
  if (!isDepositCollected(booking)) return booking;

  booking.securityDepositAmount = SECURITY_DEPOSIT_AMOUNT;
  const { deductedAmount } = computeDepositTotals(booking);
  booking.securityDepositStatus = deductedAmount > 0 ? "partially_used" : "held";
  return booking;
}

export function normalizePaidVia(value) {
  if (value === "deposit" || value === "e_transfer") return value;
  return undefined;
}

export function resolveCheckOutCompletedAt(booking, extras = {}) {
  if (extras.checkOutAt) return new Date(extras.checkOutAt);
  if (booking?.checkOutBillSnapshot?.capturedAt) {
    return new Date(booking.checkOutBillSnapshot.capturedAt);
  }
  const fromPhase = resolveCheckoutAt(booking, extras);
  if (fromPhase) return new Date(fromPhase);
  if (
    booking?.checkOutMileage != null &&
    (booking.status === "completed" || booking.status === "checked_out")
  ) {
    return booking.updatedAt ? new Date(booking.updatedAt) : null;
  }
  return null;
}

export function refundAvailableAt(checkOutAt) {
  if (!checkOutAt) return null;
  const next = new Date(checkOutAt);
  next.setDate(next.getDate() + SECURITY_DEPOSIT_HOLD_DAYS);
  return next;
}

export function assertDepositPaymentAllowed(booking, entry, paidVia, options = {}) {
  if (paidVia !== "deposit") return;

  if (entry?.entryType === "payment" || isCheckInPaymentEntry(entry)) {
    throw new ApiError(400, "Check-in rental payment cannot be taken from the security deposit");
  }

  if (!isDepositCollected(booking)) {
    throw new ApiError(400, "Security deposit has not been collected yet");
  }

  if (booking.securityDepositStatus === "refunded") {
    throw new ApiError(400, "Security deposit has already been refunded");
  }

  const amount = depositDeductionAmount(entry);
  const { remainingAmount } = computeDepositTotals(booking, options.excludeEntryId);
  if (amount - remainingAmount > 0.001) {
    throw new ApiError(
      400,
      `Charge of ${formatMoney(amount)} exceeds remaining security deposit of ${formatMoney(remainingAmount)}`,
    );
  }
}

export function assertCanRefundSecurityDeposit(booking, extras = {}) {
  if (!isDepositCollected(booking)) {
    throw new ApiError(400, "Security deposit has not been collected");
  }
  if (booking.securityDepositStatus === "refunded") {
    throw new ApiError(400, "Security deposit has already been refunded");
  }

  const checkOutAt = resolveCheckOutCompletedAt(booking, extras);
  if (!checkOutAt) {
    throw new ApiError(400, "Deposit refund is available only after check-out is complete");
  }

  const availableAt = refundAvailableAt(checkOutAt);
  if (availableAt && new Date() < availableAt) {
    throw new ApiError(
      400,
      `Deposit refund is available on ${availableAt.toISOString().slice(0, 10)} (15 days after check-out)`,
    );
  }
}

export function refundSecurityDeposit(booking, extras = {}) {
  assertCanRefundSecurityDeposit(booking, extras);
  const { remainingAmount } = computeDepositTotals(booking);
  booking.securityDepositStatus = "refunded";
  booking.securityDepositRefundedAt = new Date();
  booking.securityDepositRefundedAmount = remainingAmount;
  return booking;
}

export function formatSecurityDeposit(booking, extras = {}) {
  const collected = isDepositCollected(booking);
  const { amount, deductedAmount, remainingAmount } = computeDepositTotals(booking);
  const checkOutAt = resolveCheckOutCompletedAt(booking, extras);
  const availableAt = checkOutAt ? refundAvailableAt(checkOutAt) : null;
  const isRefunded = booking?.securityDepositStatus === "refunded";
  const status = !collected
    ? null
    : isRefunded
      ? "refunded"
      : deductedAmount > 0
        ? "partially_used"
        : "held";
  const canRefund = Boolean(
    collected && !isRefunded && checkOutAt && availableAt && new Date() >= availableAt,
  );

  return {
    amount,
    deductedAmount: collected ? deductedAmount : 0,
    remainingAmount: isRefunded ? 0 : collected ? remainingAmount : amount,
    refundedAmount: isRefunded
      ? money(booking.securityDepositRefundedAmount ?? remainingAmount)
      : null,
    status,
    heldAt: booking?.securityDepositHeldAt ?? null,
    refundedAt: booking?.securityDepositRefundedAt ?? null,
    checkOutAt: checkOutAt ?? null,
    refundAvailableAt: availableAt ?? null,
    canRefund,
    collected,
  };
}
