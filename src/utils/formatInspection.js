import { User } from "../models/user.model.js";
import { VehicleInspection } from "../models/vehicleInspection.model.js";
import { resolveBookingActor } from "./bookingAudit.js";
import { formatDoc } from "./formatDoc.js";
import { resolvePublicMediaUrl } from "./localFileStore.js";

export function inspectionBookingId(inspection) {
  return refId(inspection?.bookingId);
}

function actorUserRef(primary, fallback) {
  if (primary && typeof primary === "object" && (primary.name != null || primary.role != null)) {
    return primary;
  }
  if (fallback && typeof fallback === "object" && (fallback.name != null || fallback.role != null)) {
    return fallback;
  }
  return primary ?? fallback;
}

function refId(value) {
  if (!value) return undefined;
  if (typeof value === "string") {
    if (/^[a-f0-9]{24}$/i.test(value)) return value;
    return value.match(/ObjectId\('([a-f0-9]{24})'\)/i)?.[1];
  }
  if (typeof value === "object") {
    if (typeof value.toHexString === "function" && !value._id && !value.id) {
      return value.toHexString();
    }
    const nested = value._id ?? value.id;
    if (nested && nested !== value) return refId(nested);
  }
  const text = value.toString?.() ?? String(value);
  return /^[a-f0-9]{24}$/i.test(text) ? text : undefined;
}

export async function formatInspections(inspections) {
  return Promise.all(
    inspections.map(async (insp) => {
      const doc = formatDoc(insp);
      const performedBy = await resolveBookingActor(
        User,
        actorUserRef(insp.performedByUserId, insp.conductedBy),
        insp.performedByRole,
        insp.performedByName,
      );
      const imageUrls = (doc.imageUrls ?? []).map((url) => resolvePublicMediaUrl(url)).filter(Boolean);
      return {
        ...doc,
        bookingId: inspectionBookingId(doc) ?? inspectionBookingId(insp),
        carId: refId(doc.carId) ?? refId(insp.carId),
        conductedBy: refId(doc.conductedBy) ?? refId(insp.conductedBy),
        performedByUserId: refId(doc.performedByUserId) ?? refId(insp.performedByUserId),
        imageUrls,
        resolvedImageUrls: imageUrls,
        signatureImageUrl: resolvePublicMediaUrl(doc.signatureImageUrl) || doc.signatureImageUrl,
        signedPdfUrl: resolvePublicMediaUrl(doc.signedPdfUrl) || doc.signedPdfUrl,
        mainDriver: doc.mainDriver
          ? {
              ...doc.mainDriver,
              licenseImageUrl:
                resolvePublicMediaUrl(doc.mainDriver.licenseImageUrl) || doc.mainDriver.licenseImageUrl,
            }
          : doc.mainDriver,
        extraDrivers: Array.isArray(doc.extraDrivers)
          ? doc.extraDrivers.map((driver) => ({
              ...driver,
              licenseImageUrl: resolvePublicMediaUrl(driver.licenseImageUrl) || driver.licenseImageUrl,
            }))
          : doc.extraDrivers,
        performedBy,
      };
    }),
  );
}

export async function latestInspectionsByBookingIds(bookingIds) {
  if (!bookingIds?.length) return new Map();

  const inspections = await VehicleInspection.find({ bookingId: { $in: bookingIds } })
    .sort({ createdAt: -1 })
    .populate("conductedBy", "name role")
    .populate("performedByUserId", "name role");

  const formatted = await formatInspections(inspections);
  const latestByKey = new Map();
  for (const inspection of formatted) {
    const bookingId = inspectionBookingId(inspection);
    if (!bookingId) continue;
    const key = `${bookingId}:${inspection.type}`;
    if (!latestByKey.has(key)) {
      latestByKey.set(key, inspection);
    }
  }
  return latestByKey;
}

export function inspectionsForBooking(latestByKey, bookingId) {
  const checkIn = latestByKey.get(`${bookingId}:check_in`) ?? null;
  const checkOut = latestByKey.get(`${bookingId}:check_out`) ?? null;
  return {
    checkIn,
    checkOut,
    inspections: [checkIn, checkOut].filter(Boolean),
  };
}

export function visibleInspectionsForViewer(booking, attached, staff) {
  if (staff) return attached;
  const checkIn = booking.checkInVisibleToUser ? attached.checkIn : null;
  const checkOut = booking.checkOutVisibleToUser ? attached.checkOut : null;
  return {
    checkIn,
    checkOut,
    inspections: [checkIn, checkOut].filter(Boolean),
  };
}
