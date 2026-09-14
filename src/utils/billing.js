import { calculateTaxAmount, calculateGrandTotal, calculateRentalDays } from "./rentalPricing.js";
import { calculateServiceCharge } from "./serviceCharge.js";
import {
  calculateServicesAmountFromSnapshots,
  formatServiceSnapshotsForDetail,
  hasPricingSnapshot,
  buildLiveServiceDetailList,
  resolveBookedDailyRate,
} from "./bookingSnapshot.js";
import {
  inferBillEntryPhase,
  isCheckInPaymentEntry,
  isCheckOutPaymentEntry,
  isExtraMileageChargeEntry,
  phaseForNewEntry,
} from "./billPhase.js";

/**
 * @typedef {Object} BillEntryInput
 * @property {string} title
 * @property {string} [description]
 * @property {number} amount
 * @property {'charge'|'payment'} entryType
 * @property {'unpaid'|'paid'|'refund'} [status]
 * @property {'system'|'manual'} [source]
 * @property {string} [systemKey]
 */

function resolveEntryStatus(entry) {
  if (entry.status === "unpaid" || entry.status === "paid" || entry.status === "refund") {
    return entry.status;
  }
  return entry.paid ? "paid" : "unpaid";
}

/** Per-line totals for manual charges / invoices (amount is pre-tax subtotal). */
export function getBillEntryTotals(amount) {
  const subtotal = Math.round(Number(amount) * 100) / 100;
  const taxAmount = calculateTaxAmount(subtotal);
  const totalAmount = calculateGrandTotal(subtotal);
  return { subtotal, taxAmount, totalAmount };
}

export function resolveBillEntryTotalAmount(entry) {
  if (entry.totalAmount != null) return Number(entry.totalAmount) || 0;
  if (entry.entryType !== "charge") return Number(entry.amount) || 0;
  return getBillEntryTotals(entry.amount).totalAmount;
}

/**
 * @param {Array<Record<string, unknown>>} entries
 */
export function computeBillSummary(entries = []) {
  const list = entries ?? [];
  const charges = list.filter((e) => e.entryType === "charge");
  const payments = list.filter((e) => e.entryType === "payment");

  const chargeSubtotal = charges.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const taxAmount = calculateTaxAmount(chargeSubtotal);
  const totalBill = calculateGrandTotal(chargeSubtotal);

  const paymentTotal = payments
    .filter((e) => resolveEntryStatus(e) === "paid")
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const manualPaidCharges = charges
    .filter((e) => e.source === "manual" && resolveEntryStatus(e) === "paid")
    .reduce((sum, e) => sum + resolveBillEntryTotalAmount(e), 0);
  const refundTotal = list
    .filter((e) => resolveEntryStatus(e) === "refund")
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

  const netPayments = Math.max(0, Math.round((paymentTotal - refundTotal) * 100) / 100);
  const unpaidAfterPayments = Math.max(0, Math.round((totalBill - netPayments) * 100) / 100);
  const chargeCredit = Math.min(manualPaidCharges, unpaidAfterPayments);
  const totalPaid = Math.round((netPayments + chargeCredit) * 100) / 100;
  const totalUnpaid = Math.max(0, Math.round((totalBill - totalPaid) * 100) / 100);

  return {
    chargeSubtotal,
    taxAmount,
    totalBill,
    totalPaid,
    totalUnpaid,
  };
}

/**
 * Build system charge line items from booking pricing context.
 */
export function buildSystemChargeLines({
  days,
  baseAmount,
  serviceLines = [],
  extraMileageCharge = 0,
}) {
  /** @type {BillEntryInput[]} */
  const lines = [
    {
      title: "Vehicle Rental",
      description: `${days} day rental`,
      amount: baseAmount,
      entryType: "charge",
      source: "system",
      phase: "check_in",
      systemKey: "rental",
      status: "unpaid",
    },
  ];

  for (const svc of serviceLines) {
    const amount = calculateServiceCharge(svc, days, svc.quantity ?? 1);
    lines.push({
      title: svc.name,
      description: svc.category ? String(svc.category) : undefined,
      amount,
      entryType: "charge",
      source: "system",
      phase: "check_in",
      systemKey: `service:${svc._id}`,
      status: "unpaid",
    });
  }

  if (extraMileageCharge > 0) {
    lines.push({
      title: "Extra Mileage",
      description: "Overage charge at check-out",
      amount: extraMileageCharge,
      entryType: "charge",
      source: "system",
      phase: "check_out",
      systemKey: "extra_mileage",
      status: "unpaid",
    });
  }

  return lines;
}

/**
 * Replace system charge entries while preserving manual charges and all payments.
 * @param {import("../models/booking.model.js").Booking} booking
 * @param {BillEntryInput[]} systemLines
 */
export function applySystemBillEntries(booking, systemLines) {
  const existing = booking.billEntries ?? [];
  const preserved = existing.filter(
    (e) => e.entryType === "payment" || (e.entryType === "charge" && e.source === "manual"),
  );

  const systemKeys = new Set(systemLines.map((l) => l.systemKey));
  const mergedSystem = systemLines.map((line) => {
    const prev = existing.find((e) => e.systemKey === line.systemKey && e.source === "system");
    return {
      ...(prev?.toObject?.() ?? prev ?? {}),
      ...line,
      source: "system",
      entryType: "charge",
      phase: line.phase ?? prev?.phase ?? inferBillEntryPhase({ ...prev, ...line }, booking),
      status: "unpaid",
    };
  });

  booking.billEntries = [...mergedSystem, ...preserved];
  return booking;
}

/**
 * @param {import("../models/booking.model.js").Booking} booking
 * @param {import("../models/car.model.js").Car | null} [car]
 */
export async function syncBookingBillEntries(booking, car = null) {
  const days = calculateRentalDays(
    booking.pickupDate,
    booking.pickupTime,
    booking.returnDate,
    booking.returnTime,
  );

  let baseAmount;
  let serviceLines;

  if (hasPricingSnapshot(booking)) {
    serviceLines = formatServiceSnapshotsForDetail(booking.serviceSnapshots);
    baseAmount = (booking.bookedDailyRate ?? 0) * days;
  } else if (car) {
    serviceLines = await buildLiveServiceDetailList(booking);
    baseAmount = resolveBookedDailyRate(booking, car) * days;
  } else {
    serviceLines = formatServiceSnapshotsForDetail(booking.serviceSnapshots ?? []);
    baseAmount = (booking.bookedDailyRate ?? 0) * days;
  }

  const extraMileageCharge = booking.extraMileageCharge ?? 0;
  const systemLines = buildSystemChargeLines({
    days,
    baseAmount,
    serviceLines,
    extraMileageCharge,
  });

  applySystemBillEntries(booking, systemLines);

  const summary = computeBillSummary(booking.billEntries);
  booking.totalAmount = summary.totalBill;
  booking.paymentStatus = summary.totalUnpaid <= 0 && summary.totalBill > 0 ? "paid" : "pending";

  return { days, baseAmount, servicesAmount: calculateServicesAmountFromSnapshots(
    hasPricingSnapshot(booking) ? booking.serviceSnapshots : [],
    days,
  ) || serviceLines.reduce(
    (sum, s) => sum + calculateServiceCharge(s, days, s.quantity ?? 1),
    0,
  ), extraMileageCharge, summary };
}

/**
 * @param {import("../models/booking.model.js").Booking} booking
 * @param {BillEntryInput & { createdByUserId?: unknown; createdByName?: string; createdByRole?: string }} entry
 */
export function appendBillEntry(booking, entry) {
  if (!booking.billEntries) booking.billEntries = [];

  const amount = Math.round(Number(entry.amount) * 100) / 100;
  const chargeTotals = entry.entryType === "charge" ? getBillEntryTotals(amount) : null;

  booking.billEntries.push({
    title: entry.title,
    description: entry.description,
    amount,
    entryType: entry.entryType,
    status:
      entry.status ??
      (entry.entryType === "payment" ? "paid" : "unpaid"),
    source: entry.source ?? "manual",
    phase: entry.phase ?? phaseForNewEntry(booking, { ...entry, entryType: entry.entryType }),
    systemKey: entry.systemKey,
    createdByUserId: entry.createdByUserId,
    createdByName: entry.createdByName,
    createdByRole: entry.createdByRole,
    taxAmount: chargeTotals?.taxAmount,
    totalAmount: chargeTotals?.totalAmount,
    invoiceNumber: entry.invoiceNumber,
    invoicePdfUrl: entry.invoicePdfUrl,
    paidVia: entry.paidVia,
    attachmentUrl: entry.attachmentUrl,
    attachmentName: entry.attachmentName,
  });

  const summary = computeBillSummary(booking.billEntries);
  booking.totalAmount = summary.totalBill;
  booking.paymentStatus = summary.totalUnpaid <= 0 && summary.totalBill > 0 ? "paid" : "pending";
  return summary;
}

function toBillSnapshotEntry(entry) {
  const obj = entry?.toObject ? entry.toObject() : entry;
  return {
    entryId: obj._id != null ? String(obj._id) : obj.entryId,
    title: obj.title,
    description: obj.description,
    amount: obj.amount,
    entryType: obj.entryType,
    status: obj.status,
    source: obj.source,
    phase: obj.phase,
    systemKey: obj.systemKey,
    createdByUserId: obj.createdByUserId,
    createdByName: obj.createdByName,
    createdByRole: obj.createdByRole,
    taxAmount: obj.taxAmount,
    totalAmount: obj.totalAmount,
    invoiceNumber: obj.invoiceNumber,
    invoicePdfUrl: obj.invoicePdfUrl,
    paidVia: obj.paidVia,
    attachmentUrl: obj.attachmentUrl,
    attachmentName: obj.attachmentName,
  };
}

function snapshotFieldForPhase(phase) {
  return phase === "check_out" ? "checkOutBillSnapshot" : "checkInBillSnapshot";
}

/** Freeze the bill lines that existed at check-in or check-out. Later post-booking entries stay off this record. */
export function capturePhaseBillSnapshot(booking, phase, extras = {}) {
  const field = snapshotFieldForPhase(phase);
  const entries = (booking.billEntries ?? [])
    .filter((entry) => {
      if (inferBillEntryPhase(entry, booking, extras) === phase) return true;
      if (phase === "check_in" && isCheckInPaymentEntry(entry)) return true;
      if (phase === "check_out" && (isCheckOutPaymentEntry(entry) || isExtraMileageChargeEntry(entry))) {
        return true;
      }
      return false;
    })
    .map(toBillSnapshotEntry);
  booking[field] = { capturedAt: new Date(), entries };
  return booking[field];
}

export function ensurePhaseBillSnapshot(booking, phase, extras = {}) {
  const field = snapshotFieldForPhase(phase);
  if (booking[field]?.capturedAt) return booking[field];
  return capturePhaseBillSnapshot(booking, phase, extras);
}

/** Use the frozen check-in/check-out record when present; otherwise infer from live entries. */
export function resolvePhaseBillEntries(booking, phase, extras = {}) {
  const field = snapshotFieldForPhase(phase);
  const snap = booking[field];
  if (snap?.capturedAt && Array.isArray(snap.entries)) {
    return snap.entries.map((item) => ({
      ...item,
      _id: item.entryId || item._id,
      phase: item.phase || phase,
    }));
  }
  return (booking.billEntries ?? []).filter(
    (entry) => inferBillEntryPhase(entry, booking, extras) === phase,
  );
}

export function formatBillEntries(entries = [], booking = {}) {
  return (entries ?? []).map((entry) => {
    const obj = entry.toObject ? entry.toObject() : entry;
    return {
      _id: String(obj._id),
      title: obj.title,
      description: obj.description ?? undefined,
      amount: obj.amount,
      entryType: obj.entryType,
      status: resolveEntryStatus(obj),
      source: obj.source ?? "manual",
      phase: inferBillEntryPhase(obj, booking),
      systemKey: obj.systemKey ?? undefined,
      taxAmount: obj.taxAmount ?? undefined,
      totalAmount: obj.totalAmount ?? undefined,
      invoiceNumber: obj.invoiceNumber ?? undefined,
      invoicePdfUrl: obj.invoicePdfUrl ?? undefined,
      paidVia: obj.paidVia === "deposit" || obj.paidVia === "e_transfer" ? obj.paidVia : undefined,
      attachmentUrl: obj.attachmentUrl ?? undefined,
      attachmentName: obj.attachmentName ?? undefined,
      createdByUserId: obj.createdByUserId?.toString?.() ?? undefined,
      createdByName: obj.createdByName ?? undefined,
      createdByRole: obj.createdByRole ?? undefined,
      createdBy:
        obj.createdByUserId || obj.createdByName || obj.createdByRole
          ? {
              userId: obj.createdByUserId?.toString?.() ?? "",
              name: obj.createdByName ?? null,
              role: obj.createdByRole ?? "customer",
            }
          : undefined,
      _creationTime: obj.createdAt ? new Date(obj.createdAt).getTime() : Date.now(),
    };
  });
}

/** Fill missing bill-line actor names from User (older rows stored id + role only). */
export async function formatBillEntriesWithActors(entries, booking, User) {
  const formatted = formatBillEntries(entries, booking);
  const missingIds = [
    ...new Set(
      formatted
        .filter((entry) => entry.createdByUserId && !entry.createdByName)
        .map((entry) => entry.createdByUserId),
    ),
  ];
  if (!User || missingIds.length === 0) return formatted;

  const users = await User.find({ _id: { $in: missingIds } }).select("name email");
  const names = new Map(
    users.map((user) => [user._id.toString(), user.name?.trim() || user.email || null]),
  );

  return formatted.map((entry) => {
    if (entry.createdByName || !entry.createdByUserId) return entry;
    const name = names.get(entry.createdByUserId) ?? null;
    if (!name) return entry;
    return {
      ...entry,
      createdByName: name,
      createdBy: {
        userId: entry.createdByUserId,
        name,
        role: entry.createdByRole ?? entry.createdBy?.role ?? "customer",
      },
    };
  });
}
