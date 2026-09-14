import { formatDoc } from "./formatDoc.js";

export function enrichCar(car) {
  const doc = formatDoc(car);
  const resolvedImageUrls = doc.imageUrls?.length ? doc.imageUrls : doc.imageUrl ? [doc.imageUrl] : [];
  const primaryImage = resolvedImageUrls[0] ?? doc.imageUrl ?? null;
  return {
    ...doc,
    resolvedImageUrls,
    primaryImage,
    locationId: doc.locationId?.toString?.() ?? doc.locationId,
  };
}

export function sanitizeCarForPublic(car) {
  if (!car) return car;
  const { licensePlate: _licensePlate, vin: _vin, ...publicCar } = car;
  return publicCar;
}
