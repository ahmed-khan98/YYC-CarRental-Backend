import { combineDateAndTime } from "./rentalPricing.js";
import { resolveBookedDailyRate } from "./bookingSnapshot.js";
import {
  appendBillEntry,
  computeBillSummary,
  getBillEntryTotals,
} from "./billing.js";

export const CANCELLATION_NOTICE_HOURS = 72;
const MS_PER_HOUR = 60 * 60 * 1000;

export function getPickupDateTime(booking) {
  return combineDateAndTime(booking.pickupDate, booking.pickupTime ?? "00:00");
}

export function getHoursUntilPickup(booking, now = new Date()) {
  const pickup = getPickupDateTime(booking);
  return (pickup.getTime() - now.getTime()) / MS_PER_HOUR;
}

export function resolveCancellationPolicy(booking, now = new Date()) {
  const hoursUntilPickup = getHoursUntilPickup(booking, now);
  if (hoursUntilPickup < 0) {
    return { type: "past_pickup", hoursUntilPickup };
  }
  if (hoursUntilPickup >= CANCELLATION_NOTICE_HOURS) {
    return { type: "one_day_fee", hoursUntilPickup };
  }
  return { type: "non_refundable", hoursUntilPickup };
}

function formatCad(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function buildCancellationResult({
  policy,
  feeSubtotal,
  feeTotal,
  amountDue,
  refundAmount = 0,
}) {
  let message;
  if (policy === "non_refundable") {
    message = `Cancelled within 72 hours of pick-up. Full booking amount of ${formatCad(feeTotal)} is due (non-refundable).`;
  } else if (refundAmount > 0) {
    message = `Cancelled 72+ hours before pick-up. 1-day fee ${formatCad(feeTotal)} applies. Refund of ${formatCad(refundAmount)} will be processed for any amount already paid.`;
  } else {
    message = `Cancelled 72+ hours before pick-up. 1-day cancellation fee of ${formatCad(feeTotal)} is due. No payment is taken at booking — this amount is payable separately.`;
  }

  return {
    policy,
    feeSubtotal,
    feeTotal,
    amountDue,
    refundAmount,
    message,
  };
}

export function applyUserCancellationBilling(booking, car) {
  const policy = resolveCancellationPolicy(booking);
  const existingEntries = booking.billEntries ?? [];
  const payments = existingEntries.filter((entry) => entry.entryType === "payment");
  const manualCharges = existingEntries.filter(
    (entry) => entry.entryType === "charge" && entry.source === "manual",
  );

  if (policy.type === "non_refundable") {
    const summary = computeBillSummary(existingEntries);
    booking.totalAmount = summary.totalBill;
    booking.paymentStatus =
      summary.totalUnpaid <= 0 && summary.totalBill > 0 ? "paid" : "pending";

    return buildCancellationResult({
      policy: policy.type,
      feeSubtotal: summary.chargeSubtotal,
      feeTotal: summary.totalBill,
      amountDue: summary.totalUnpaid,
    });
  }

  const dailyRate = resolveBookedDailyRate(booking, car);
  const feeTotals = getBillEntryTotals(dailyRate);

  booking.billEntries = [
    {
      title: "Cancellation Fee",
      description: "1 day rental fee — cancelled 72+ hours before pick-up",
      amount: feeTotals.subtotal,
      entryType: "charge",
      source: "system",
      systemKey: "cancellation_fee",
      status: "unpaid",
      taxAmount: feeTotals.taxAmount,
      totalAmount: feeTotals.totalAmount,
    },
    ...manualCharges,
    ...payments,
  ];

  let summary = computeBillSummary(booking.billEntries);
  booking.totalAmount = summary.totalBill;

  let refundAmount = 0;
  if (summary.totalPaid > summary.totalBill) {
    refundAmount = Math.round((summary.totalPaid - summary.totalBill) * 100) / 100;
    appendBillEntry(booking, {
      title: "Cancellation Refund",
      description: "Refund after 1-day cancellation fee",
      amount: refundAmount,
      entryType: "payment",
      status: "refund",
      source: "system",
      systemKey: "cancellation_refund",
    });
    summary = computeBillSummary(booking.billEntries);
    booking.totalAmount = summary.totalBill;
  }

  booking.paymentStatus =
    refundAmount > 0
      ? "refunded"
      : summary.totalUnpaid <= 0 && summary.totalBill > 0
        ? "paid"
        : "pending";

  return buildCancellationResult({
    policy: policy.type,
    feeSubtotal: feeTotals.subtotal,
    feeTotal: feeTotals.totalAmount,
    amountDue: summary.totalUnpaid,
    refundAmount,
  });
}

export function buildCancellationPreview(booking, car) {
  const policy = resolveCancellationPolicy(booking);

  if (policy.type === "past_pickup") {
    return {
      ...policy,
      canCancel: false,
      message: "Cancellation is not available after pick-up time.",
    };
  }

  const summary = computeBillSummary(booking.billEntries ?? []);
  const hasPaid = summary.totalPaid > 0;

  if (policy.type === "non_refundable") {
    return {
      ...policy,
      canCancel: true,
      feeSubtotal: summary.chargeSubtotal,
      feeTotal: summary.totalBill,
      amountDue: summary.totalUnpaid,
      refundAmount: 0,
      message: hasPaid
        ? `Within 72 hours of pick-up — full booking amount ${formatCad(summary.totalBill)} applies. No refund.`
        : `Within 72 hours of pick-up — full booking amount ${formatCad(summary.totalBill)} will be due. Payment is collected at check-in; since you are cancelling, this full amount is still payable.`,
    };
  }

  const dailyRate = resolveBookedDailyRate(booking, car);
  const feeTotals = getBillEntryTotals(dailyRate);
  const refundAmount = Math.max(
    0,
    Math.round((summary.totalPaid - feeTotals.totalAmount) * 100) / 100,
  );
  const amountDue = hasPaid
    ? Math.max(0, Math.round((feeTotals.totalAmount - summary.totalPaid) * 100) / 100)
    : feeTotals.totalAmount;

  return {
    ...policy,
    canCancel: true,
    feeSubtotal: feeTotals.subtotal,
    feeTotal: feeTotals.totalAmount,
    amountDue,
    refundAmount,
    message: hasPaid
      ? refundAmount > 0
        ? `72+ hours before pick-up — 1-day fee ${formatCad(feeTotals.totalAmount)}. Estimated refund: ${formatCad(refundAmount)}.`
        : `72+ hours before pick-up — 1-day fee ${formatCad(feeTotals.totalAmount)} is due.`
      : `72+ hours before pick-up — 1-day cancellation fee ${formatCad(feeTotals.totalAmount)} will be due. No payment is taken at booking.`,
  };
}
