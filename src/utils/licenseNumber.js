export const LICENSE_NUMBER_RE = /^[a-zA-Z0-9\s-]{4,15}$/;

export const LICENSE_NUMBER_ERROR =
  "Please enter a valid license number (4–15 characters, letters and numbers only)";

export function isValidLicenseNumber(value) {
  return LICENSE_NUMBER_RE.test(String(value ?? "").trim());
}
