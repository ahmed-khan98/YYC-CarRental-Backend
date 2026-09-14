import { AdditionalService } from "../models/additionalService.model.js";
import { calculateRentalDays, isValidRentalPeriod, calculateGrandTotal } from "./rentalPricing.js";
import { calculateServiceCharge } from "./serviceCharge.js";
import { buildServiceQuantityMap } from "./serviceQuantity.js";
import { isExtraDriverService } from "./extraDriver.js";

/** @param {import("../models/booking.model.js").Booking | Record<string, unknown>} booking */
export function hasPricingSnapshot(booking) {
  return booking.bookedDailyRate != null;
}

/** @param {{ dailyRate?: number; dailyMileageLimit?: number; chargePerExtraKm?: number }} car */
export function buildCarPricingSnapshot(car) {
  return {
    bookedDailyRate: car.dailyRate,
    bookedDailyMileageLimit: car.dailyMileageLimit,
    bookedChargePerExtraKm: car.chargePerExtraKm,
  };
}

/**
 * @param {string[]} additionalServiceIds
 * @param {Array<{ serviceId: string; quantity: number }>} serviceQuantities
 * @param {number | undefined} legacyExtraDriverCount
 */
export async function buildServiceSnapshots(
  additionalServiceIds = [],
  serviceQuantities = [],
  legacyExtraDriverCount,
) {
  let extraDriverServiceId = null;
  for (const svcId of additionalServiceIds) {
    const svc = await AdditionalService.findById(svcId);
    if (svc && isExtraDriverService(svc)) {
      extraDriverServiceId = String(svc._id);
      break;
    }
  }

  const quantityMap = buildServiceQuantityMap(
    serviceQuantities,
    legacyExtraDriverCount,
    extraDriverServiceId,
  );

  /** @type {Array<Record<string, unknown>>} */
  const snapshots = [];

  for (const svcId of additionalServiceIds) {
    const svc = await AdditionalService.findById(svcId);
    if (!svc) continue;

    snapshots.push({
      serviceId: svc._id,
      name: svc.name,
      dailyRate: svc.dailyRate,
      chargeType: svc.chargeType ?? "per_day",
      category: svc.category,
      allowQuantity: svc.allowQuantity ?? false,
      quantity: quantityMap[String(svcId)] ?? 1,
    });
  }

  return snapshots;
}

/** @param {Array<{ dailyRate?: number; chargeType?: string; quantity?: number }>} snapshots */
export function calculateServicesAmountFromSnapshots(snapshots, days) {
  return (snapshots ?? []).reduce(
    (sum, snapshot) => sum + calculateServiceCharge(snapshot, days, snapshot.quantity ?? 1),
    0,
  );
}

/** @param {Array<Record<string, unknown>>} snapshots */
export function formatServiceSnapshotsForDetail(snapshots) {
  return (snapshots ?? []).map((snapshot) => ({
    _id: String(snapshot.serviceId),
    name: snapshot.name,
    dailyRate: snapshot.dailyRate,
    chargeType: snapshot.chargeType ?? "per_day",
    category: snapshot.category,
    allowQuantity: snapshot.allowQuantity ?? false,
    quantity: snapshot.quantity ?? 1,
  }));
}

/**
 * Legacy fallback: build detail services from live catalog.
 */
export async function buildLiveServiceDetailList(booking) {
  const services = [];
  let extraDriverServiceId = null;

  for (const svcId of booking.additionalServiceIds ?? []) {
    const svc = await AdditionalService.findById(svcId);
    if (svc) {
      if (isExtraDriverService(svc)) extraDriverServiceId = String(svc._id);
      services.push(svc);
    }
  }

  const quantityMap = buildServiceQuantityMap(
    booking.serviceQuantities,
    booking.extraDriverCount,
    extraDriverServiceId,
  );

  return services.map((svc) => ({
    _id: String(svc._id),
    name: svc.name,
    dailyRate: svc.dailyRate,
    chargeType: svc.chargeType ?? "per_day",
    category: svc.category,
    allowQuantity: svc.allowQuantity ?? false,
    quantity: quantityMap[String(svc._id)] ?? 1,
  }));
}

/** @param {import("../models/booking.model.js").Booking | Record<string, unknown>} booking */
export function resolveBookedDailyRate(booking, car) {
  if (booking.bookedDailyRate != null) return booking.bookedDailyRate;
  return car?.dailyRate ?? 0;
}

/** @param {import("../models/booking.model.js").Booking | Record<string, unknown>} booking */
export function resolveBookedDailyMileageLimit(booking, car) {
  if (booking.bookedDailyMileageLimit != null) return booking.bookedDailyMileageLimit;
  return car?.dailyMileageLimit;
}

/** @param {import("../models/booking.model.js").Booking | Record<string, unknown>} booking */
export function resolveBookedChargePerExtraKm(booking, car) {
  if (booking.bookedChargePerExtraKm != null) return booking.bookedChargePerExtraKm;
  return car?.chargePerExtraKm;
}

export function calculateTotalFromSnapshots({
  bookedDailyRate,
  serviceSnapshots = [],
  pickupDate,
  pickupTime,
  returnDate,
  returnTime,
  extraMileageCharge = 0,
}) {
  if (!isValidRentalPeriod(pickupDate, pickupTime, returnDate, returnTime)) {
    return { total: 0, days: 0, subtotal: 0, baseAmount: 0, servicesAmount: 0 };
  }

  const days = calculateRentalDays(pickupDate, pickupTime, returnDate, returnTime);
  const baseAmount = (bookedDailyRate ?? 0) * days;
  const servicesAmount = calculateServicesAmountFromSnapshots(serviceSnapshots, days);
  const subtotal = baseAmount + servicesAmount + (extraMileageCharge ?? 0);
  const total = calculateGrandTotal(subtotal);

  return { total, days, subtotal, baseAmount, servicesAmount };
}
