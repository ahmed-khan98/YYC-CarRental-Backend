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

export function enrichCar(car) {
  const doc = formatDoc(car);
  const imageUrls = (doc.imageUrls?.length ? doc.imageUrls : doc.imageUrl ? [doc.imageUrl] : [])
    .map((url) => resolvePublicMediaUrl(url))
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

export function sanitizeCarForPublic(car) {
  if (!car) return car;
  const { licensePlate: _licensePlate, vin: _vin, ...publicCar } = car;
  return publicCar;
}
