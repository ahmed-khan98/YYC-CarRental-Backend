const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function bookingYmd(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? "").trim());
  return match ? match[1] : "";
}

/** Combine stored YYYY-MM-DD + HH:mm as a calendar datetime. No timezone conversion. */
export function combineDateAndTime(dateInput, timeStr = "00:00") {
  const ymd = bookingYmd(dateInput);
  const [year, month, day] = (ymd || "1970-01-01").split("-").map(Number);
  const [hours, minutes] = String(timeStr).split(":").map(Number);
  return new Date(year, month - 1, day, hours || 0, minutes ?? 0, 0, 0);
}

/**
 * Rental duration pricing:
 * - Under 24 hours → 1 day
 * - Each full 24h block counts as 1 day
 * - Extra time up to 4 hours → +0.5 day
 * - Extra time over 4 hours → +1 day
 */
export function calculateRentalDays(pickupDate, pickupTime, returnDate, returnTime) {
  const pickup = combineDateAndTime(pickupDate, pickupTime);
  const returnDt = combineDateAndTime(returnDate, returnTime);
  const durationMs = returnDt.getTime() - pickup.getTime();

  if (durationMs <= 0) return 0;

  if (durationMs < MS_PER_DAY) return 1;

  const fullDays = Math.floor(durationMs / MS_PER_DAY);
  const remainingMs = durationMs - fullDays * MS_PER_DAY;

  if (remainingMs <= 0) return fullDays;

  const remainingHours = remainingMs / MS_PER_HOUR;
  return remainingHours <= 4 ? fullDays + 0.5 : fullDays + 1;
}

export function isValidRentalPeriod(pickupDate, pickupTime, returnDate, returnTime) {
  const pickup = combineDateAndTime(pickupDate, pickupTime);
  const returnDt = combineDateAndTime(returnDate, returnTime);
  return returnDt.getTime() > pickup.getTime();
}

export const TAX_RATE = 0.05;

export function calculateTaxAmount(subtotal) {
  return Math.round(subtotal * TAX_RATE * 100) / 100;
}

export function calculateGrandTotal(subtotal) {
  return Math.round((subtotal + calculateTaxAmount(subtotal)) * 100) / 100;
}
