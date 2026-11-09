/** IANA zone for Calgary. After 1 Nov 2026 Alberta stays on permanent UTC-6 (ABT). */
export const APP_TIMEZONE = "America/Edmonton";

/** 1 Nov 2026 02:00 MDT — Alberta no longer falls back to MST. */
const ALBERTA_PERMANENT_ABT_FROM = Date.UTC(2026, 10, 1, 8, 0, 0);
/** Etc/GMT+6 is UTC-6 (POSIX sign is inverted). */
const ALBERTA_PERMANENT_ZONE = "Etc/GMT+6";

export function resolveAppTimeZone(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() < ALBERTA_PERMANENT_ABT_FROM) {
    return APP_TIMEZONE;
  }
  return ALBERTA_PERMANENT_ZONE;
}

/** e.g. "Aug 31, 2026 at 4:40 PM" in Calgary time */
export function formatAppDateTime(value) {
  if (value == null) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveAppTimeZone(date),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";

  return `${get("month")} ${get("day")}, ${get("year")} at ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}
