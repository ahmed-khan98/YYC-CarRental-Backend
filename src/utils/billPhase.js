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
  // Plain/lean docs often have string ids — decode Mongo ObjectId timestamp (first 4 bytes).
  const hex = typeof id === "string" ? id : id?.toString?.();
  if (hex && /^[a-fA-F0-9]{24}$/.test(hex)) {
    return new Date(parseInt(hex.slice(0, 8), 16) * 1000);
  }
  return null;
}

export function resolveCheckoutAt(booking, extras = {}) {
  if (extras.checkoutAt) return new Date(extras.checkoutAt);
  if (extras.checkOut?.createdAt) return new Date(extras.checkOut.createdAt);
  if (extras.checkOut?._creationTime) return new Date(extras.checkOut._creationTime);
  const entries = booking.billEntries ?? [];
  const checkoutPayment = entries.find(isCheckOutPaymentEntry);
  const extraMileage = entries.find(isExtraMileageChargeEntry);
  return entryCreatedAt(checkoutPayment) || entryCreatedAt(extraMileage);
}

export function resolveCheckInAt(booking, extras = {}) {
  if (extras.checkInAt) return new Date(extras.checkInAt);
  if (extras.checkIn?.createdAt) return new Date(extras.checkIn.createdAt);
  if (extras.checkIn?._creationTime) return new Date(extras.checkIn._creationTime);
  const entries = booking.billEntries ?? [];
  const checkInPayment = entries.find(isCheckInPaymentEntry);
  return entryCreatedAt(checkInPayment);
}

/**
 * Invoice "Date issued" must be the event time, not download/regeneration time.
 * - check_in → inspection / check-in payment time
 * - check_out → inspection / check-out payment time
 * - full → check-out (or check-in) time
 * - single charge/payment → bill entry create time (ObjectId timestamp fallback)
 */
export function resolveInvoiceIssuedAt(booking, entry, kind, extras = {}) {
  if (kind === "check_in") {
    return (
      resolveCheckInAt(booking, extras) ||
      entryCreatedAt(entry) ||
      (booking?.createdAt ? new Date(booking.createdAt) : null) ||
      new Date()
    );
  }
  if (kind === "check_out") {
    return (
      resolveCheckoutAt(booking, extras) ||
      entryCreatedAt(entry) ||
      resolveCheckInAt(booking, extras) ||
      new Date()
    );
  }
  if (kind === "full") {
    return (
      resolveCheckoutAt(booking, extras) ||
      resolveCheckInAt(booking, extras) ||
      (booking?.updatedAt ? new Date(booking.updatedAt) : null) ||
      (booking?.createdAt ? new Date(booking.createdAt) : null) ||
      new Date()
    );
  }
  return entryCreatedAt(entry) || new Date();
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
