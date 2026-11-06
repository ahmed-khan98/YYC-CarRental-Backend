export const LICENSE_EXPIRY_ERROR =
  "Driver's license expires before the rental return date. A valid license is required for the entire rental period.";

export function calendarDateKey(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const text = typeof value === "string" ? value.trim() : "";
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? "";
}

/** License expiry must be a calendar date strictly after the booking drop-off / return date. */
export function isLicenseExpiryAfterReturnDate(expiryDate, returnDate) {
  const expiryKey = calendarDateKey(expiryDate);
  const returnKey = calendarDateKey(returnDate);
  if (!expiryKey || !returnKey) return false;
  return expiryKey > returnKey;
}
