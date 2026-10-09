/** Human labels for schema paths used in 400 messages. */
const FIELD_LABELS = {
  make: "Make",
  model: "Model",
  year: "Year",
  category: "Category",
  color: "Color",
  licensePlate: "License plate",
  vin: "VIN",
  dailyRate: "Daily rate",
  seats: "Seats",
  transmission: "Transmission",
  fuelType: "Fuel type",
  mileage: "Mileage",
  dailyMileageLimit: "Daily mileage limit",
  chargePerExtraKm: "Charge per extra km",
};

export function fieldLabel(path) {
  if (!path) return "Field";
  const leaf = String(path).split(".").pop();
  if (FIELD_LABELS[leaf]) return FIELD_LABELS[leaf];
  return String(leaf)
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (char) => char.toUpperCase());
}

function messageFromValidatorError(entry) {
  const label = fieldLabel(entry?.path);
  if (entry?.kind === "required") return `${label} is required`;
  if (entry?.kind === "min") return `${label} cannot be negative`;
  if (entry?.kind === "enum") return `${label} is invalid`;
  if (entry?.name === "CastError" || entry?.kind === "Number") return `${label} must be a valid number`;
  const raw = typeof entry?.message === "string" ? entry.message.trim() : "";
  if (raw && !/^Path `/.test(raw) && !/validation failed/i.test(raw)) return raw;
  return `${label} is invalid`;
}

/** Turn a Mongoose ValidationError into a specific 400 message, e.g. "Color is required". */
export function messageFromMongooseValidationError(err) {
  const entries = Object.values(err?.errors ?? {});
  if (!entries.length) return "Invalid input";
  return [...new Set(entries.map(messageFromValidatorError))].join(". ");
}

export function messageFromMongooseCastError(err) {
  const label = fieldLabel(err?.path);
  if (err?.kind === "Number") return `${label} must be a valid number`;
  return `${label} is invalid`;
}

export function messageFromDuplicateKeyError(err) {
  const keyValue = err?.keyValue && typeof err.keyValue === "object" ? err.keyValue : {};
  const keys = Object.keys(keyValue);
  if (keys.length === 1) return `${fieldLabel(keys[0])} already exists`;
  if (keys.length > 1) return `${keys.map(fieldLabel).join(" and ")} already exist`;
  const match = String(err?.message ?? "").match(/index:\s+[\w.]*?(\w+)_\d+/i);
  if (match?.[1]) return `${fieldLabel(match[1])} already exists`;
  return "This value is already in use";
}

export function isDuplicateKeyError(err) {
  return err?.code === 11000 || err?.code === 11001;
}
