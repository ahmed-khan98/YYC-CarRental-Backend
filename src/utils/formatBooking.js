import { formatDoc } from "./formatDoc.js";
import { resolveBookingCar } from "./enrichCar.js";

export function refId(ref) {
  if (!ref) return undefined;
  if (typeof ref === "string") return ref;
  return ref._id?.toString?.() ?? String(ref);
}

export function populatedSnapshot(booking, path) {
  return booking.populated(path) ? formatDoc(booking.get(path)) : null;
}

export function formatBookingWithIds(booking) {
  const doc = formatDoc(booking);
  doc.userId = refId(booking.userId);
  doc.carId = refId(booking.carId);
  doc.pickupLocationId = refId(booking.pickupLocationId);
  doc.dropoffLocationId = refId(booking.dropoffLocationId);
  return doc;
}

export function formatListBooking(booking) {
  const doc = formatBookingWithIds(booking);
  return {
    ...doc,
    user: populatedSnapshot(booking, "userId"),
    car: resolveBookingCar(booking),
    pickupLocation: populatedSnapshot(booking, "pickupLocationId"),
    dropoffLocation: populatedSnapshot(booking, "dropoffLocationId"),
  };
}
