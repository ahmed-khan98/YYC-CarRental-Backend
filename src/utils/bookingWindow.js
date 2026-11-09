import { resolveAppTimeZone } from "./timeFormat.js";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_BOOKING_DAY_LIMIT = 30;

export const BOOKING_PAST_DATE_ERROR = "Pickup date cannot be in the past";

export function bookingDayLimit() {
  const raw = process.env.bookingdaylimit ?? process.env.BOOKING_DAY_LIMIT;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_BOOKING_DAY_LIMIT;
}

export function bookingWindowErrorMessage(days = bookingDayLimit()) {
  return `Pickup date can only be up to ${days} days in advance`;
}

export function asBookingYmd(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return "";
  const key = value.trim().slice(0, 10);
  return YMD_RE.test(key) ? key : "";
}

export function todayYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveAppTimeZone(now),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDaysYmd(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function maxPickupYmd(now = new Date()) {
  return addDaysYmd(todayYmd(now), bookingDayLimit());
}

export function bookingWindowError(pickupDate, now = new Date()) {
  const pickup = asBookingYmd(pickupDate);
  if (!pickup) return null;
  const min = todayYmd(now);
  const max = addDaysYmd(min, bookingDayLimit());
  if (pickup < min) return BOOKING_PAST_DATE_ERROR;
  if (pickup > max) return bookingWindowErrorMessage();
  return null;
}
