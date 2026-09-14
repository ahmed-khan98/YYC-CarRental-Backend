/** @typedef {"per_day" | "per_trip"} ServiceChargeType */

/**
 * @param {{ dailyRate?: number; chargeType?: ServiceChargeType }} service
 * @param {number} days
 */
export function calculateServiceCharge(service, days, quantity = 1) {
  const rate = service.dailyRate ?? 0;
  const chargeType = service.chargeType ?? "per_day";
  const qty = Math.max(1, Number(quantity) || 1);
  if (chargeType === "per_trip") return rate * qty;
  return rate * days * qty;
}

/**
 * @param {{ dailyRate?: number; chargeType?: ServiceChargeType }} service
 */
export function formatServiceRateSuffix(service) {
  return service.chargeType === "per_trip" ? "trip" : "day";
}
