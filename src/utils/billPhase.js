export const BILL_PHASES = ["check_in", "check_out", "post"];

export function isCheckInPaymentEntry(entry) {
  if (entry?.entryType !== "payment" || entry.status === "refund") return false;
  const title = String(entry.title ?? "");
  if (/check[\s-]?out/i.test(title)) return false;
  return /check[\s-]?in/i.test(title);
}

export function isCheckOutPaymentEntry(entry) {
  if (entry?.entryType !== "payment" || entry.status === "refund") return false;
  return /check[\s-]?out/i.test(String(entry.title ?? ""));
}

export function isExtraMileageChargeEntry(entry) {
  if (entry?.systemKey === "extra_mileage") return true;
  return /extra\s*mileage|excess\s*km/i.test(String(entry?.title ?? ""));
}

export function isCheckInSystemCharge(entry) {
  if (entry?.entryType !== "charge" || entry.source !== "system") return false;
  if (isExtraMileageChargeEntry(entry)) return false;
  if (entry.systemKey === "cancellation_fee" || entry.systemKey === "cancellation_refund") return false;
  return entry.systemKey === "rental" || String(entry.systemKey ?? "").startsWith("service:");
}

export function entryCreatedAt(entry) {
  if (entry?.createdAt) return new Date(entry.createdAt);
  if (entry?._creationTime) return new Date(entry._creationTime);
  const id = entry?._id;
  if (id && typeof id.getTimestamp === "function") return id.getTimestamp();
  return null;
}

export function resolveCheckoutAt(booking, extras = {}) {
  if (extras.checkoutAt) return new Date(extras.checkoutAt);
  if (extras.checkOut?.createdAt) return new Date(extras.checkOut.createdAt);
  const entries = booking.billEntries ?? [];
  const checkoutPayment = entries.find(isCheckOutPaymentEntry);
  const extraMileage = entries.find(isExtraMileageChargeEntry);
  return entryCreatedAt(checkoutPayment) || entryCreatedAt(extraMileage);
}

export function isStoredPhase(phase) {
  return phase === "check_in" || phase === "check_out" || phase === "post";
}

export function phaseForNewEntry(booking, entry = {}) {
  if (entry.entryType === "payment") {
    if (isCheckOutPaymentEntry(entry)) return "check_out";
    if (isCheckInPaymentEntry(entry)) return "check_in";
  }
  if (isExtraMileageChargeEntry(entry)) return "check_out";
  if (isCheckInSystemCharge(entry)) return "check_in";
  if (booking?.status === "completed" || booking?.status === "cancelled") return "post";
  if (booking?.status === "checked_in" || booking?.status === "checked_out") return "check_out";
  return "post";
}

export function isPostBookingCharge(entry, booking = {}, extras = {}) {
  return inferBillEntryPhase(entry, booking, extras) === "post" && entry?.entryType === "charge";
}

function isStandaloneManualCharge(entry) {
  return (
    entry?.entryType === "charge" &&
    entry?.source === "manual" &&
    !isExtraMileageChargeEntry(entry)
  );
}

export function inferBillEntryPhase(entry, booking = {}, extras = {}) {
  if (isStandaloneManualCharge(entry) && entry.phase === "check_in") {
    return "post";
  }
  if (isStoredPhase(entry?.phase)) return entry.phase;
  if (entry?.entryType === "payment") {
    if (isCheckOutPaymentEntry(entry)) return "check_out";
    if (isCheckInPaymentEntry(entry)) return "check_in";
    return "post";
  }
  if (isExtraMileageChargeEntry(entry)) return "check_out";
  if (isCheckInSystemCharge(entry)) return "check_in";
  if (entry?.systemKey === "cancellation_fee" || entry?.systemKey === "cancellation_refund") {
    return "post";
  }
  if (entry?.entryType === "charge") {
    const created = entryCreatedAt(entry);
    const checkoutAt = resolveCheckoutAt(booking, extras);
    const entries = booking.billEntries ?? [];
    const checkoutHappened =
      Boolean(checkoutAt) ||
      booking.checkOutMileage != null ||
      booking.status === "completed" ||
      booking.status === "checked_out" ||
      entries.some(isCheckOutPaymentEntry) ||
      entries.some(isExtraMileageChargeEntry);
    if (
      booking.status === "completed" &&
      checkoutAt &&
      created &&
      created.getTime() > checkoutAt.getTime() + 15_000
    ) {
      return "post";
    }
    if (checkoutHappened) return "check_out";
    if (booking.status === "checked_in") return "check_out";
    return "post";
  }
  return "post";
}
