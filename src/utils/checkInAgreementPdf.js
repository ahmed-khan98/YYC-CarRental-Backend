import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import PizZip from "pizzip";
import zlib from "zlib";
import { PDFDocument } from "pdf-lib";
import { formatAppDateTime } from "./timeFormat.js";
import {
  calculateRentalDays,
  calculateTaxAmount,
  calculateGrandTotal,
} from "./rentalPricing.js";
import {
  formatServiceSnapshotsForDetail,
  calculateServicesAmountFromSnapshots,
  resolveBookedDailyRate,
  resolveBookedDailyMileageLimit,
  resolveBookedChargePerExtraKm,
} from "./bookingSnapshot.js";
import { calculateExtraMileageBilling } from "./extraMileage.js";
import { isExtraDriverService, resolveBookingExtraDriverCount } from "./extraDriver.js";
import { calculateServiceCharge } from "./serviceCharge.js";
import { buildMainDriverCheckInDefaults } from "./mainDriver.js";
import { convertDocxToPdf } from "./docxToPdf.js";
import { resolveCheckoutAt } from "./billPhase.js";
import { resolvePhaseBillEntries } from "./billing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "../../assets/check-in-agreement-template.docx");

const FUEL_LABELS = {
  empty: "Empty",
  quarter: "1/4",
  half: "1/2",
  three_quarter: "3/4",
  full: "Full",
};

/**
 * Fallback invoice signature box (page 1). Sits just above the
 * "Renter Signature" underline (measured line y≈232.6 on a typical invoice).
 */
export const INVOICE_SIGNATURE_FIELD = {
  pageIndex: 0,
  x: 47,
  y: 229,
  width: 200,
  height: 20,
};

/**
 * Fallback final signature box. Page is resolved to the sheet that has
 * "By signing below" — not a leftover blank last page. Measured line y≈624.5.
 */
export const FINAL_SIGNATURE_FIELD = {
  pageIndex: -1,
  x: 47,
  y: 617,
  width: 200,
  height: 20,
};

/** Fallback Date text above the final-page Date underline (line x≈318, y≈624.5). */
export const FINAL_DATE_FIELD = {
  x: 322,
  y: 631,
  size: 10,
};

/** Word half-points: 20 = 10pt, matching invoice TOTAL / typical filled body text. */
const AGREEMENT_BODY_SZ = "20";

/** Word half-points: 22 = 11pt. Between faint 8pt body and oversized 14pt. */
const AGREEMENT_CHECK_SZ = "22";
/** ~10px above OPTIONAL COVERAGES accept/decline checkbox lines. */
const COVERAGE_CHOICE_BEFORE_TWIPS = "150";
const AGREEMENT_CHECK_COLOR = "000000";
const AGREEMENT_CHECK_RUN_PR =
  `<w:rPr>` +
  `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>` +
  `<w:b/><w:bCs/>` +
  `<w:color w:val="${AGREEMENT_CHECK_COLOR}"/>` +
  `<w:sz w:val="${AGREEMENT_CHECK_SZ}"/>` +
  `<w:szCs w:val="${AGREEMENT_CHECK_SZ}"/>` +
  `</w:rPr>`;
const BALLOT_RUN_RE =
  /<w:r(?:\s[^>]*)?>(?:<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?<w:t([^>]*)>([☐☑])<\/w:t><\/w:r>/g;

function bodyFillRun(value) {
  return (
    `<w:r><w:rPr><w:sz w:val="${AGREEMENT_BODY_SZ}"/><w:szCs w:val="${AGREEMENT_BODY_SZ}"/></w:rPr>` +
    `<w:t>${escapeXml(value)}</w:t></w:r>`
  );
}

/** Replace a spacer run (empty w:t, often w:sz 32) with body-sized filled text. */
function replaceBlankRunWithBodyText(fragment, value, { last = false } = {}) {
  const re =
    /<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t(?:\s+xml:space="preserve")?>\s*<\/w:t><\/w:r>/g;
  const matches = [...fragment.matchAll(re)];
  if (matches.length === 0) return null;
  const target = last ? matches[matches.length - 1] : matches[0];
  return (
    fragment.slice(0, target.index) +
    bodyFillRun(value) +
    fragment.slice(target.index + target[0].length)
  );
}

const SIGNATURE_ABOVE_LINE = 2;
const SIGNATURE_HEIGHT = 20;
const SIGNATURE_WIDTH = 200;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

function normalizeTimeTo24h(timeStr) {
  if (!timeStr) return "00:00";
  const raw = String(timeStr).trim();
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (h24) {
    return `${Number(h24[1])}:${h24[2]}`;
  }
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
  if (dateStr instanceof Date) {
    return dateStr.toISOString().slice(0, 10);
  }
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

function isAdminFeeService(service) {
  return /admin/i.test(service?.name ?? "");
}

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

/** Invoice description: `{Category} Rental` from the booked car, never a hardcoded SUV. */
export function resolveRentalLineLabel(car, booking) {
  const category =
    car?.category ??
    booking?.car?.category ??
    car?.type ??
    booking?.car?.type ??
    booking?.bookedCarCategory;
  const label = formatCarCategoryLabel(category);
  return `${label || "Vehicle"} Rental`;
}

function findServiceAmount(snapshots, days, matcher) {
  const match = (snapshots ?? []).find(matcher);
  if (!match) return 0;
  return calculateServiceCharge(match, days, match.quantity ?? 1);
}

/** True only when extra drivers or the extra-driver add-on were actually booked. */
function bookingHasAdditionalDriverFee(snapshots, booking, checkInDraft) {
  if ((snapshots ?? []).some(isExtraDriverService)) return true;
  if (resolveBookingExtraDriverCount(booking) > 0) return true;
  const extraDrivers = checkInDraft?.extraDrivers;
  return (
    Array.isArray(extraDrivers) &&
    extraDrivers.some((driver) => driver?.fullName?.trim())
  );
}

function formatAdditionalServiceQtyLabel(service, days) {
  const qty = Math.max(1, Number(service.quantity) || 1);
  if (service.chargeType === "per_trip") return String(qty);
  return qty > 1 ? `${days || 1} × ${qty}` : String(days || 1);
}

function buildAdditionalServiceLines(snapshots, days) {
  return (snapshots ?? [])
    .filter((service) => !isExtraDriverService(service) && !isAdminFeeService(service))
    .map((service) => {
      const qty = Math.max(1, Number(service.quantity) || 1);
      return {
        name: service.name?.trim() || "Additional Service",
        rate: formatMoney(service.dailyRate),
        qtyLabel: formatAdditionalServiceQtyLabel(service, days),
        amount: formatMoney(calculateServiceCharge(service, days, qty)),
      };
    });
}

function isExtraMileageChargeEntry(entry) {
  if (entry?.systemKey === "extra_mileage") return true;
  return /extra\s*mileage|excess\s*km/i.test(String(entry?.title ?? ""));
}

function normalizeManualChargeLine(entry) {
  const title = String(entry?.title ?? "").trim();
  const description = String(entry?.description ?? "").trim();
  const amount = Number(entry?.amount);
  if (!title || !Number.isFinite(amount) || amount <= 0) return null;
  if (isExtraMileageChargeEntry(entry)) return null;
  return { title, description, amount };
}

function formatCheckoutChargeLine(line) {
  return {
    name: line.description ? `${line.title} — ${line.description}` : line.title,
    rate: formatMoney(line.amount),
    qtyLabel: "1",
    amount: formatMoney(line.amount),
  };
}

function isCheckoutManualCharge(entry, checkInAt) {
  if (entry?.entryType !== "charge" || entry.source !== "manual") return false;
  if (isExtraMileageChargeEntry(entry)) return false;
  if (entry.phase && entry.phase !== "check_out") return false;
  if (checkInAt && entry.phase !== "check_out") {
    const created = entryCreatedAt(entry);
    if (created && created.getTime() < new Date(checkInAt).getTime()) return false;
  }
  return true;
}

function chargeLineKey(line) {
  return `${String(line.title).toLowerCase()}|${Number(line.amount)}`;
}

/** Fuel + other admin billing entries added at check-out. Check-in PDF never uses this. */
function resolveCheckoutChargeLines({ booking, checkOutDraft, checkInAt, checkOutAt }) {
  const extras = { checkoutAt: checkOutAt ?? resolveCheckoutAt(booking) };
  const fromDraft = (checkOutDraft?.chargeEntries ?? [])
    .map(normalizeManualChargeLine)
    .filter(Boolean);
  const fromSaved = [
    ...resolvePhaseBillEntries(booking, "check_out", extras),
    ...(booking.billEntries ?? []),
  ]
    .filter((entry) => isCheckoutManualCharge(entry, checkInAt))
    .map(normalizeManualChargeLine)
    .filter(Boolean);

  const merged = [];
  const seen = new Set();
  for (const line of [...fromSaved, ...fromDraft]) {
    const key = chargeLineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  return merged;
}

function resolveExtraMileageDisplay({
  checkInMileage,
  checkOutMileage,
  dailyMileageLimit,
  chargePerExtraKm,
  days,
  booking,
}) {
  const empty = {
    extraMileageKm: "",
    extraMileageRate: "",
    extraMileageAmount: "",
    extraMileageCharge: 0,
  };

  if (checkOutMileage != null && checkOutMileage !== "" && checkInMileage != null) {
    const mileageBilling = calculateExtraMileageBilling({
      checkInMileage: Number(checkInMileage),
      checkOutMileage: Number(checkOutMileage),
      dailyMileageLimit,
      chargePerExtraKm,
      rentalDays: days,
    });
    if (mileageBilling.extraMileageCharge > 0) {
      return {
        extraMileageKm: String(mileageBilling.extraMileageKm),
        extraMileageRate: formatMoney(chargePerExtraKm),
        extraMileageAmount: formatMoney(mileageBilling.extraMileageCharge),
        extraMileageCharge: mileageBilling.extraMileageCharge,
      };
    }
    return empty;
  }

  const savedCharge = Number(booking?.extraMileageCharge);
  if (savedCharge > 0) {
    return {
      extraMileageKm: booking.extraMileageKm != null ? String(booking.extraMileageKm) : "",
      extraMileageRate: formatMoney(chargePerExtraKm),
      extraMileageAmount: formatMoney(savedCharge),
      extraMileageCharge: savedCharge,
    };
  }

  const systemEntry = (booking?.billEntries ?? []).find(
    (entry) => isExtraMileageChargeEntry(entry) && entry.entryType === "charge",
  );
  const systemAmount = Number(systemEntry?.amount);
  if (systemAmount > 0) {
    return {
      extraMileageKm: booking?.extraMileageKm != null ? String(booking.extraMileageKm) : "",
      extraMileageRate: formatMoney(chargePerExtraKm),
      extraMileageAmount: formatMoney(systemAmount),
      extraMileageCharge: systemAmount,
    };
  }

  return empty;
}

function entryCreatedAt(entry) {
  if (entry?.createdAt) return new Date(entry.createdAt);
  const id = entry?._id;
  if (!id) return null;
  if (typeof id.getTimestamp === "function") return id.getTimestamp();
  const hex = String(id);
  if (/^[a-f0-9]{24}$/i.test(hex)) {
    return new Date(parseInt(hex.slice(0, 8), 16) * 1000);
  }
  return null;
}

function isCheckInTimePayment(entry, paymentCutoffAt) {
  if (entry?.entryType !== "payment" || entry.status === "refund") return false;
  const title = String(entry.title ?? "");
  if (/check[\s-]?out/i.test(title)) return false;
  if (/check[\s-]?in/i.test(title)) return true;
  if (!paymentCutoffAt) return false;
  const created = entryCreatedAt(entry);
  if (!created) return false;
  // Payment is appended in the same request after the inspection is created.
  const cutoff = new Date(paymentCutoffAt).getTime() + 2 * 60 * 1000;
  return created.getTime() <= cutoff;
}

/**
 * Paid amount frozen at check-in: Check-In Payment / payments at or before
 * check-in / explicit snapshot. Never includes Check-Out Payment.
 */
export function resolveCheckInPaidAmount({
  billEntries = [],
  pendingCheckInPaid,
  paymentCutoffAt,
  paidAmountOverride,
} = {}) {
  const override = Number(paidAmountOverride);
  if (Number.isFinite(override) && override >= 0) return override;

  const savedPaid = (billEntries ?? [])
    .filter((entry) => isCheckInTimePayment(entry, paymentCutoffAt))
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);

  const pending = Number(pendingCheckInPaid);
  const hasPending = Number.isFinite(pending) && pending > 0;
  const alreadyHasCheckInPayment = (billEntries ?? []).some(
    (entry) =>
      entry.entryType === "payment" &&
      entry.status !== "refund" &&
      /check[\s-]?in/i.test(String(entry.title ?? "")),
  );
  return savedPaid + (hasPending && !alreadyHasCheckInPayment ? pending : 0);
}

export function buildAgreementContext({
  booking,
  car,
  customer,
  pickupLocation,
  dropoffLocation,
  checkInDraft = {},
  checkOutDraft = {},
  issuedAt,
  mode,
  paidAmountOverride,
  paymentCutoffAt,
  checkInAt,
  checkOutAt,
}) {
  const mainDriver =
    checkInDraft.mainDriver && typeof checkInDraft.mainDriver === "object"
      ? checkInDraft.mainDriver
      : buildMainDriverCheckInDefaults(customer);

  const days = calculateRentalDays(
    normalizeBookingDate(booking.pickupDate),
    normalizeTimeTo24h(booking.pickupTime),
    normalizeBookingDate(booking.returnDate),
    normalizeTimeTo24h(booking.returnTime),
  );
  const dailyRate = car ? resolveBookedDailyRate(booking, car) : booking.bookedDailyRate ?? 0;
  const snapshots = formatServiceSnapshotsForDetail(booking.serviceSnapshots ?? []);
  const baseAmount = dailyRate * days;
  const servicesAmount = calculateServicesAmountFromSnapshots(snapshots, days);
  const subtotal = baseAmount + servicesAmount;

  const additionalServiceLines = buildAdditionalServiceLines(snapshots, days);
  const extraDriverSnapshot = (snapshots ?? []).find(isExtraDriverService);
  const extraDriverFee = findServiceAmount(snapshots, days, isExtraDriverService);
  const extraDriverRate = Number(extraDriverSnapshot?.dailyRate) || 0;
  const extraDriverQty = Math.max(
    1,
    Number(extraDriverSnapshot?.quantity) ||
      (Array.isArray(checkInDraft.extraDrivers) ? checkInDraft.extraDrivers.length : 0) ||
      1,
  );
  const extraDriverFeeEach = extraDriverSnapshot
    ? extraDriverSnapshot.chargeType === "per_trip"
      ? extraDriverRate
      : extraDriverRate * (days || 0)
    : 0;
  const hasCheckoutMileage =
    checkOutDraft?.mileage != null && checkOutDraft.mileage !== "";
  const resolvedMode =
    mode === "check_out" || mode === "check_in"
      ? mode
      : hasCheckoutMileage
        ? "check_out"
        : "check_in";
  const effectiveCheckOutDraft = resolvedMode === "check_in" ? {} : checkOutDraft;

  const pendingCheckOutPaid = Number(effectiveCheckOutDraft?.paymentAmount);
  const pendingCheckInPaid = Number(checkInDraft.paymentAmount);
  const paidAmount =
    resolvedMode === "check_in"
      ? resolveCheckInPaidAmount({
          billEntries: booking.billEntries,
          pendingCheckInPaid,
          paymentCutoffAt,
          paidAmountOverride,
        })
      : (() => {
          const extras = { checkoutAt: checkOutAt ?? resolveCheckoutAt(booking) };
          const savedPaid = [
            ...resolvePhaseBillEntries(booking, "check_in", extras),
            ...resolvePhaseBillEntries(booking, "check_out", extras),
          ]
            .filter((entry) => entry.entryType === "payment" && entry.status !== "refund")
            .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
          return (
            savedPaid +
            (Number.isFinite(pendingCheckOutPaid) && pendingCheckOutPaid > 0
              ? pendingCheckOutPaid
              : 0)
          );
        })();

  const dailyMileageLimit = car
    ? resolveBookedDailyMileageLimit(booking, car)
    : booking.bookedDailyMileageLimit;
  const includedKm =
    dailyMileageLimit != null && Number.isFinite(Number(dailyMileageLimit))
      ? Math.round(Number(dailyMileageLimit) * days)
      : null;
  const chargePerExtraKm = car
    ? resolveBookedChargePerExtraKm(booking, car)
    : booking.bookedChargePerExtraKm;

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

  const reservationSuffix = booking._id.toString().slice(-8).toUpperCase();
  const vehicleLabel = car ? `${car.year} ${car.make} ${car.model}` : "";
  const issued = issuedAt ?? new Date();

  let extraMileageKm = "";
  let extraMileageRate = "";
  let extraMileageAmount = "";
  let extraMileageChargeNum = 0;
  let checkoutChargeLines = [];
  let checkoutManualTotal = 0;
  if (resolvedMode === "check_out") {
    const extraMileage = resolveExtraMileageDisplay({
      checkInMileage: checkInDraft.mileage,
      checkOutMileage: effectiveCheckOutDraft?.mileage,
      dailyMileageLimit,
      chargePerExtraKm,
      days,
      booking,
    });
    extraMileageKm = extraMileage.extraMileageKm;
    extraMileageRate = extraMileage.extraMileageRate;
    extraMileageAmount = extraMileage.extraMileageAmount;
    extraMileageChargeNum = extraMileage.extraMileageCharge;

    const checkoutManualCharges = resolveCheckoutChargeLines({
      booking,
      checkOutDraft: effectiveCheckOutDraft,
      checkInAt,
      checkOutAt,
    });
    checkoutChargeLines = checkoutManualCharges.map(formatCheckoutChargeLine);
    checkoutManualTotal = checkoutManualCharges.reduce((sum, line) => sum + line.amount, 0);
  }

  const invoiceSubtotal =
    resolvedMode === "check_out"
      ? Math.round((subtotal + extraMileageChargeNum + checkoutManualTotal) * 100) / 100
      : subtotal;
  const invoiceTax = calculateTaxAmount(invoiceSubtotal);
  const invoiceTotal = calculateGrandTotal(invoiceSubtotal);
  const invoiceBalanceDue = Math.max(0, Math.round((invoiceTotal - paidAmount) * 100) / 100);

  return {
    reservationSuffix,
    dateIssued: formatAppDateTime(issued),
    billedToName: mainDriver.fullLegalName?.trim() || customer?.name || customer?.email || "",
    billedToAddress: buildHomeAddress(mainDriver),
    phone: formatPhoneForTemplate(mainDriver.phoneNumber),
    licenseNumber: mainDriver.licenseNumber?.trim() ?? "",
    licenseExpiry: mainDriver.licenseExpiryDate?.trim() ?? "",
    policyNo: mainDriver.policyNo?.trim() ?? "",
    vehicleLabel,
    vin: car?.vin ?? "",
    plate: car?.licensePlate ?? "",
    color: car?.color ?? "",
    pickupLabel,
    returnLabel,
    durationDays: days ? String(days) : "",
    includedKm: includedKm != null ? String(includedKm) : "",
    chargePerExtraKm: formatMoney(chargePerExtraKm),
    dailyRate: formatMoney(dailyRate),
    rentalDaysQty: days ? String(days) : "",
    rentalLineLabel: resolveRentalLineLabel(car, booking),
    rentalLineAmount: formatMoney(baseAmount),
    additionalServiceLines,
    hasAdditionalDriverFee: bookingHasAdditionalDriverFee(
      snapshots,
      booking,
      checkInDraft,
    ),
    extraDriverFee: extraDriverFee > 0 ? formatMoney(extraDriverFee) : "",
    extraDriverRate: extraDriverFee > 0 ? formatMoney(extraDriverRate) : "",
    extraDriverFeeEach: extraDriverFeeEach > 0 ? formatMoney(extraDriverFeeEach) : "",
    extraDriverQty: extraDriverFee > 0 ? String(extraDriverQty) : "",
    extraDriverQtyLabel:
      extraDriverFee > 0 ? `${days || 1} × ${extraDriverQty}` : "",
    paidAmount: paidAmount > 0 ? formatMoney(paidAmount) : "",
    balanceDue: paidAmount > 0 ? formatMoney(invoiceBalanceDue) : "",
    subtotal: formatMoney(invoiceSubtotal),
    taxAmount: formatMoney(invoiceTax),
    totalDue: formatMoney(invoiceTotal),
    checkoutChargeLines,
    odometerOut: checkInDraft.mileage != null ? String(checkInDraft.mileage) : "",
    odometerIn:
      effectiveCheckOutDraft?.mileage != null && effectiveCheckOutDraft.mileage !== ""
        ? String(effectiveCheckOutDraft.mileage)
        : "",
    fuelLevelOut: FUEL_LABELS[checkInDraft.fuelLevel] ?? checkInDraft.fuelLevel ?? "",
    fuelLevelIn: effectiveCheckOutDraft?.fuelLevel
      ? FUEL_LABELS[effectiveCheckOutDraft.fuelLevel] ?? effectiveCheckOutDraft.fuelLevel
      : "",
    extraMileageKm,
    extraMileageRate,
    extraMileageAmount,
    hasCheckOutReturn:
      effectiveCheckOutDraft?.mileage != null && effectiveCheckOutDraft.mileage !== "",
    preExistingDamage: checkInDraft.notes?.trim() ?? "",
    mainDriver,
    extraDrivers: Array.isArray(checkInDraft.extraDrivers) ? checkInDraft.extraDrivers : [],
    signedDate: formatAppDateTime(issued),
  };
}

/**
 * Fill underscore blanks and label fields without altering agreement text.
 */
export function fillAgreementDocx(templateBuffer, context) {
  // Pure underscore blanks in template order (see assets/check-in-agreement-template.docx).
  // Policy No on page 1 is filled separately — it is not an underscore blank.
  const orderedBlankValues = [
    context.reservationSuffix,
    context.dateIssued,
    context.billedToName,
    context.billedToAddress,
    context.phone,
    context.licenseNumber,
    context.licenseExpiry,
    context.vehicleLabel,
    context.vin,
    context.plate,
    context.color,
    context.pickupLabel,
    context.returnLabel,
    context.durationDays,
    context.includedKm,
    context.rentalDaysQty,
    context.rentalLineAmount,
    ...(context.hasAdditionalDriverFee ? [context.extraDriverFee] : []),
    "", // excess KM rate — calculated at return
    "", // excess KM amount — calculated at return
    context.subtotal,
    context.taxAmount,
    context.totalDue,
    "", // page-1 signature line — drawn on PDF overlay
  ];

  const zip = new PizZip(templateBuffer);
  let xml = zip.file("word/document.xml").asText();

  if (context.dailyRate) {
    xml = xml.replace(
      "<w:t>$________</w:t>",
      `<w:t>$${escapeXml(context.dailyRate)}</w:t>`,
    );
  }

  xml = fillPolicyNoOnInvoice(xml, context.policyNo);
  xml = fillRentalLineLabel(xml, context.rentalLineLabel);
  xml = removeAdministrativeFeesRow(xml);
  if (!context.hasAdditionalDriverFee) {
    xml = removeAdditionalDriverFeeRow(xml);
  }

  xml = fillExcessKmLine(xml, context.includedKm, context.chargePerExtraKm, {
    stripReturnNote: context.hasCheckOutReturn,
  });

  let blankIndex = 0;
  xml = xml.replace(/<w:t[^>]*>(_{2,})<\/w:t>/g, (match, underscores) => {
    if (blankIndex >= orderedBlankValues.length) return match;
    const value = orderedBlankValues[blankIndex++];
    if (!value) return match;
    return match.replace(underscores, escapeXml(value));
  });

  const renterBoxFills = [
    ["Full Legal Name:", context.mainDriver.fullLegalName],
    ["Date of Birth:", context.mainDriver.dateOfBirth],
    ["Phone Number:", context.mainDriver.phoneNumber],
    ["Email Address:", context.mainDriver.emailAddress],
    ["Home Address:", buildHomeAddress(context.mainDriver)],
    ["Driver's License No.:", context.mainDriver.licenseNumber],
    [
      "Issuing Province:",
      [
        context.mainDriver.issuingProvince,
        context.mainDriver.policyNo?.trim() || "If applicable",
      ].filter((v) => v?.trim()),
    ],
    ["Expiry Date:", context.mainDriver.licenseExpiryDate],
  ];

  for (const [label, value] of renterBoxFills) {
    xml = fillValueCellAfterLabel(xml, label, value);
  }

  if (context.hasAdditionalDriverFee) {
    xml = fillAdditionalDriverFeeRow(
      xml,
      context.extraDriverRate,
      context.extraDriverQtyLabel,
    );
  }
  xml = insertAdditionalServiceRows(xml, context.additionalServiceLines);
  xml = insertCheckoutChargeRows(xml, context.checkoutChargeLines);
  xml = fillOdometerFuelRow(
    xml,
    context.odometerOut,
    context.odometerIn,
    context.fuelLevelOut,
    context.fuelLevelIn,
  );
  xml = checkAcknowledgementBoxes(xml);
  xml = spaceCoverageAcceptDeclineLines(xml);
  xml = tightenCoveragesToFinalSignature(xml);
  xml = stripAgreementRepresentativeBlocks(xml);
  xml = fillExcessKmChargeRow(
    xml,
    context.extraMileageRate,
    context.extraMileageKm,
    context.extraMileageAmount,
  );
  xml = fillPaidBalanceOnTotal(xml, context.paidAmount, context.balanceDue);
  xml = stripTotalDueReturnNote(xml);
  xml = styleInvoiceTableRows(xml);
  xml = stripRenterInitialParagraphs(xml);
    if (context.preExistingDamage) {
      xml = fillParagraphAfterLabel(xml, "Pre-existing damage noted at pick-up:", context.preExistingDamage);
    }

    const extraDrivers = context.extraDrivers ?? [];
    if (extraDrivers.length > 0) {
      xml = fillExtraDriverRows(xml, extraDrivers, context.extraDriverFeeEach);
    }

  if (context.billedToName) {
    xml = fillPrintNameLines(xml, context.billedToName);
  }
  if (context.signedDate) {
    xml = fillSignedDateLine(xml, context.signedDate);
  }

  zip.file("word/document.xml", xml);
  return zip.generate({ type: "nodebuffer" });
}

function formatKmLabel(km) {
  const n = Number(km);
  if (!Number.isFinite(n)) return km || "—";
  return n.toLocaleString("en-US");
}

function fillExcessKmLine(xml, includedKm, chargePerExtraKm, { stripReturnNote = false } = {}) {
  const startMatch = /<w:t[^>]*>Excess KM over\s*<\/w:t>/.exec(xml);
  if (!startMatch) return xml;

  const start = startMatch.index;
  const rest = xml.slice(start);
  const endMatch = stripReturnNote
    ? /<w:t[^>]*>\s*calculated at return<\/w:t>/.exec(rest) || /<w:t[^>]*>km<\/w:t>/.exec(rest)
    : /<w:t[^>]*>km<\/w:t>/.exec(rest);
  if (!endMatch) return xml;

  const kmLabel = formatKmLabel(includedKm);
  const rateLabel = chargePerExtraKm ? `$${chargePerExtraKm}` : "$—";
  const replacement = `<w:t>Excess KM over ${escapeXml(kmLabel)} km @ ${escapeXml(rateLabel)}/km</w:t>`;
  return xml.slice(0, start) + replacement + xml.slice(start + endMatch.index + endMatch[0].length);
}

function fillPolicyNoOnInvoice(xml, policyNo) {
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

  return (
    xml.slice(0, pos) +
    `<w:t>) : ${escapeXml(value)}</w:t>` +
    xml.slice(pos + marker.length)
  );
}

function paragraphRuns(values) {
  return values
    .map((value) => `<w:r><w:t>${escapeXml(value)}</w:t></w:r>`)
    .join("<w:r><w:br/></w:r>");
}

function fillValueCellAfterLabel(xml, label, rawValue) {
  const values = (Array.isArray(rawValue) ? rawValue : [rawValue])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (values.length === 0) return xml;

  const marker = `<w:t>${label}</w:t>`;
  const labelPos = xml.indexOf(marker);
  if (labelPos < 0) return xml;

  const after = xml.slice(labelPos + marker.length);
  const labelCellEnd = after.indexOf("</w:tc>");
  if (labelCellEnd < 0) return xml;
  const nextCellRel = after.indexOf("<w:tc>", labelCellEnd);
  if (nextCellRel < 0) return xml;
  const cellEndRel = after.indexOf("</w:tc>", nextCellRel);
  if (cellEndRel < 0) return xml;

  const cellStart = labelPos + marker.length + nextCellRel;
  const cellEnd = labelPos + marker.length + cellEndRel + "</w:tc>".length;
  const cell = xml.slice(cellStart, cellEnd);
  const runs = paragraphRuns(values);

  let updated = cell.replace(
    /<w:p([^>]*)\/>/,
    `<w:p$1>${runs}</w:p>`,
  );
  if (updated === cell) {
    updated = cell.replace(
      /(<w:p\b[^>]*>)([\s\S]*?)(<\/w:p>)/,
      (_, open, inner, close) => `${open}${inner}${runs}${close}`,
    );
  }
  if (updated === cell) return xml;
  return xml.slice(0, cellStart) + updated + xml.slice(cellEnd);
}

function fillCellWithValue(cell, value, { alignRight = false } = {}) {
  if (!value) return cell;
  const safe = escapeXml(value);
  const runs = `<w:r><w:t>${safe}</w:t></w:r>`;
  const rightPr = "<w:pPr><w:jc w:val=\"right\"/></w:pPr>";
  if (/<w:p[^>]*\/>/.test(cell)) {
    return cell.replace(/<w:p([^>]*)\/>/, (_, attrs) => (
      `<w:p${attrs}>${alignRight ? rightPr : ""}${runs}</w:p>`
    ));
  }
  if (/<w:t[^>]*>\s*<\/w:t>/.test(cell)) {
    let updated = cell.replace(/<w:t[^>]*>\s*<\/w:t>/, `<w:t>${safe}</w:t>`);
    if (alignRight && !updated.includes("<w:jc")) {
      if (updated.includes("<w:pPr>")) {
        updated = updated.replace("<w:pPr>", "<w:pPr><w:jc w:val=\"right\"/>");
      } else {
        updated = updated.replace(/<w:p([^>]*)>/, `<w:p$1>${rightPr}`);
      }
    }
    return updated;
  }
  if (cell.includes("</w:p>")) {
    let updated = cell.replace("</w:p>", `${runs}</w:p>`);
    if (alignRight && !updated.includes("<w:jc")) {
      if (updated.includes("<w:pPr>")) {
        updated = updated.replace("<w:pPr>", "<w:pPr><w:jc w:val=\"right\"/>");
      } else {
        updated = updated.replace(/<w:p([^>]*)>/, `<w:p$1>${rightPr}`);
      }
    }
    return updated;
  }
  return `${cell}<w:p>${alignRight ? rightPr : ""}${runs}</w:p>`;
}

function fillAdditionalDriverFeeRow(xml, rate, qtyLabel) {
  if (!rate && !qtyLabel) return xml;
  const marker = "<w:t>Additional Driver Fee</w:t>";
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const rowStart = xml.lastIndexOf("<w:tr", pos);
  const rowEnd = xml.indexOf("</w:tr>", pos);
  if (rowStart < 0 || rowEnd < 0) return xml;
  const row = xml.slice(rowStart, rowEnd + 7);
  const parts = row.split("</w:tc>");
  if (parts.length < 3) return xml;
  parts[1] = fillCellWithValue(parts[1], rate ? `$${rate}` : "", { alignRight: true });
  parts[2] = fillCellWithValue(parts[2], qtyLabel, { alignRight: true });
  return xml.slice(0, rowStart) + parts.join("</w:tc>") + xml.slice(rowEnd + 7);
}

function removeTableRowByMarker(xml, marker) {
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const rowStart = xml.lastIndexOf("<w:tr", pos);
  const rowEnd = xml.indexOf("</w:tr>", pos);
  if (rowStart < 0 || rowEnd < 0) return xml;
  return xml.slice(0, rowStart) + xml.slice(rowEnd + 7);
}

function removeAdministrativeFeesRow(xml) {
  return removeTableRowByMarker(xml, "<w:t>Administrative Fees</w:t>");
}

function removeAdditionalDriverFeeRow(xml) {
  return removeTableRowByMarker(xml, "<w:t>Additional Driver Fee</w:t>");
}

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

function fillRentalLineLabel(xml, label) {
  if (!label) return xml;
  if (xml.includes("<w:t>SUV Rental</w:t>")) {
    return xml.replace("<w:t>SUV Rental</w:t>", `<w:t>${escapeXml(label)}</w:t>`);
  }
  return xml;
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
    if (kind === "header" || kind === "total" || kind === "deposit") {
      return row;
    }
    if (kind === "summary") {
      return styleInvoiceRow(row);
    }
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

function invoiceCellParagraph(value, { alignRight = false } = {}) {
  const jc = alignRight ? `<w:pPr><w:jc w:val="right"/></w:pPr>` : "";
  return `<w:p>${jc}<w:r><w:t>${escapeXml(value)}</w:t></w:r></w:p>`;
}

function buildInvoiceServiceRow({ name, rate, qtyLabel, amount }) {
  return (
    `<w:tr><w:trPr>${INVOICE_ROW_TR_BORDERS_XML}</w:trPr>` +
    invoiceTableCell(5400, invoiceCellParagraph(name)) +
    invoiceTableCell(1680, invoiceCellParagraph(rate ? `$${rate}` : "", { alignRight: true })) +
    invoiceTableCell(1680, invoiceCellParagraph(qtyLabel ?? "", { alignRight: true })) +
    invoiceTableCell(1680, invoiceCellParagraph(amount ? `$${amount}` : "", { alignRight: true })) +
    `</w:tr>`
  );
}

function insertAdditionalServiceRows(xml, serviceLines) {
  if (!serviceLines?.length) return xml;
  const rowsXml = serviceLines.map(buildInvoiceServiceRow).join("");
  const extraPos = xml.indexOf("<w:t>Additional Driver Fee</w:t>");
  const excessPos = xml.indexOf("Excess KM over");
  const insertBefore =
    extraPos >= 0
      ? xml.lastIndexOf("<w:tr", extraPos)
      : excessPos >= 0
        ? xml.lastIndexOf("<w:tr", excessPos)
        : -1;
  if (insertBefore < 0) return xml;
  return xml.slice(0, insertBefore) + rowsXml + xml.slice(insertBefore);
}

function insertCheckoutChargeRows(xml, chargeLines) {
  if (!chargeLines?.length) return xml;
  const rowsXml = chargeLines.map(buildInvoiceServiceRow).join("");
  const marker = "<w:t>Subtotal</w:t>";
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const rowStart = xml.lastIndexOf("<w:tr", pos);
  if (rowStart < 0) return xml;
  return xml.slice(0, rowStart) + rowsXml + xml.slice(rowStart);
}

function fillExcessKmChargeRow(xml, rate, qtyKm, amount) {
  if (!rate && !qtyKm && !amount) return xml;
  const pos = xml.indexOf("Excess KM over");
  if (pos < 0) return xml;
  const rowStart = xml.lastIndexOf("<w:tr", pos);
  const rowEnd = xml.indexOf("</w:tr>", pos);
  if (rowStart < 0 || rowEnd < 0) return xml;
  const row = xml.slice(rowStart, rowEnd + 7);
  const parts = row.split("</w:tc>");
  if (parts.length < 4) return xml;
  if (rate) {
    parts[1] = /_{2,}/.test(parts[1])
      ? parts[1].replace(/_{2,}/, escapeXml(rate))
      : fillCellWithValue(parts[1], `$${rate}`, { alignRight: true });
  }
  if (qtyKm !== "" && qtyKm != null) {
    parts[2] = /_{2,}\s*km/.test(parts[2])
      ? parts[2].replace(/_{2,}\s*km/, `${escapeXml(qtyKm)} km`)
      : fillCellWithValue(parts[2], `${qtyKm} km`, { alignRight: true });
  }
  if (amount) {
    parts[3] = /_{2,}/.test(parts[3])
      ? parts[3].replace(/_{2,}/, escapeXml(amount))
      : fillCellWithValue(parts[3], `$${amount}`, { alignRight: true });
  }
  return xml.slice(0, rowStart) + parts.join("</w:tc>") + xml.slice(rowEnd + 7);
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

function isCompleteWordElement(fragment, tag) {
  return fragment.startsWith(`<${tag}`) && fragment.endsWith(`</${tag}>`);
}

function splitTableRowCells(rowXml) {
  const cells = [];
  let cursor = 0;
  while (cursor < rowXml.length) {
    const start = findOpenTag(rowXml, "<w:tc", cursor);
    if (start < 0) break;
    const end = rowXml.indexOf("</w:tc>", start);
    if (end < 0) break;
    cells.push({ start, end: end + 7, xml: rowXml.slice(start, end + 7) });
    cursor = end + 7;
  }
  return cells;
}

function rowAt(xml, idx) {
  const hint = xml.lastIndexOf("<w:tr", idx);
  const start = findOpenTag(xml, "<w:tr", hint);
  const end = xml.indexOf("</w:tr>", idx);
  if (start < 0 || end < 0) return null;
  const fragment = xml.slice(start, end + 7);
  if (!isCompleteWordElement(fragment, "w:tr")) return null;
  return { start, end: end + 7, xml: fragment };
}

function styleBallotBoxRuns(fragment, { convertEmptyToChecked = false } = {}) {
  return fragment.replace(BALLOT_RUN_RE, (_full, tAttrs, mark) => {
    const next = convertEmptyToChecked && mark === "☐" ? "☑" : mark;
    return `<w:r>${AGREEMENT_CHECK_RUN_PR}<w:t${tAttrs}>${next}</w:t></w:r>`;
  });
}

/** Mark RENTER ACKNOWLEDGEMENT ballot boxes as checked (☐ → ☑) and enlarge/darken
 * those ☑ plus OPTIONAL COVERAGES decline ☑. Accept ☐ stays empty, same size. */
function checkAcknowledgementBoxes(xml) {
  const ackStart = xml.indexOf("6. RENTER ACKNOWLEDGEMENT");
  const coveragesStart = xml.indexOf("OPTIONAL COVERAGES", ackStart);
  if (ackStart < 0 || coveragesStart < 0 || coveragesStart <= ackStart) return xml;

  const ack = styleBallotBoxRuns(xml.slice(ackStart, coveragesStart), {
    convertEmptyToChecked: true,
  });

  const coveragesEnd = xml.indexOf("7. FINAL SIGNATURE", coveragesStart);
  const covEnd = coveragesEnd > coveragesStart ? coveragesEnd : xml.length;
  const coverages = styleBallotBoxRuns(xml.slice(coveragesStart, covEnd));

  return xml.slice(0, ackStart) + ack + coverages + xml.slice(covEnd);
}

function isCoverageChoiceParagraph(pXml) {
  return /[☐☑]/.test(pXml) && /ACCEPTS|DECLINES/.test(pXml);
}

/** ~10px (150 twips) above each ACCEPT/DECLINE checkbox line. Legal text unchanged. */
function spaceCoverageAcceptDeclineLines(xml) {
  const coveragesStart = xml.indexOf("OPTIONAL COVERAGES");
  const coveragesEnd = xml.indexOf("7. FINAL SIGNATURE", coveragesStart);
  if (coveragesStart < 0 || coveragesEnd <= coveragesStart) return xml;

  const slice = xml.slice(coveragesStart, coveragesEnd);
  const next = slice.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (pXml) => {
    if (!isCoverageChoiceParagraph(pXml) || !isCompleteWordElement(pXml, "w:p")) return pXml;
    if (/<w:spacing\b[^>]*\/>/.test(pXml)) {
      return pXml.replace(/<w:spacing\b[^/]*\/>/, `<w:spacing w:before="${COVERAGE_CHOICE_BEFORE_TWIPS}"/>`);
    }
    if (pXml.includes("<w:pPr>")) {
      return pXml.replace("<w:pPr>", `<w:pPr><w:spacing w:before="${COVERAGE_CHOICE_BEFORE_TWIPS}"/>`);
    }
    return pXml.replace(/<w:p(\s[^>]*)?>/, `<w:p$1><w:pPr><w:spacing w:before="${COVERAGE_CHOICE_BEFORE_TWIPS}"/></w:pPr>`);
  });
  return xml.slice(0, coveragesStart) + next + xml.slice(coveragesEnd);
}

/** Drop empty spacer paragraphs (incl. keepNext/before=50 page pad) after coverages. */
function tightenCoveragesToFinalSignature(xml) {
  const coveragesStart = xml.indexOf("OPTIONAL COVERAGES");
  const headingText = xml.indexOf("7. FINAL SIGNATURE", coveragesStart);
  if (coveragesStart < 0 || headingText <= coveragesStart) return xml;

  const tableEnd = xml.lastIndexOf("</w:tbl>", headingText);
  if (tableEnd < coveragesStart) return xml;
  const afterTable = tableEnd + "</w:tbl>".length;
  const headingStart = findParagraphStart(xml, headingText);
  if (headingStart < afterTable) return xml;

  const between = xml.slice(afterTable, headingStart);
  const cleaned = between.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (pXml) => {
    if (!isCompleteWordElement(pXml, "w:p")) return pXml;
    return paragraphPlainText(pXml).trim() ? pXml : "";
  });
  return xml.slice(0, afterTable) + cleaned + xml.slice(headingStart);
}

function reorderOdometerFuelHeaders(xml) {
  const marker = "<w:t>Odometer Out</w:t>";
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const row = rowAt(xml, pos);
  if (!row) return xml;
  const labels = [...row.xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1]);
  const joined = labels.join(" ");
  if (/Odometer Out.*Fuel Level Out.*Odometer In.*Fuel Level In/.test(joined)) {
    return xml;
  }
  if (!row.xml.includes("<w:t>Odometer In</w:t>") || !row.xml.includes("<w:t>Fuel Level Out</w:t>")) {
    return xml;
  }
  const cells = splitTableRowCells(row.xml);
  if (cells.length !== 4) return xml;
  const reordered = [cells[0].xml, cells[2].xml, cells[1].xml, cells[3].xml];
  let rebuilt = row.xml;
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    rebuilt = rebuilt.slice(0, cells[i].start) + reordered[i] + rebuilt.slice(cells[i].end);
  }
  return xml.slice(0, row.start) + rebuilt + xml.slice(row.end);
}

/** Drop YYC representative signature labels and the underline above them. */
function stripAgreementRepresentativeBlocks(xml) {
  let next = xml;
  let searchFrom = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    const textPos = next.indexOf("Representative", searchFrom);
    if (textPos < 0) break;
    const row = rowAt(next, textPos);
    if (!row) {
      searchFrom = textPos + 13;
      continue;
    }
    const cells = splitTableRowCells(row.xml);
    if (cells.length < 2) {
      searchFrom = textPos + 13;
      continue;
    }
    const last = cells[cells.length - 1];
    if (!isCompleteWordElement(last.xml, "w:tc") || !last.xml.includes("Representative")) {
      searchFrom = textPos + 13;
      continue;
    }
    const cleared = last.xml.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, "<w:t></w:t>");
    const rowXml = row.xml.slice(0, last.start) + cleared + row.xml.slice(last.end);
    next = next.slice(0, row.start) + rowXml + next.slice(row.end);

    const prev = rowAt(next, row.start - 1);
    if (prev && prev.end === row.start) {
      const prevCells = splitTableRowCells(prev.xml);
      const prevLast = prevCells[prevCells.length - 1];
      if (prevLast && isCompleteWordElement(prevLast.xml, "w:tc")) {
        const withoutLine = prevLast.xml.replace(
          /<w:bottom w:val="single"[^/]*\/>/,
          '<w:bottom w:val="none" w:sz="0" w:space="0" w:color="FFFFFF"/>',
        );
        const prevXml = prev.xml.slice(0, prevLast.start) + withoutLine + prev.xml.slice(prevLast.end);
        next = next.slice(0, prev.start) + prevXml + next.slice(prev.end);
      }
    }
    searchFrom = row.start + rowXml.length;
  }
  return next;
}

function fillOdometerFuelRow(xml, odometerOut, odometerIn, fuelLevelOut, fuelLevelIn) {
  xml = reorderOdometerFuelHeaders(xml);
  if (!odometerOut && !odometerIn && !fuelLevelOut && !fuelLevelIn) return xml;
  const marker = "<w:t>Odometer Out</w:t>";
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const headerEnd = xml.indexOf("</w:tr>", pos);
  const rowStart = findOpenTag(xml, "<w:tr", headerEnd);
  const rowEnd = xml.indexOf("</w:tr>", rowStart);
  if (rowStart < 0 || rowEnd < 0) return xml;

  const values = [odometerOut, fuelLevelOut, odometerIn, fuelLevelIn];
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

function paragraphPlainText(pXml) {
  return [...pXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((match) => match[1])
    .join("")
    .replace(/\s+/g, " ");
}

function isRenterInitialsParagraph(pXml) {
  const text = paragraphPlainText(pXml);
  return (
    /Renter initials \(condition confirmed\)/i.test(text) ||
    /YYC Car Rental Rep initials/i.test(text) ||
    /Renter initials confirming all acknowledgements above/i.test(text)
  );
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

/** Drop leftover renter/rep initials lines from the agreement (all occurrences). */
function stripRenterInitialParagraphs(xml) {
  let next = xml;
  const needles = [
    "Renter initials (condition confirmed)",
    "YYC Car Rental Rep initials",
    "Renter initials confirming all acknowledgements above",
  ];
  for (const needle of needles) {
    let guard = 0;
    while (guard++ < 8) {
      const textPos = next.indexOf(needle);
      if (textPos < 0) break;
      const pStart = findParagraphStart(next, textPos);
      const pEnd = next.indexOf("</w:p>", textPos);
      if (pStart < 0 || pEnd < 0) break;
      const para = next.slice(pStart, pEnd + 6);
      if (!para.startsWith("<w:p") || !para.endsWith("</w:p>")) break;
      if (!isRenterInitialsParagraph(para)) break;
      next = next.slice(0, pStart) + next.slice(pEnd + 6);
    }
  }
  return next;
}

function fillPaidBalanceOnTotal(xml, paidAmount, balanceDue) {
  if (!paidAmount) return xml;
  const marker = "<w:t>excl. excess KM — charged at return)</w:t>";
  const pos = xml.indexOf(marker);
  if (pos < 0) return xml;
  const cellEnd = xml.indexOf("</w:tc>", pos);
  if (cellEnd < 0) return xml;
  const line = `<w:p><w:r><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>Paid: $${escapeXml(paidAmount)} · Balance due: $${escapeXml(balanceDue)}</w:t></w:r></w:p>`;
  return xml.slice(0, cellEnd) + line + xml.slice(cellEnd);
}

function stripTotalDueReturnNote(xml) {
  return xml
    .replace("<w:t>DUE  (</w:t>", "")
    .replace("<w:t>excl. excess KM — charged at return)</w:t>", "")
    .replace("<w:t>TOTAL </w:t>", "<w:t>TOTAL</w:t>");
}

function fillTableValueAfterLabel(xml, label, value) {
  const labelPos = xml.indexOf(`<w:t>${label}</w:t>`);
  if (labelPos < 0) return xml;
  const slice = xml.slice(labelPos, labelPos + 4000);
  const replaced = slice.replace(
    /<w:t[^>]*>\s*<\/w:t>/,
    `<w:t>${escapeXml(value)}</w:t>`,
  );
  if (replaced === slice) return xml;
  return xml.slice(0, labelPos) + replaced + xml.slice(labelPos + 4000);
}

function fillParagraphAfterLabel(xml, label, value) {
  const marker = `<w:t>${label}</w:t>`;
  const labelPos = xml.indexOf(marker);
  if (labelPos < 0) return xml;
  const after = xml.slice(labelPos + marker.length, labelPos + marker.length + 2500);
  const replaced = after.replace(
    /<w:t[^>]*>\s*<\/w:t>/,
    `<w:t>${escapeXml(value)}</w:t>`,
  );
  if (replaced === after) return xml;
  return xml.slice(0, labelPos + marker.length) + replaced + xml.slice(labelPos + marker.length + 2500);
}

function fillExtraDriverRows(xml, extraDrivers, feeEach) {
  const anchor = "<w:t>Additional Driver Full Name</w:t>";
  let searchFrom = xml.indexOf(anchor);
  if (searchFrom < 0) return xml;

  const feeLabel = feeEach ? `$${feeEach}` : "";
  let result = xml;
  for (const driver of extraDrivers) {
    if (!driver?.fullName?.trim()) continue;

    const values = [
      driver.fullName.trim(),
      driver.licenseNumber?.trim() ?? "",
      driver.licenseExpiryDate?.trim() ?? "",
      feeLabel,
    ];

    for (const value of values) {
      const chunk = result.slice(searchFrom, searchFrom + 12000);
      const cellMatch = chunk.match(/<w:t(?:\s+xml:space="preserve")?>\s*<\/w:t>/);
      if (!cellMatch) break;

      const cellStart = searchFrom + cellMatch.index;
      const cellEnd = cellStart + cellMatch[0].length;
      const replacement = `<w:t>${escapeXml(value)}</w:t>`;
      result = result.slice(0, cellStart) + replacement + result.slice(cellEnd);
      searchFrom = cellStart + replacement.length;
    }
  }

  return result;
}

function fillPrintNameLines(xml, name) {
  if (!name?.trim()) return xml;
  let result = xml;
  let searchFrom = 0;
  while (true) {
    const pos = result.indexOf("<w:t>Print Full Name</w:t>", searchFrom);
    if (pos < 0) break;
    const rowStart = result.lastIndexOf("<w:tr", pos);
    const prevRowStart = result.lastIndexOf("<w:tr", rowStart - 1);
    const prevRowEnd = result.indexOf("</w:tr>", prevRowStart);
    if (prevRowStart < 0 || prevRowEnd < 0 || prevRowStart >= rowStart) {
      searchFrom = pos + 20;
      continue;
    }
    const prevRow = result.slice(prevRowStart, prevRowEnd + 7);
    const updated = replaceBlankRunWithBodyText(prevRow, name.trim());
    if (!updated) {
      searchFrom = pos + 20;
      continue;
    }
    result = result.slice(0, prevRowStart) + updated + result.slice(prevRowEnd + 7);
    searchFrom = pos + 20 + (updated.length - prevRow.length);
  }
  return result;
}

/** Fill the blank above the final-page "Date" label (same row as Renter Signature). */
function fillSignedDateLine(xml, signedDate) {
  if (!signedDate?.trim()) return xml;
  const pos = xml.indexOf("<w:t>Date</w:t>");
  if (pos < 0) return xml;
  const rowStart = xml.lastIndexOf("<w:tr", pos);
  const prevRowStart = xml.lastIndexOf("<w:tr", rowStart - 1);
  const prevRowEnd = xml.indexOf("</w:tr>", prevRowStart);
  if (rowStart < 0 || prevRowStart < 0 || prevRowEnd < 0 || prevRowStart >= rowStart) {
    return xml;
  }
  const prevRow = xml.slice(prevRowStart, prevRowEnd + 7);
  const updated = replaceBlankRunWithBodyText(prevRow, signedDate.trim(), { last: true });
  if (!updated) return xml;
  return xml.slice(0, prevRowStart) + updated + xml.slice(prevRowEnd + 7);
}

async function loadFilledDocx(context) {
  const templateBuffer = await fs.readFile(TEMPLATE_PATH);
  return fillAgreementDocx(templateBuffer, context);
}

export async function generateCheckInAgreementPdf(context) {
  const docxBuffer = await loadFilledDocx(context);
  return convertDocxToPdf(docxBuffer);
}

function resolvePage(pdfDoc, pageIndex) {
  const pages = pdfDoc.getPages();
  if (pageIndex < 0) return pages[pages.length - 1];
  return pages[pageIndex] ?? pages[pages.length - 1];
}

function decodePageContents(pdfDoc, page) {
  const contents = page.node.Contents();
  if (!contents) return "";
  const streams = [];
  if (contents.contents) {
    streams.push(contents);
  } else if (typeof contents.size === "function") {
    for (let i = 0; i < contents.size(); i++) {
      streams.push(pdfDoc.context.lookup(contents.get(i)));
    }
  }
  const chunks = [];
  for (const stream of streams) {
    if (!stream) continue;
    const raw = Buffer.from(stream.contents ?? []);
    try {
      chunks.push(zlib.inflateSync(raw));
    } catch {
      chunks.push(raw);
    }
  }
  return Buffer.concat(chunks).toString("latin1");
}

function decodeTjArray(token) {
  return [...token.matchAll(/\((?:\\.|[^\\)])*\)/g)]
    .map((match) => match[0].slice(1, -1))
    .join("")
    .replace(/\\n/g, "\n")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function extractPageItems(content) {
  const items = [];
  const re =
    /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|\[((?:(?!\]\s*TJ).)*)\]\s*TJ|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re/gs;
  let tm = null;
  let match;
  while ((match = re.exec(content))) {
    if (match[1] != null) {
      tm = { x: Number(match[5]), y: Number(match[6]) };
      continue;
    }
    if (match[7] != null) {
      const text = decodeTjArray(match[7]).replace(/[^\x20-\x7E]/g, "");
      if (text.trim()) items.push({ kind: "text", x: tm?.x ?? 0, y: tm?.y ?? 0, text });
      continue;
    }
    if (match[8] != null) {
      const x = Number(match[8]);
      const y = Number(match[9]);
      const w = Number(match[10]);
      const h = Number(match[11]);
      if (h <= 1.2 && w > 80) items.push({ kind: "hline", x, y, w, h });
    }
  }
  return items;
}

function lineAboveLabel(hlines, label, { xSlop = 40 } = {}) {
  return hlines
    .filter((line) => line.y > label.y && line.y < label.y + 16 && line.x < label.x + xSlop)
    .sort((a, b) => a.y - b.y)[0];
}

function signatureBoxFromLine(pageIndex, line, fallback) {
  return {
    pageIndex,
    x: (line?.x ?? fallback.x) + 2,
    y: (line?.y ?? fallback.y) + SIGNATURE_ABOVE_LINE,
    width: Math.min(SIGNATURE_WIDTH, (line?.w ?? fallback.width) - 4),
    height: SIGNATURE_HEIGHT,
  };
}

function locateAgreementOverlay(pdfDoc) {
  const pages = pdfDoc.getPages();
  const invoiceBoxes = [];
  const finalBoxes = [];
  const dateFields = [];
  let finalPageIndex = -1;

  for (let i = 0; i < pages.length; i++) {
    const items = extractPageItems(decodePageContents(pdfDoc, pages[i]));
    const texts = items.filter((item) => item.kind === "text");
    const hlines = items.filter((item) => item.kind === "hline");
    const pageText = texts.map((item) => item.text).join(" ");
    const isFinalPage = /By signing below/i.test(pageText);
    if (isFinalPage) finalPageIndex = i;

    for (const label of texts) {
      if (/^Renter Signature$/.test(label.text.trim())) {
        const line = lineAboveLabel(hlines, label);
        const box = signatureBoxFromLine(
          i,
          line,
          isFinalPage ? FINAL_SIGNATURE_FIELD : INVOICE_SIGNATURE_FIELD,
        );
        if (isFinalPage) finalBoxes.push(box);
        else invoiceBoxes.push(box);
      }
      if (isFinalPage && /^Date$/.test(label.text.trim())) {
        const line = lineAboveLabel(hlines, label, { xSlop: 20 });
        dateFields.push({
          pageIndex: i,
          x: (line?.x ?? label.x) + 4,
          y: (line?.y ?? label.y + 7) + 6,
          size: FINAL_DATE_FIELD.size,
        });
      }
    }
  }

  return {
    invoice: invoiceBoxes[0] ?? { ...INVOICE_SIGNATURE_FIELD },
    final: finalBoxes[0] ?? {
      ...FINAL_SIGNATURE_FIELD,
      pageIndex: finalPageIndex >= 0 ? finalPageIndex : FINAL_SIGNATURE_FIELD.pageIndex,
    },
    date: dateFields[0] ?? (
      finalPageIndex >= 0
        ? { ...FINAL_DATE_FIELD, pageIndex: finalPageIndex }
        : { ...FINAL_DATE_FIELD, pageIndex: pages.length - 1 }
    ),
  };
}

function drawSignature(page, pngImage, field) {
  page.drawImage(pngImage, {
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height,
  });
}

export async function generateSignedCheckInAgreementPdf(context, signaturePngBuffer) {
  const basePdf = await generateCheckInAgreementPdf(context);
  const pdfDoc = await PDFDocument.load(basePdf);
  const pngImage = await pdfDoc.embedPng(signaturePngBuffer);
  const overlay = locateAgreementOverlay(pdfDoc);

  drawSignature(resolvePage(pdfDoc, overlay.invoice.pageIndex), pngImage, overlay.invoice);
  drawSignature(resolvePage(pdfDoc, overlay.final.pageIndex), pngImage, overlay.final);

  return Buffer.from(await pdfDoc.save());
}

export function parseSignatureDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid signature image format");
  }
  return Buffer.from(match[1], "base64");
}
