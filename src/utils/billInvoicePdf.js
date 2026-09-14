import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import PizZip from "pizzip";
import { Car } from "../models/car.model.js";
import { Location } from "../models/location.model.js";
import { User } from "../models/user.model.js";
import { VehicleInspection } from "../models/vehicleInspection.model.js";
import { uploadPdfToStorage } from "../utils/localFileStore.js";
import { formatAppDateTime } from "./timeFormat.js";
import {
  getBillEntryTotals,
  resolveBillEntryTotalAmount,
  resolvePhaseBillEntries,
} from "./billing.js";
import {
  inferBillEntryPhase,
  isCheckInPaymentEntry,
  isCheckInSystemCharge,
  isCheckOutPaymentEntry,
  isExtraMileageChargeEntry,
} from "./billPhase.js";

export {
  entryCreatedAt,
  inferBillEntryPhase,
  isCheckInPaymentEntry,
  isCheckInSystemCharge,
  isCheckOutPaymentEntry,
  isExtraMileageChargeEntry,
  isPostBookingCharge,
  resolveCheckoutAt,
} from "./billPhase.js";
import { calculateRentalDays, calculateTaxAmount, calculateGrandTotal } from "./rentalPricing.js";
import { calculateServiceCharge } from "./serviceCharge.js";
import { isExtraDriverService } from "./extraDriver.js";
import {
  formatServiceSnapshotsForDetail,
  resolveBookedDailyRate,
  resolveBookedChargePerExtraKm,
  resolveBookedDailyMileageLimit,
} from "./bookingSnapshot.js";
import { buildMainDriverCheckInDefaults } from "./mainDriver.js";
import { convertDocxToPdf } from "./docxToPdf.js";

function formatCarCategoryLabel(category) {
  const raw = String(category ?? "").trim();
  if (!raw) return "";
  if (/^suv$/i.test(raw)) return "SUV";
  return raw
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function rentalLineLabel(car, booking) {
  const category =
    car?.category ??
    booking?.car?.category ??
    car?.type ??
    booking?.car?.type ??
    booking?.bookedCarCategory;
  const label = formatCarCategoryLabel(category);
  return `${label || "Vehicle"} Rental`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "../../assets/bill-invoice-template.docx");

const FUEL_LABELS = {
  empty: "Empty",
  quarter: "1/4 Tank",
  half: "1/2 Tank",
  three_quarter: "3/4 Tank",
  full: "Full Tank",
};

const INVOICE_ZEBRA_WHITE = "FFFFFF";
const INVOICE_ZEBRA_GREY = "F2F2F2";
const INVOICE_ROW_BORDER_XML =
  `<w:tcBorders>` +
  `<w:top w:val="single" w:sz="8" w:space="0" w:color="C8C8C8"/>` +
  `<w:left w:val="single" w:sz="4" w:space="0" w:color="C8C8C8"/>` +
  `<w:bottom w:val="single" w:sz="8" w:space="0" w:color="C8C8C8"/>` +
  `<w:right w:val="single" w:sz="4" w:space="0" w:color="C8C8C8"/>` +
  `</w:tcBorders>`;
const INVOICE_ROW_TR_BORDERS_XML =
  `<w:trBorders>` +
  `<w:top w:val="single" w:sz="8" w:space="0" w:color="C8C8C8"/>` +
  `<w:bottom w:val="single" w:sz="8" w:space="0" w:color="C8C8C8"/>` +
  `</w:trBorders>`;

function moneyNum(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

function moneyLabel(amount) {
  const formatted = formatMoney(amount);
  return formatted ? `$${formatted}` : "";
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatPhoneForTemplate(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) return digits.slice(1);
  return digits;
}

function buildHomeAddress(mainDriver) {
  return [
    mainDriver?.homeAddressLine1,
    mainDriver?.homeAddressLine2,
    mainDriver?.homeAddressLine3,
  ]
    .filter(Boolean)
    .join(", ");
}

function normalizeTimeTo24h(timeStr) {
  if (!timeStr) return "00:00";
  const raw = String(timeStr).trim();
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (h24) return `${Number(h24[1])}:${h24[2]}`;
  const h12 = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(raw);
  if (h12) {
    let hours = Number(h12[1]) % 12;
    if (h12[3].toUpperCase() === "PM") hours += 12;
    return `${hours}:${h12[2]}`;
  }
  return raw;
}

function formatTimeForDisplay(timeStr) {
  const normalized = normalizeTimeTo24h(timeStr);
  const [hours, minutes] = normalized.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return timeStr ?? "";
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${period}`;
}

function normalizeBookingDate(dateStr) {
  if (!dateStr) return "";
  if (dateStr instanceof Date) return dateStr.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(dateStr));
  return match ? match[1] : String(dateStr);
}

function formatScheduleDate(dateStr, timeStr) {
  const normalized = normalizeBookingDate(dateStr);
  if (!normalized) return "";
  const [y, m, d] = normalized.split("-").map(Number);
  if (!y || !m || !d) return normalized;
  const date = new Date(y, m - 1, d);
  const formatted = date.toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return timeStr ? `${formatted} ${formatTimeForDisplay(timeStr)}` : formatted;
}

function fuelLabel(level) {
  if (!level) return "";
  return FUEL_LABELS[level] ?? String(level);
}

export function getBookingPublicNumber(bookingOrId) {
  const id = bookingOrId?._id ?? bookingOrId;
  return String(id).slice(-8).toUpperCase();
}

export function parseInvoiceSequence(invoiceNumber) {
  if (!invoiceNumber) return 0;
  const match = /-(\d+)$/.exec(String(invoiceNumber));
  return match ? Number(match[1]) : 0;
}

export function buildInvoiceNumber(bookingOrId, seq) {
  return `${getBookingPublicNumber(bookingOrId)}-${Number(seq)}`;
}

export function ensureInvoiceSequence(booking) {
  const current = Number(booking.invoiceSequence) || 0;
  const maxUsed = Math.max(
    0,
    ...(booking.billEntries ?? []).map((entry) => parseInvoiceSequence(entry.invoiceNumber)),
  );
  booking.invoiceSequence = Math.max(current, maxUsed);
  return booking.invoiceSequence;
}

export function assignInvoiceNumber(booking, entry, extras = {}) {
  entry.phase = inferBillEntryPhase(entry, booking, extras);
  if (entry.invoiceNumber) {
    booking.invoiceSequence = Math.max(
      ensureInvoiceSequence(booking),
      parseInvoiceSequence(entry.invoiceNumber),
    );
    return entry.invoiceNumber;
  }
  ensureInvoiceSequence(booking);
  const next = (Number(booking.invoiceSequence) || 0) + 1;
  booking.invoiceSequence = next;
  entry.invoiceNumber = buildInvoiceNumber(booking, next);
  return entry.invoiceNumber;
}

export function canHaveInvoice(entry) {
  if (entry?.entryType === "payment") return true;
  if (entry?.entryType !== "charge") return false;
  if (entry.systemKey === "cancellation_fee" || entry.systemKey === "cancellation_refund") return true;
  if (entry.systemKey === "extra_mileage") return false;
  if (entry.phase === "check_out") return false;
  return entry.source === "manual";
}

export function isCheckoutTimeCharge(entry, booking = {}, extras = {}) {
  if (entry?.entryType !== "charge" || entry.status === "refund") return false;
  return inferBillEntryPhase(entry, booking, extras) === "check_out";
}

export function resolveInvoiceKind(entry) {
  if (isCheckInPaymentEntry(entry)) return "check_in";
  if (isCheckOutPaymentEntry(entry)) return "check_out";
  if (entry?.entryType === "payment") return "payment";
  return "single";
}

function serviceQtyLabel(snapshot, days) {
  const qty = Math.max(1, Number(snapshot?.quantity) || 1);
  if (snapshot?.chargeType === "per_trip") return String(qty);
  return qty > 1 ? `${days || 1} × ${qty}` : String(days || 1);
}

function systemChargeToLine(entry, booking, car, days) {
  const snapshots = formatServiceSnapshotsForDetail(booking.serviceSnapshots ?? []);
  if (entry.systemKey === "rental") {
    return {
      description: rentalLineLabel(car, booking) || entry.title,
      detail: entry.description,
      rate: resolveBookedDailyRate(booking, car),
      qtyLabel: days ? String(days) : "1",
      amount: moneyNum(entry.amount),
    };
  }
  if (String(entry.systemKey ?? "").startsWith("service:")) {
    const serviceId = String(entry.systemKey).slice("service:".length);
    const snapshot = snapshots.find((item) => item._id === serviceId);
    return {
      description: entry.title,
      detail: entry.description,
      rate: snapshot?.dailyRate ?? moneyNum(entry.amount),
      qtyLabel: serviceQtyLabel(snapshot, days),
      amount: moneyNum(entry.amount),
    };
  }
  return {
    description: entry.title,
    detail: entry.description,
    rate: moneyNum(entry.amount),
    qtyLabel: "1",
    amount: moneyNum(entry.amount),
  };
}

function extraMileageLine(entry, booking, car) {
  const rate = resolveBookedChargePerExtraKm(booking, car);
  const km = booking.extraMileageKm;
  return {
    description: entry.title || "Extra Mileage",
    detail:
      entry.description ||
      (km != null ? `${km} km over the included allowance` : "Overage charge at check-out"),
    rate: rate ?? moneyNum(entry.amount),
    qtyLabel: km != null ? `${km} km` : "1",
    amount: moneyNum(entry.amount),
  };
}

export function paidViaInvoiceNote(entry) {
  if (entry?.paidVia === "deposit") return "Paid from security deposit";
  if (entry?.paidVia === "e_transfer") return "Customer to pay by e-transfer";
  return "";
}

function paidViaInvoiceNotes(entry) {
  const note = paidViaInvoiceNote(entry);
  return note ? [note] : [];
}

function standaloneLine(entry) {
  const methodNote = paidViaInvoiceNote(entry);
  const detail = [entry.description, methodNote].filter(Boolean).join(" — ");
  return {
    description: entry.title,
    detail: detail || undefined,
    rate: moneyNum(entry.amount),
    qtyLabel: "1",
    amount: moneyNum(entry.amount),
  };
}

function paymentStatusLabel(status) {
  if (status === "paid") return "Paid";
  if (status === "refund") return "Refund";
  return "Pending";
}

function snapshotPaymentTotal(snapshot) {
  return (snapshot?.entries ?? [])
    .filter((item) => item.entryType === "payment" && item.status !== "refund")
    .reduce((sum, item) => sum + moneyNum(item.amount), 0);
}

function resolveCheckInPaidForInvoice(booking, extras = {}) {
  const fromSnapshot = snapshotPaymentTotal(booking.checkInBillSnapshot);
  if (fromSnapshot > 0) return fromSnapshot;
  const live = (booking.billEntries ?? [])
    .filter(isCheckInPaymentEntry)
    .reduce((sum, item) => sum + moneyNum(item.amount), 0);
  if (live > 0) return live;
  return phasePaymentTotal(booking, extras, "check_in");
}

function isLiveCheckOutPayment(entry) {
  if (entry?.entryType !== "payment" || entry.status === "refund") return false;
  return isCheckOutPaymentEntry(entry) || entry.phase === "check_out";
}

function liveCheckOutPaymentTotal(booking) {
  return (booking.billEntries ?? [])
    .filter(isLiveCheckOutPayment)
    .reduce((sum, item) => sum + moneyNum(item.amount), 0);
}

function resolveCheckOutPaidForInvoice(booking, extras = {}) {
  const fromSnapshot = snapshotPaymentTotal(booking.checkOutBillSnapshot);
  if (fromSnapshot > 0) return fromSnapshot;
  const live = liveCheckOutPaymentTotal(booking);
  if (live > 0) return live;
  return phasePaymentTotal(booking, extras, "check_out");
}

function checkoutSnapshotIsComplete(booking) {
  const snap = booking.checkOutBillSnapshot;
  if (!snap?.capturedAt || !Array.isArray(snap.entries)) return false;
  if (liveCheckOutPaymentTotal(booking) > 0 && snapshotPaymentTotal(snap) === 0) return false;
  if (moneyNum(booking.extraMileageCharge) > 0 && !snap.entries.some(isExtraMileageChargeEntry)) {
    return false;
  }
  return true;
}

function resolveCheckoutChargeEntries(booking, extras = {}) {
  if (checkoutSnapshotIsComplete(booking)) {
    return (booking.checkOutBillSnapshot.entries ?? []).filter(
      (item) => item.entryType === "charge" && item.status !== "refund",
    );
  }
  return (booking.billEntries ?? []).filter((item) => {
    if (item.entryType !== "charge" || item.status === "refund") return false;
    return inferBillEntryPhase(item, booking, extras) === "check_out";
  });
}

function totalsFromLines(lines, paymentReceived, fallbackStatus) {
  const taxable = lines.filter((line) => !line.taxInclusive && !line.payment);
  const carried = moneyNum(
    lines.filter((line) => line.taxInclusive).reduce((sum, line) => sum + Number(line.amount || 0), 0),
  );
  const subtotal = moneyNum(taxable.reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const taxAmount = calculateTaxAmount(subtotal);
  const totalAmount = moneyNum(calculateGrandTotal(subtotal) + carried);
  const paid = moneyNum(Math.min(totalAmount, Number(paymentReceived) || 0));
  const amountDue = Math.max(0, moneyNum(totalAmount - paid));
  const status =
    fallbackStatus ??
    (totalAmount <= 0 || amountDue <= 0 ? "paid" : "pending");
  return {
    subtotal,
    taxAmount,
    totalAmount,
    paymentReceived: paid,
    amountDue,
    status,
    statusLabel: paymentStatusLabel(status),
  };
}

function phasePaymentTotal(booking, extras, phase) {
  return resolvePhaseBillEntries(booking, phase, extras)
    .filter((item) => item.entryType === "payment" && item.status !== "refund")
    .reduce((sum, item) => sum + moneyNum(item.amount), 0);
}

function buildPaymentNotes(checkInPaid, checkOutPaid) {
  const notes = [];
  if (checkInPaid > 0) notes.push(`Paid at check-in: ${moneyLabel(checkInPaid)}`);
  if (checkOutPaid > 0) notes.push(`Paid at check-out: ${moneyLabel(checkOutPaid)}`);
  return notes;
}

function excessKmPlaceholderLine(booking, car, days) {
  const dailyLimit = resolveBookedDailyMileageLimit(booking, car);
  const includedKm =
    dailyLimit != null && Number.isFinite(Number(dailyLimit))
      ? Math.round(Number(dailyLimit) * (days || 0))
      : null;
  const rate = resolveBookedChargePerExtraKm(booking, car);
  if (includedKm == null && (rate == null || !Number.isFinite(Number(rate)))) return null;
  const kmText = includedKm != null ? `${includedKm} km` : "included km";
  const rateText = rate != null ? `$${Number(rate).toFixed(2)}/km` : "$—/km";
  return {
    description: `Excess KM over ${kmText} @ ${rateText} — calculated at return`,
    rate: rate ?? 0,
    qtyLabel: "—",
    amount: 0,
  };
}

function buildCheckInInvoiceLines(booking, car, days) {
  const dailyRate = resolveBookedDailyRate(booking, car) || 0;
  const rentalAmount = moneyNum(dailyRate * (days || 0));
  const snapshots = formatServiceSnapshotsForDetail(booking.serviceSnapshots ?? []);
  const lines = [
    {
      description: rentalLineLabel(car, booking),
      rate: dailyRate,
      qtyLabel: days ? String(days) : "1",
      amount: rentalAmount,
    },
  ];

  const addOnServices = snapshots.filter((service) => !isExtraDriverService(service));
  const extraDrivers = snapshots.filter((service) => isExtraDriverService(service));

  for (const snapshot of [...addOnServices, ...extraDrivers]) {
    const qty = Math.max(1, Number(snapshot.quantity) || 1);
    const amount = calculateServiceCharge(snapshot, days, qty);
    lines.push({
      description: isExtraDriverService(snapshot) ? "Additional Driver Fee" : snapshot.name,
      rate: snapshot.dailyRate,
      qtyLabel: serviceQtyLabel(snapshot, days),
      amount: moneyNum(amount),
    });
  }

  const excessKm = excessKmPlaceholderLine(booking, car, days);
  if (excessKm) lines.push(excessKm);
  return lines;
}

function buildCheckInInvoiceScope(booking, extras = {}) {
  const car = extras.car ?? booking.car ?? null;
  const days = calculateRentalDays(
    booking.pickupDate,
    booking.pickupTime,
    booking.returnDate,
    booking.returnTime,
  );
  let lines = buildCheckInInvoiceLines(booking, car, days);
  if (!lines.some((line) => Number(line.amount) > 0)) {
    const entries = resolvePhaseBillEntries(booking, "check_in", extras).filter(
      (item) => item.entryType !== "payment" && item.status !== "refund",
    );
    lines = entries.map((item) => chargeLineForEntry(item, booking, car, days));
  }
  const checkInPaid = resolveCheckInPaidForInvoice(booking, extras);
  return {
    kind: "check_in",
    title: "Check-In Invoice",
    lines,
    checkoutDetails: null,
    checkInPaid,
    paymentNotes: [],
    ...totalsFromLines(lines, checkInPaid),
  };
}

function buildCheckOutInvoiceScope(booking, extras = {}) {
  const car = extras.car ?? booking.car ?? null;
  const days = calculateRentalDays(
    booking.pickupDate,
    booking.pickupTime,
    booking.returnDate,
    booking.returnTime,
  );
  const chargeEntries = resolveCheckoutChargeEntries(booking, extras);
  const lines = [];

  const checkInInvoice = buildCheckInInvoiceScope(booking, extras);
  const previousBalance = moneyNum(checkInInvoice.amountDue);
  if (previousBalance > 0) {
    lines.push({
      description: "Balance from Check-In Invoice",
      detail: `Unpaid after check-in payment of ${moneyLabel(checkInInvoice.checkInPaid)}`,
      rate: previousBalance,
      qtyLabel: "1",
      amount: previousBalance,
      taxInclusive: true,
    });
  }

  const extraFromSnap = chargeEntries.find(isExtraMileageChargeEntry);
  const extraAmount = moneyNum(
    booking.extraMileageCharge > 0 ? booking.extraMileageCharge : extraFromSnap?.amount,
  );
  if (extraAmount > 0 || extraFromSnap) {
    lines.push(
      extraMileageLine(
        extraFromSnap || { title: "Extra Mileage", amount: extraAmount },
        booking,
        car,
      ),
    );
  }

  for (const item of chargeEntries.filter((entry) => !isExtraMileageChargeEntry(entry))) {
    lines.push(chargeLineForEntry(item, booking, car, days));
  }

  const checkOutPaid = resolveCheckOutPaidForInvoice(booking, extras);

  const paidManualCharges = chargeEntries
    .filter((item) => item.source === "manual" && item.status === "paid")
    .reduce((sum, item) => sum + moneyNum(resolveBillEntryTotalAmount(item)), 0);
  const lineTotals = totalsFromLines(lines, 0);
  const unpaidAfterPayments = Math.max(0, moneyNum(lineTotals.totalAmount - checkOutPaid));
  const chargeCredit = Math.min(paidManualCharges, unpaidAfterPayments);
  const paymentReceived = moneyNum(checkOutPaid + chargeCredit);
  const checkoutDetails =
    booking.checkInMileage != null || booking.checkOutMileage != null
      ? {
          odometerOut: booking.checkInMileage,
          odometerIn: booking.checkOutMileage,
          extraKm: booking.extraMileageKm,
        }
      : null;

  return {
    kind: "check_out",
    title: "Check-Out Invoice",
    lines,
    checkoutDetails,
    checkInPaid: checkInInvoice.checkInPaid,
    checkOutPaid,
    previousBalance,
    paymentNotes: buildPaymentNotes(checkInInvoice.checkInPaid, checkOutPaid),
    ...totalsFromLines(lines, paymentReceived),
  };
}

function chargeLineForEntry(entry, booking, car, days) {
  if (entry.systemKey === "rental" || String(entry.systemKey ?? "").startsWith("service:")) {
    return systemChargeToLine(entry, booking, car, days);
  }
  if (isExtraMileageChargeEntry(entry)) {
    return extraMileageLine(entry, booking, car);
  }
  return standaloneLine(entry);
}

function entryKey(entry) {
  return String(entry._id ?? entry.systemKey ?? `${entry.title}:${entry.amount}`);
}

export function resolveFullInvoiceScope(booking, extras = {}) {
  const car = extras.car ?? booking.car ?? null;
  const days = calculateRentalDays(
    booking.pickupDate,
    booking.pickupTime,
    booking.returnDate,
    booking.returnTime,
  );
  const entries = booking.billEntries ?? [];
  const charges = entries.filter((item) => item.entryType === "charge" && item.status !== "refund");

  const groups = [
    charges.filter((item) => item.systemKey === "rental"),
    charges.filter((item) => String(item.systemKey ?? "").startsWith("service:")),
    charges.filter((item) => isExtraMileageChargeEntry(item)),
    charges.filter((item) => item.source === "manual"),
    charges.filter(
      (item) =>
        item.source === "system" &&
        item.systemKey !== "rental" &&
        !String(item.systemKey ?? "").startsWith("service:") &&
        !isExtraMileageChargeEntry(item),
    ),
  ];

  const seen = new Set();
  const ordered = [];
  for (const group of groups) {
    for (const item of group) {
      const key = entryKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(item);
    }
  }

  const lines = ordered.map((item) => chargeLineForEntry(item, booking, car, days));

  if (!lines.some((line) => /rental/i.test(line.description))) {
    const rate = resolveBookedDailyRate(booking, car);
    const amount = moneyNum((Number(rate) || 0) * (days || 0));
    if (amount > 0) {
      lines.unshift({
        description: rentalLineLabel(car, booking),
        rate,
        qtyLabel: days ? String(days) : "1",
        amount,
      });
    }
  }

  if (!lines.some((line) => /mileage|excess\s*km/i.test(line.description))) {
    const extraAmount = moneyNum(booking.extraMileageCharge);
    if (extraAmount > 0) {
      lines.push(
        extraMileageLine(
          { title: "Extra Mileage", amount: extraAmount, description: "" },
          booking,
          car,
        ),
      );
    }
  }

  const payments = entries.filter((item) => item.entryType === "payment" && item.status !== "refund");
  const paymentEntriesTotal = payments.reduce((sum, item) => sum + moneyNum(item.amount), 0);
  const paidManualCharges = charges
    .filter((item) => item.source === "manual" && item.status === "paid")
    .reduce((sum, item) => sum + moneyNum(resolveBillEntryTotalAmount(item)), 0);
  const lineTotals = totalsFromLines(lines, 0);
  const unpaidAfterPayments = Math.max(0, moneyNum(lineTotals.totalAmount - paymentEntriesTotal));
  const chargeCredit = Math.min(paidManualCharges, unpaidAfterPayments);
  const paymentReceived = moneyNum(paymentEntriesTotal + chargeCredit);
  const checkoutDetails =
    booking.checkInMileage != null || booking.checkOutMileage != null
      ? {
          odometerOut: booking.checkInMileage,
          odometerIn: booking.checkOutMileage,
          extraKm: booking.extraMileageKm,
        }
      : null;

  return {
    kind: "full",
    title: "Full Invoice",
    lines,
    checkoutDetails,
    ...totalsFromLines(lines, paymentReceived),
  };
}

export function buildFullInvoiceNumber(bookingOrId) {
  return `${getBookingPublicNumber(bookingOrId)}-ALL`;
}

export async function generateFullInvoicePdf(booking) {
  const context = await buildInvoicePartyContext(booking);
  const scope = resolveFullInvoiceScope(booking, context);
  return generateBillInvoicePdf({
    ...context,
    ...scope,
    invoiceNumber: buildFullInvoiceNumber(booking),
    issuedAt: new Date(),
  });
}

function resolveCheckOutInvoiceNumber(booking) {
  const checkoutPayment = (booking.billEntries ?? []).find(
    (entry) => resolveInvoiceKind(entry) === "check_out",
  );
  if (checkoutPayment?.invoiceNumber) return checkoutPayment.invoiceNumber;
  return `${getBookingPublicNumber(booking)}-CO`;
}

export async function generateCheckOutInvoicePdf(booking) {
  const context = await buildInvoicePartyContext(booking);
  const scope = buildCheckOutInvoiceScope(booking, context);
  return generateBillInvoicePdf({
    ...context,
    ...scope,
    invoiceNumber: resolveCheckOutInvoiceNumber(booking),
    issuedAt: new Date(),
  });
}

export function resolveInvoiceScope(booking, entry, extras = {}) {
  const car = extras.car ?? booking.car ?? null;
  const days = calculateRentalDays(
    booking.pickupDate,
    booking.pickupTime,
    booking.returnDate,
    booking.returnTime,
  );
  const kind = resolveInvoiceKind(entry);

  if (kind === "check_in") {
    return buildCheckInInvoiceScope(booking, extras);
  }

  if (kind === "check_out") {
    return buildCheckOutInvoiceScope(booking, extras);
  }

  if (kind === "payment") {
    const amount = moneyNum(entry.amount);
    return {
      kind,
      title: entry.title || "Payment Invoice",
      lines: [
        {
          description: entry.title || "Payment received",
          detail: entry.description,
          rate: amount,
          qtyLabel: "1",
          amount,
        },
      ],
      checkoutDetails: null,
      subtotal: amount,
      taxAmount: 0,
      totalAmount: amount,
      paymentReceived: entry.status === "refund" ? 0 : amount,
      amountDue: 0,
      status: entry.status === "refund" ? "refund" : "paid",
      statusLabel: paymentStatusLabel(entry.status === "refund" ? "refund" : "paid"),
    };
  }

  const lines = [standaloneLine(entry)];
  const chargeTotals = getBillEntryTotals(entry.amount);
  const subtotal = entry.taxAmount != null ? moneyNum(entry.amount) : chargeTotals.subtotal;
  const taxAmount = entry.taxAmount != null ? moneyNum(entry.taxAmount) : chargeTotals.taxAmount;
  const totalAmount = entry.totalAmount != null ? moneyNum(entry.totalAmount) : chargeTotals.totalAmount;
  const paid = entry.status === "paid" ? totalAmount : 0;
  return {
    kind: "single",
    title: `${entry.title || "Charge"} Invoice`,
    lines,
    checkoutDetails: null,
    subtotal,
    taxAmount,
    totalAmount,
    paymentReceived: paid,
    amountDue: entry.status === "paid" ? 0 : totalAmount,
    status: entry.status === "paid" ? "paid" : entry.status === "refund" ? "refund" : "pending",
    statusLabel: paymentStatusLabel(
      entry.status === "paid" ? "paid" : entry.status === "refund" ? "refund" : "pending",
    ),
    paymentNotes: paidViaInvoiceNotes(entry),
  };
}

export function resolveInvoiceAmounts(entry) {
  if (entry.entryType === "payment") {
    const amount = moneyNum(entry.amount);
    return { subtotal: amount, taxAmount: 0, totalAmount: amount, kind: "payment" };
  }
  const totals = getBillEntryTotals(entry.amount);
  return {
    subtotal: entry.taxAmount != null ? Number(entry.amount) : totals.subtotal,
    taxAmount: entry.taxAmount ?? totals.taxAmount,
    totalAmount: entry.totalAmount ?? totals.totalAmount,
    kind: "charge",
  };
}

export async function buildInvoicePartyContext(booking) {
  const [car, customer, pickupLocation, dropoffLocation, checkIn, checkOut] = await Promise.all([
    Car.findById(booking.carId),
    User.findById(booking.userId),
    Location.findById(booking.pickupLocationId),
    Location.findById(booking.dropoffLocationId),
    VehicleInspection.findOne({ bookingId: booking._id, type: "check_in" }).sort({ createdAt: -1 }),
    VehicleInspection.findOne({ bookingId: booking._id, type: "check_out" }).sort({ createdAt: -1 }),
  ]);

  const mainDriver =
    checkIn?.mainDriver && (checkIn.mainDriver.fullLegalName || checkIn.mainDriver.licenseNumber)
      ? checkIn.mainDriver
      : buildMainDriverCheckInDefaults(customer);

  const days = calculateRentalDays(
    normalizeBookingDate(booking.pickupDate),
    normalizeTimeTo24h(booking.pickupTime),
    normalizeBookingDate(booking.returnDate),
    normalizeTimeTo24h(booking.returnTime),
  );
  const dailyMileageLimit = car
    ? resolveBookedDailyMileageLimit(booking, car)
    : booking.bookedDailyMileageLimit;
  const includedKm =
    dailyMileageLimit != null && Number.isFinite(Number(dailyMileageLimit))
      ? Math.round(Number(dailyMileageLimit) * days)
      : null;

  const pickupLabel = [
    pickupLocation?.name,
    formatScheduleDate(booking.pickupDate, booking.pickupTime),
  ]
    .filter(Boolean)
    .join(" — ");
  const returnLabel = [
    dropoffLocation?.name,
    formatScheduleDate(booking.returnDate, booking.returnTime),
  ]
    .filter(Boolean)
    .join(" — ");

  return {
    bookingRef: `#${getBookingPublicNumber(booking)}`,
    reservationSuffix: getBookingPublicNumber(booking),
    customerName: mainDriver.fullLegalName?.trim() || customer?.name || customer?.email || "Customer",
    billedToAddress: buildHomeAddress(mainDriver),
    customerEmail: mainDriver.emailAddress || customer?.email || "",
    customerPhone: formatPhoneForTemplate(mainDriver.phoneNumber || customer?.phone),
    licenseNumber: mainDriver.licenseNumber?.trim() ?? "",
    licenseExpiry: mainDriver.licenseExpiryDate?.trim() ?? "",
    policyNo: mainDriver.policyNo?.trim() ?? "",
    vehicleLabel: car ? `${car.year} ${car.make} ${car.model}` : "Vehicle",
    vehiclePlate: car?.licensePlate ?? "",
    vehicleColor: car?.color ?? "",
    vehicleVin: car?.vin ?? "",
    pickupLabel,
    returnLabel,
    durationDays: days ? String(days) : "",
    includedKm: includedKm != null ? String(includedKm) : "",
    odometerOut: checkIn?.mileage ?? booking.checkInMileage ?? "",
    odometerIn: checkOut?.mileage ?? booking.checkOutMileage ?? "",
    fuelLevelOut: fuelLabel(checkIn?.fuelLevel),
    fuelLevelIn: fuelLabel(checkOut?.fuelLevel),
    car,
    customer,
    checkOut,
    checkoutAt: checkOut?.createdAt ?? null,
  };
}

export async function generateEntryInvoicePdf(booking, entry) {
  const context = await buildInvoicePartyContext(booking);
  const scope = resolveInvoiceScope(booking, entry, context);
  return generateBillInvoicePdf({
    ...context,
    ...scope,
    invoiceNumber: entry.invoiceNumber,
    issuedAt: entry.createdAt ?? new Date(),
  });
}

function billEntryChangeKey(entry) {
  if (entry?._id) return String(entry._id);
  if (entry?.systemKey) return `key:${entry.systemKey}`;
  return `title:${entry.entryType}:${entry.title}`;
}

export function snapshotBillEntryState(entries = []) {
  return (entries ?? []).map((entry) => ({
    key: billEntryChangeKey(entry),
    title: entry.title,
    description: entry.description ?? "",
    amount: Number(entry.amount),
    status: entry.status,
    paidVia: entry.paidVia,
    invoicePdfUrl: entry.invoicePdfUrl,
  }));
}

export async function attachInvoicesForChangedEntries(booking, previousEntries = []) {
  const previous = new Map(
    snapshotBillEntryState(previousEntries).map((item) => [item.key, item]),
  );
  for (const entry of booking.billEntries ?? []) {
    if (!canHaveInvoice(entry)) continue;
    const before = previous.get(billEntryChangeKey(entry));
    const changed =
      !before ||
      Number(before.amount) !== Number(entry.amount) ||
      before.title !== entry.title ||
      before.status !== entry.status ||
      before.description !== (entry.description ?? "") ||
      before.paidVia !== entry.paidVia ||
      !entry.invoicePdfUrl;
    if (changed) {
      await attachInvoiceToBillEntry(booking, entry);
    }
  }
}

export async function attachInvoiceToBillEntry(booking, entry) {
  if (!canHaveInvoice(entry)) return null;

  if (entry.entryType === "charge") {
    const totals = getBillEntryTotals(entry.amount);
    entry.taxAmount = totals.taxAmount;
    entry.totalAmount = totals.totalAmount;
  }

  assignInvoiceNumber(booking, entry);

  const pdfBuffer = await generateEntryInvoicePdf(booking, entry);
  try {
    const upload = await uploadPdfToStorage(pdfBuffer, "bill-invoices");
    entry.invoicePdfUrl = upload.secure_url;
  } catch (err) {
    console.error("Bill invoice upload failed:", {
      bookingId: String(booking?._id ?? ""),
      message: err?.message,
    });
  }
  return pdfBuffer;
}

function normalizeInvoiceInput(invoice) {
  if (Array.isArray(invoice.lines) && invoice.lines.length > 0) {
    return invoice;
  }
  const isPayment = invoice.kind === "payment";
  return {
    ...invoice,
    title: invoice.title || (isPayment ? "Payment Invoice" : "Invoice"),
    lines: [
      {
        description: invoice.title || "Charge",
        detail: invoice.description,
        rate: invoice.subtotal,
        qtyLabel: "1",
        amount: invoice.subtotal,
      },
    ],
    paymentReceived: isPayment ? invoice.totalAmount : invoice.status === "paid" ? invoice.totalAmount : 0,
    amountDue: isPayment || invoice.status === "paid" ? 0 : invoice.totalAmount,
    statusLabel: invoice.statusLabel || paymentStatusLabel(invoice.status),
  };
}

function findInvoiceTableStart(xml, beforePos) {
  let pos = beforePos;
  while (pos > 0) {
    const idx = xml.lastIndexOf("<w:tbl", pos - 1);
    if (idx < 0) return -1;
    const ch = xml[idx + 6];
    if (ch === " " || ch === ">" || ch === "/") return idx;
    pos = idx;
  }
  return -1;
}

function invoiceRowPlainText(rowXml) {
  return [...rowXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((match) => match[1])
    .join("");
}

function classifyInvoiceRow(rowXml) {
  const text = invoiceRowPlainText(rowXml);
  if (/Description/.test(text) && /Days\s*\/\s*Qty/.test(text)) return "header";
  if (/SECURITY\s*DEPOSIT/i.test(text)) return "deposit";
  if (/TOTAL(\s*DUE)?/i.test(text) && !/Total Loss/i.test(text)) return "total";
  if (/Subtotal/.test(text) || /GST\s*\(5%\)/.test(text)) return "summary";
  return "line";
}

function applyInvoiceCellBorders(cellXml, fill) {
  let cell = cellXml;
  if (/<w:tcBorders>[\s\S]*?<\/w:tcBorders>/.test(cell)) {
    cell = cell.replace(/<w:tcBorders>[\s\S]*?<\/w:tcBorders>/, INVOICE_ROW_BORDER_XML);
  } else if (cell.includes("<w:tcPr>")) {
    cell = cell.replace("<w:tcPr>", `<w:tcPr>${INVOICE_ROW_BORDER_XML}`);
  } else {
    cell = cell.replace("<w:tc>", `<w:tc><w:tcPr>${INVOICE_ROW_BORDER_XML}</w:tcPr>`);
  }
  if (fill) {
    const shade = `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`;
    if (/<w:shd\b[^>]*\/>/.test(cell)) {
      cell = cell.replace(/<w:shd\b[^>]*\/>/, shade);
    } else if (cell.includes("</w:tcPr>")) {
      cell = cell.replace("</w:tcPr>", `${shade}</w:tcPr>`);
    }
  }
  return cell;
}

function ensureInvoiceRowBorders(rowXml) {
  if (rowXml.includes("<w:trBorders>")) {
    return rowXml.replace(/<w:trBorders>[\s\S]*?<\/w:trBorders>/, INVOICE_ROW_TR_BORDERS_XML);
  }
  if (rowXml.includes("<w:trPr>")) {
    return rowXml.replace("<w:trPr>", `<w:trPr>${INVOICE_ROW_TR_BORDERS_XML}`);
  }
  return rowXml.replace(/(<w:tr\b[^>]*>)/, `$1<w:trPr>${INVOICE_ROW_TR_BORDERS_XML}</w:trPr>`);
}

function styleInvoiceRow(rowXml, { fill } = {}) {
  const withRowBorders = ensureInvoiceRowBorders(rowXml);
  const parts = withRowBorders.split("</w:tc>");
  for (let i = 0; i < parts.length - 1; i += 1) {
    parts[i] = applyInvoiceCellBorders(parts[i], fill);
  }
  return parts.join("</w:tc>");
}

function styleInvoiceTableRows(xml) {
  const marker = "<w:t>Description</w:t>";
  const descPos = xml.indexOf(marker);
  if (descPos < 0) return xml;
  const tableStart = findInvoiceTableStart(xml, descPos);
  const tableEnd = xml.indexOf("</w:tbl>", descPos);
  if (tableStart < 0 || tableEnd < 0) return xml;

  const table = xml.slice(tableStart, tableEnd + 8);
  const firstRow = table.indexOf("<w:tr");
  if (firstRow < 0) return xml;

  const prefix = table.slice(0, firstRow);
  const body = table.slice(firstRow, table.lastIndexOf("</w:tbl>"));
  const rows = [];
  let cursor = 0;
  while (cursor < body.length) {
    const rowStart = body.indexOf("<w:tr", cursor);
    if (rowStart < 0) break;
    const rowEnd = body.indexOf("</w:tr>", rowStart);
    if (rowEnd < 0) break;
    rows.push(body.slice(rowStart, rowEnd + 7));
    cursor = rowEnd + 7;
  }

  let lineIndex = 0;
  const styledRows = rows.map((row) => {
    const kind = classifyInvoiceRow(row);
    if (kind === "header" || kind === "total" || kind === "deposit") return row;
    if (kind === "summary") return styleInvoiceRow(row);
    const fill = lineIndex % 2 === 0 ? INVOICE_ZEBRA_WHITE : INVOICE_ZEBRA_GREY;
    lineIndex += 1;
    return styleInvoiceRow(row, { fill });
  });

  return xml.slice(0, tableStart) + prefix + styledRows.join("") + "</w:tbl>" + xml.slice(tableEnd + 8);
}

function invoiceTableCell(width, innerXml, { fill = INVOICE_ZEBRA_WHITE } = {}) {
  const shade = fill
    ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`
    : "";
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
    INVOICE_ROW_BORDER_XML +
    `${shade}<w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>` +
    `<w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar>` +
    `</w:tcPr>${innerXml}</w:tc>`
  );
}

function invoiceCellParagraph(value, { alignRight = false, bold = false, size } = {}) {
  const jc = alignRight ? `<w:pPr><w:jc w:val="right"/></w:pPr>` : "";
  const sz = size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : "";
  const weight = bold ? `<w:b/><w:bCs/>` : "";
  const rPr = sz || weight ? `<w:rPr>${weight}${sz}</w:rPr>` : "";
  return `<w:p>${jc}<w:r>${rPr}<w:t>${escapeXml(value)}</w:t></w:r></w:p>`;
}

function buildInvoiceLineRow(line, index) {
  const fill = index % 2 === 0 ? INVOICE_ZEBRA_WHITE : INVOICE_ZEBRA_GREY;
  const description = line.detail
    ? `${line.description || "Charge"} — ${line.detail}`
    : line.description || "Charge";
  const rate =
    line.rate === "" || line.rate == null ? "" : moneyLabel(line.rate);
  return (
    `<w:tr><w:trPr>${INVOICE_ROW_TR_BORDERS_XML}</w:trPr>` +
    invoiceTableCell(5400, invoiceCellParagraph(description), { fill }) +
    invoiceTableCell(1680, invoiceCellParagraph(rate, { alignRight: true }), { fill }) +
    invoiceTableCell(1680, invoiceCellParagraph(line.qtyLabel ?? "", { alignRight: true }), { fill }) +
    invoiceTableCell(1680, invoiceCellParagraph(moneyLabel(line.amount), { alignRight: true, bold: true }), { fill }) +
    `</w:tr>`
  );
}

function replaceInvoiceLineRows(xml, lines) {
  const marker = "<w:t>Description</w:t>";
  const descPos = xml.indexOf(marker);
  if (descPos < 0) return xml;
  const tableStart = findInvoiceTableStart(xml, descPos);
  const tableEnd = xml.indexOf("</w:tbl>", descPos);
  if (tableStart < 0 || tableEnd < 0) return xml;

  const table = xml.slice(tableStart, tableEnd + 8);
  const firstRow = table.indexOf("<w:tr");
  if (firstRow < 0) return xml;

  const prefix = table.slice(0, firstRow);
  const body = table.slice(firstRow, table.lastIndexOf("</w:tbl>"));
  const rows = [];
  let cursor = 0;
  while (cursor < body.length) {
    const rowStart = body.indexOf("<w:tr", cursor);
    if (rowStart < 0) break;
    const rowEnd = body.indexOf("</w:tr>", rowStart);
    if (rowEnd < 0) break;
    rows.push(body.slice(rowStart, rowEnd + 7));
    cursor = rowEnd + 7;
  }

  const kept = rows.filter((row) => {
    const kind = classifyInvoiceRow(row);
    return kind !== "line" && kind !== "deposit";
  });
  const lineRows = (lines?.length ? lines : [{ description: "No charges on this invoice", amount: 0 }])
    .map((line, index) => buildInvoiceLineRow(line, index));
  const headerIndex = kept.findIndex((row) => classifyInvoiceRow(row) === "header");
  const insertAt = headerIndex >= 0 ? headerIndex + 1 : 1;
  kept.splice(insertAt, 0, ...lineRows);

  return xml.slice(0, tableStart) + prefix + kept.join("") + "</w:tbl>" + xml.slice(tableEnd + 8);
}

function fillLastCellAmount(rowXml, amount) {
  const parts = rowXml.split("</w:tc>");
  if (parts.length < 2) return rowXml;
  const last = parts.length - 2;
  const value = moneyLabel(amount);
  parts[last] = parts[last].replace(
    /<w:t[^>]*>[_$.,0-9\s–-]*<\/w:t>/g,
    "",
  );
  if (/<w:p[\s\S]*<\/w:p>/.test(parts[last])) {
    parts[last] = parts[last].replace(
      /<w:p[\s\S]*<\/w:p>/,
      invoiceCellParagraph(value, { alignRight: true, bold: true }),
    );
  } else {
    parts[last] += invoiceCellParagraph(value, { alignRight: true, bold: true });
  }
  return parts.join("</w:tc>");
}

function fillLabeledAmountRow(xml, labelRe, amount) {
  const marker = "<w:t>Description</w:t>";
  const descPos = xml.indexOf(marker);
  if (descPos < 0) return xml;
  const tableStart = findInvoiceTableStart(xml, descPos);
  const tableEnd = xml.indexOf("</w:tbl>", descPos);
  if (tableStart < 0 || tableEnd < 0) return xml;

  const table = xml.slice(tableStart, tableEnd + 8);
  const firstRow = table.indexOf("<w:tr");
  const prefix = table.slice(0, firstRow);
  const body = table.slice(firstRow, table.lastIndexOf("</w:tbl>"));
  const rows = [];
  let cursor = 0;
  while (cursor < body.length) {
    const rowStart = body.indexOf("<w:tr", cursor);
    if (rowStart < 0) break;
    const rowEnd = body.indexOf("</w:tr>", rowStart);
    if (rowEnd < 0) break;
    rows.push(body.slice(rowStart, rowEnd + 7));
    cursor = rowEnd + 7;
  }

  const nextRows = rows.map((row) =>
    labelRe.test(invoiceRowPlainText(row)) ? fillLastCellAmount(row, amount) : row,
  );
  return xml.slice(0, tableStart) + prefix + nextRows.join("") + "</w:tbl>" + xml.slice(tableEnd + 8);
}

function stripTotalDueReturnNote(xml) {
  return xml
    .replace("<w:t>DUE  (</w:t>", "")
    .replace("<w:t>excl. excess KM — charged at return)</w:t>", "")
    .replace("<w:t>TOTAL </w:t>", "<w:t>TOTAL</w:t>");
}

function fillPaidAndStatus(xml, invoice) {
  const statusLabel = invoice.statusLabel || paymentStatusLabel(invoice.status);
  const paid = moneyLabel(invoice.paymentReceived);
  const due = moneyLabel(invoice.amountDue ?? 0);
  const extra = [
    ...(invoice.paymentNotes ?? []),
    invoice.kind === "check_in" || invoice.kind === "check_out"
      ? invoice.paymentReceived > 0
        ? `Paid: ${paid} · Balance due: ${due}`
        : `Balance due: ${due}`
      : invoice.paymentReceived > 0
        ? `This invoice paid: ${paid} · Balance due: ${due}`
        : `Amount due: ${due}`,
    `Payment status: ${statusLabel}`,
  ];
  const totalPos = xml.search(/<w:t[^>]*>TOTAL\s*/);
  if (totalPos < 0) return xml;
  const cellEnd = xml.indexOf("</w:tc>", totalPos);
  if (cellEnd < 0) return xml;
  const lines = extra
    .map(
      (text) =>
        `<w:p><w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:p>`,
    )
    .join("");
  return xml.slice(0, cellEnd) + lines + xml.slice(cellEnd);
}

function fillPolicyNo(xml, policyNo) {
  const value = policyNo?.trim() || "If applicable";
  const marker = "<w:t>) :</w:t>";
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const labelStart = xml.lastIndexOf("<w:t>Policy No (If applicable</w:t>", pos);
  if (labelStart >= 0) {
    return (
      xml.slice(0, labelStart) +
      `<w:t>Policy No : ${escapeXml(value)}</w:t>` +
      xml.slice(pos + marker.length)
    );
  }
  return xml.slice(0, pos) + `<w:t>) : ${escapeXml(value)}</w:t>` + xml.slice(pos + marker.length);
}

function applyInvoiceTitle(xml) {
  return xml.replace("<w:t>RENTAL INVOICE</w:t>", "<w:t>INVOICE</w:t>");
}

function fillInvoiceNumberUnderHeading(xml, invoiceNumber) {
  let next = applyInvoiceTitle(xml);
  if (!invoiceNumber) return next;
  if (next.includes(`Invoice No.  ${invoiceNumber}`) || next.includes(`Invoice No: ${invoiceNumber}`)) {
    return next;
  }
  const marker = "<w:t>INVOICE</w:t>";
  const pos = next.indexOf(marker);
  if (pos < 0) return next;
  const pEnd = next.indexOf("</w:p>", pos);
  if (pEnd < 0) return next;
  const line =
    `<w:p><w:pPr><w:spacing w:before="30"/></w:pPr>` +
    `<w:r><w:rPr><w:color w:val="444444"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
    `<w:t>Invoice No.  ${escapeXml(invoiceNumber)}</w:t></w:r></w:p>`;
  return next.slice(0, pEnd + 6) + line + next.slice(pEnd + 6);
}

function stripAgreementFromHeader(headerXml) {
  return headerXml
    .replace(/<w:t[^>]*>VEHICLE RENTAL <\/w:t>/g, "<w:t></w:t>")
    .replace(/<w:t[^>]*>AGREEMENT  \|<\/w:t>/g, "<w:t></w:t>")
    .replace(/<w:t[^>]*>AGREEMENT \|<\/w:t>/g, "<w:t></w:t>")
    .replace(/VEHICLE RENTAL AGREEMENT\s*\|?\s*/g, "");
}

function findParagraphStart(xml, fromPos) {
  let pos = fromPos;
  while (pos >= 0) {
    const idx = xml.lastIndexOf("<w:p", pos);
    if (idx < 0) return -1;
    const ch = xml[idx + 4];
    if (ch === " " || ch === ">" || ch === "/") return idx;
    pos = idx - 1;
  }
  return -1;
}

function findOpenTag(xml, tag, from = 0) {
  let pos = from;
  while (pos < xml.length) {
    const idx = xml.indexOf(tag, pos);
    if (idx < 0) return -1;
    const ch = xml[idx + tag.length];
    if (ch === " " || ch === ">" || ch === "/") return idx;
    pos = idx + tag.length;
  }
  return -1;
}

function findEnclosingOpen(xml, tag, fromPos) {
  let pos = fromPos;
  while (pos > 0) {
    const idx = xml.lastIndexOf(tag, pos - 1);
    if (idx < 0) return -1;
    const ch = xml[idx + tag.length];
    if (ch === " " || ch === ">" || ch === "/") return idx;
    pos = idx;
  }
  return -1;
}

function findMatchingClose(xml, openPrefix, closeTag, startIdx) {
  let depth = 0;
  let pos = startIdx;
  while (pos < xml.length) {
    const nextOpen = findOpenTag(xml, openPrefix, pos);
    const nextClose = xml.indexOf(closeTag, pos);
    if (nextClose < 0) return -1;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const gt = xml.indexOf(">", nextOpen);
      if (gt < 0) return -1;
      pos = gt + 1;
      if (!xml.slice(nextOpen, gt + 1).endsWith("/>")) depth += 1;
    } else {
      depth -= 1;
      const end = nextClose + closeTag.length;
      if (depth === 0) return end;
      pos = end;
    }
  }
  return -1;
}

function isCompleteWordElement(fragment, tag) {
  return fragment.startsWith(`<${tag}`) && fragment.endsWith(`</${tag}>`);
}

function stripInvoiceInitialsLine(xml) {
  const snippet = "Renter initials (condition confirmed)";
  const textPos = xml.indexOf(snippet);
  if (textPos < 0) return xml;
  const pStart = findParagraphStart(xml, textPos);
  const pEnd = xml.indexOf("</w:p>", textPos);
  if (pStart < 0 || pEnd < 0) return xml;
  const para = xml.slice(pStart, pEnd + 6);
  if (!isCompleteWordElement(para, "w:p") || !para.includes(snippet)) return xml;
  return xml.slice(0, pStart) + xml.slice(pEnd + 6);
}

function stripInvoiceRepresentativeBlock(xml) {
  return stripInvoiceSignatureBlock(xml);
}

function stripCompleteWordTable(xml, marker) {
  const textPos = xml.indexOf(marker);
  if (textPos < 0) return xml;
  const tableStart = findEnclosingOpen(xml, "<w:tbl", textPos);
  if (tableStart < 0) return xml;
  const tableEnd = findMatchingClose(xml, "<w:tbl", "</w:tbl>", tableStart);
  if (tableEnd < 0) return xml;
  const table = xml.slice(tableStart, tableEnd);
  if (!isCompleteWordElement(table, "w:tbl") || !table.includes(marker)) return xml;
  return xml.slice(0, tableStart) + xml.slice(tableEnd);
}

function stripCompleteWordRow(xml, marker) {
  const textPos = xml.indexOf(marker);
  if (textPos < 0) return xml;
  const rowStart = findEnclosingOpen(xml, "<w:tr", textPos);
  if (rowStart < 0) return xml;
  const rowEnd = findMatchingClose(xml, "<w:tr", "</w:tr>", rowStart);
  if (rowEnd < 0) return xml;
  const row = xml.slice(rowStart, rowEnd);
  if (!isCompleteWordElement(row, "w:tr") || !row.includes(marker)) return xml;
  return xml.slice(0, rowStart) + xml.slice(rowEnd);
}

/** Drop renter signature, date, printed name, and Print Full Name from the invoice. */
function stripInvoiceSignatureBlock(xml) {
  const markers = ["<w:t>Renter Signature</w:t>", "<w:t>Print Full Name</w:t>"];
  let next = xml;
  for (const marker of markers) {
    for (let i = 0; i < 8 && next.includes(marker); i += 1) {
      const strippedTable = stripCompleteWordTable(next, marker);
      if (strippedTable !== next) {
        next = strippedTable;
        continue;
      }
      const strippedRow = stripCompleteWordRow(next, marker);
      if (strippedRow === next) break;
      next = strippedRow;
    }
  }
  return next;
}

function reorderOdometerFuelHeaders(xml) {
  const marker = "<w:t>Odometer Out</w:t>";
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const rowStart = xml.lastIndexOf("<w:tr", pos);
  const rowEnd = xml.indexOf("</w:tr>", pos);
  if (rowStart < 0 || rowEnd < 0) return xml;

  let row = xml.slice(rowStart, rowEnd + 7);
  const labels = [...row.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1]);
  const joined = labels.join(" ");
  if (/Odometer Out.*Fuel Level Out.*Odometer In.*Fuel Level In/.test(joined)) {
    return xml;
  }
  if (!row.includes("<w:t>Odometer In</w:t>") || !row.includes("<w:t>Fuel Level Out</w:t>")) {
    return xml;
  }

  row = row
    .replace("<w:t>Odometer In</w:t>", "<w:t>__INV_FUEL_OUT__</w:t>")
    .replace("<w:t>Fuel Level Out</w:t>", "<w:t>Odometer In</w:t>")
    .replace("<w:t>__INV_FUEL_OUT__</w:t>", "<w:t>Fuel Level Out</w:t>");
  return xml.slice(0, rowStart) + row + xml.slice(rowEnd + 7);
}

function fillOdometerFuelRow(xml, odometerOut, odometerIn, fuelLevelOut, fuelLevelIn) {
  xml = reorderOdometerFuelHeaders(xml);
  if (!odometerOut && !odometerIn && !fuelLevelOut && !fuelLevelIn) return xml;
  const marker = "<w:t>Odometer Out</w:t>";
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const headerEnd = xml.indexOf("</w:tr>", pos);
  const rowStart = xml.indexOf("<w:tr", headerEnd);
  const rowEnd = xml.indexOf("</w:tr>", rowStart);
  if (rowStart < 0 || rowEnd < 0) return xml;

  const values = [odometerOut, fuelLevelOut, odometerIn, fuelLevelIn].map((value) =>
    value == null || value === "" ? "" : String(value),
  );
  let col = 0;
  const row = xml.slice(rowStart, rowEnd + 7).replace(
    /<w:t(?:\s+xml:space="preserve")?>\s*<\/w:t>/g,
    (cell) => {
      if (col >= values.length) return cell;
      const value = values[col++];
      if (!value) return cell;
      return `<w:t>${escapeXml(value)}</w:t>`;
    },
  );
  return xml.slice(0, rowStart) + row + xml.slice(rowEnd + 7);
}

function fillPrintNameAndDate(xml) {
  return xml;
}

function fillHeaderBlanks(xml, invoice) {
  const issued = invoice.dateIssued || formatAppDateTime(invoice.issuedAt);
  const ordered = [
    invoice.reservationSuffix || String(invoice.bookingRef ?? "").replace(/^#/, ""),
    issued && issued !== "—" ? issued : "",
    invoice.customerName,
    invoice.billedToAddress,
    invoice.customerPhone,
    invoice.licenseNumber,
    invoice.licenseExpiry,
    invoice.vehicleLabel,
    invoice.vehicleVin,
    invoice.vehiclePlate,
    invoice.vehicleColor,
    invoice.pickupLabel,
    invoice.returnLabel,
    invoice.durationDays,
    invoice.includedKm,
  ];

  const tableMarker = xml.indexOf("<w:t>Description</w:t>");
  const head = tableMarker >= 0 ? xml.slice(0, tableMarker) : xml;
  const tail = tableMarker >= 0 ? xml.slice(tableMarker) : "";

  let index = 0;
  const filledHead = head.replace(/<w:t[^>]*>(_{2,})<\/w:t>/g, (match, underscores) => {
    if (index >= ordered.length) return match;
    const value = ordered[index++];
    if (!value) return match;
    return match.replace(underscores, escapeXml(value));
  });
  return filledHead + tail;
}

export function fillBillInvoiceDocx(templateBuffer, invoiceInput) {
  const invoice = normalizeInvoiceInput(invoiceInput);
  const zip = new PizZip(templateBuffer);
  let xml = zip.file("word/document.xml").asText();

  xml = fillHeaderBlanks(xml, invoice);
  xml = fillInvoiceNumberUnderHeading(xml, invoice.invoiceNumber);
  xml = fillPolicyNo(xml, invoice.policyNo);
  xml = replaceInvoiceLineRows(xml, invoice.lines);
  xml = fillLabeledAmountRow(xml, /^Subtotal/, invoice.subtotal);
  xml = fillLabeledAmountRow(xml, /^GST/, invoice.taxAmount);
  xml = fillLabeledAmountRow(xml, /TOTAL\s*DUE/i, invoice.totalAmount);
  xml = stripTotalDueReturnNote(xml);
  xml = fillPaidAndStatus(xml, invoice);
  xml = stripInvoiceInitialsLine(xml);
  xml = stripInvoiceSignatureBlock(xml);
  xml = stripInvoiceRepresentativeBlock(xml);
  xml = reorderOdometerFuelHeaders(xml);
  xml = fillOdometerFuelRow(
    xml,
    invoice.checkoutDetails?.odometerOut ?? invoice.odometerOut,
    invoice.checkoutDetails?.odometerIn ?? invoice.odometerIn,
    invoice.fuelLevelOut,
    invoice.fuelLevelIn,
  );
  xml = fillPrintNameAndDate(xml);
  xml = styleInvoiceTableRows(xml);

  zip.file("word/document.xml", xml);
  const headerFile = zip.file("word/header1.xml");
  if (headerFile) {
    zip.file("word/header1.xml", stripAgreementFromHeader(headerFile.asText()));
  }
  return zip.generate({ type: "nodebuffer" });
}

export async function generateBillInvoicePdf(invoiceInput) {
  const templateBuffer = await fs.readFile(TEMPLATE_PATH);
  const docxBuffer = fillBillInvoiceDocx(templateBuffer, invoiceInput);
  return convertDocxToPdf(docxBuffer);
}
