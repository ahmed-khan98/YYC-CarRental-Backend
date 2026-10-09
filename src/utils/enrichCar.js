import mongoose from "mongoose";
import { findCarsIncludingDeactivated } from "../models/car.model.js";
import { formatDoc } from "./formatDoc.js";
import { resolvePublicMediaUrl } from "./localFileStore.js";

export function normalizeCarImageFields(body = {}) {
  const raw = Array.isArray(body.imageUrls) && body.imageUrls.length
    ? body.imageUrls
    : body.imageUrl
      ? [body.imageUrl]
      : null;
  if (raw == null) return body;

  const imageUrls = [...new Set(raw.map((url) => String(url || "").trim()).filter(Boolean))];
  return {
    ...body,
    imageUrls,
    imageUrl: imageUrls[0] ?? "",
  };
}

function isObjectIdLike(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value instanceof mongoose.Types.ObjectId || value._bsontype === "ObjectId"),
  );
}

export function isPopulatedCar(value) {
  if (!value || typeof value !== "object" || isObjectIdLike(value)) return false;
  return Boolean(value.make || value.model || value.year != null || value.licensePlate);
}

export function enrichCar(car) {
  if (car == null || typeof car !== "object" || isObjectIdLike(car)) return null;
  const doc = formatDoc(car);
  if (!doc) return null;
  if (!isPopulatedCar(doc) && !doc._id) return null;
  const rawUrls = Array.isArray(doc.imageUrls)
    ? doc.imageUrls
    : typeof doc.imageUrls === "string" && doc.imageUrls
      ? [doc.imageUrls]
      : doc.imageUrl
        ? [doc.imageUrl]
        : [];
  const imageUrls = rawUrls
    .map((url) => {
      try {
        return resolvePublicMediaUrl(url);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  delete doc.imageUrl;
  delete doc.primaryImage;
  delete doc.resolvedImageUrls;

  return {
    ...doc,
    imageUrls,
    locationId: doc.locationId?.toString?.() ?? doc.locationId,
  };
}

export function enrichPopulatedCar(parent, path = "carId") {
  if (!parent) return null;
  const value = typeof parent.get === "function" ? parent.get(path) : parent[path];
  return isPopulatedCar(value) ? enrichCar(value) : null;
}

export function buildCarSnapshot(car) {
  if (!isPopulatedCar(car)) return null;
  const doc = car.toObject ? car.toObject() : car;
  return {
    make: doc.make,
    model: doc.model,
    year: doc.year,
    category: doc.category,
    licensePlate: doc.licensePlate,
    color: doc.color,
  };
}

export function resolveBookingCar(booking, path = "carId") {
  if (!booking || typeof booking !== "object") return null;
  try {
    const populated = enrichPopulatedCar(booking, path);
    if (populated) return populated;
    const snapshot = typeof booking.get === "function"
      ? booking.get("carSnapshot")
      : booking.carSnapshot;
    return isPopulatedCar(snapshot) ? enrichCar(snapshot) : null;
  } catch {
    return null;
  }
}

export function applyCarSnapshot(booking, car) {
  const snapshot = buildCarSnapshot(car);
  if (snapshot) booking.carSnapshot = snapshot;
  return snapshot;
}

export async function stampBookingsForCar(car) {
  const snapshot = buildCarSnapshot(car);
  if (!snapshot || !car?._id) return 0;
  const Booking = mongoose.model("Booking");
  const result = await Booking.updateMany(
    { carId: car._id, $or: [{ carSnapshot: { $exists: false } }, { "carSnapshot.make": { $exists: false } }] },
    { $set: { carSnapshot: snapshot } },
  );
  return result.modifiedCount ?? 0;
}

function refId(ref) {
  if (!ref) return undefined;
  if (typeof ref === "string") return ref;
  return ref._id?.toString?.() ?? String(ref);
}

export function bookingCarPopulate(select) {
  return { path: "carId", select, options: { includeDeactivated: true } };
}

function unresolvedCarId(doc, path) {
  const value = typeof doc.get === "function" ? doc.get(path) : doc[path];
  if (isPopulatedCar(value)) return null;
  const populatedId = typeof doc.populated === "function" ? doc.populated(path) : undefined;
  return refId(value) ?? refId(populatedId) ?? refId(doc[path]);
}

/** If populate hid a deactivated car, reload it without query middleware. */
export async function ensureBookingCars(bookings, path = "carId") {
  const list = (Array.isArray(bookings) ? bookings : [bookings]).filter(Boolean);
  const missingIds = [];
  for (const doc of list) {
    const id = unresolvedCarId(doc, path);
    if (id) missingIds.push(id);
  }
  if (!missingIds.length) return bookings;

  const cars = await findCarsIncludingDeactivated(missingIds);
  const byId = new Map(cars.map((car) => [String(car._id), car]));
  for (const doc of list) {
    const id = unresolvedCarId(doc, path);
    const car = byId.get(String(id ?? ""));
    if (!car) continue;
    doc[path] = car;
    if (typeof doc.populated === "function") {
      doc.populated(path, car._id);
    }
  }
  return bookings;
}

export function sanitizeCarForPublic(car) {
  if (!car || typeof car !== "object") return car;
  const { licensePlate: _licensePlate, vin: _vin, ...publicCar } = car;
  return publicCar;
}
