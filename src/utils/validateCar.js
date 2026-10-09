import { ApiError } from "./ApiError.js";
import { fieldLabel } from "./mongooseErrors.js";

const REQUIRED_STRING_FIELDS = [
  "make",
  "model",
  "category",
  "color",
  "licensePlate",
  "vin",
  "transmission",
  "fuelType",
];

const REQUIRED_NUMBER_FIELDS = [
  "year",
  "dailyRate",
  "seats",
  "mileage",
  "dailyMileageLimit",
  "chargePerExtraKm",
];

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function parseRequiredNumber(value, key) {
  const label = fieldLabel(key);
  if (isEmpty(value)) {
    throw new ApiError(400, `${label} is required`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, `${label} must be a valid number`);
  }
  if (parsed < 0) {
    throw new ApiError(400, `${label} cannot be negative`);
  }
  return parsed;
}

/**
 * Validate required car fields.
 * create: every required field must be present.
 * update: only keys present on the body are checked, so PATCH { isAvailable } still works.
 */
export function validateCarFields(body = {}, { requireAll = false } = {}) {
  const out = {};

  for (const key of REQUIRED_STRING_FIELDS) {
    if (!requireAll && !Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (isEmpty(body[key])) {
      throw new ApiError(400, `${fieldLabel(key)} is required`);
    }
    out[key] = String(body[key]).trim();
  }

  for (const key of REQUIRED_NUMBER_FIELDS) {
    if (!requireAll && !Object.prototype.hasOwnProperty.call(body, key)) continue;
    out[key] = parseRequiredNumber(body[key], key);
  }

  return out;
}
