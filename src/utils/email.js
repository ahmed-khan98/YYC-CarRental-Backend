import { ApiError } from "./ApiError.js";

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_ERROR = "Please enter a valid email address.";

export function isValidEmail(value) {
  const email = typeof value === "string" ? value.trim() : "";
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

export function assertValidEmail(value) {
  if (!isValidEmail(value)) {
    throw new ApiError(400, EMAIL_ERROR);
  }
}
