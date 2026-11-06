import { AdditionalService } from "../models/additionalService.model.js";

function normalizedServiceName(service) {
  return String(service?.name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isUnlimitedMileageService(service) {
  return /\bunlimited mileage\b/.test(normalizedServiceName(service));
}

export async function bookingHasUnlimitedMileage(booking) {
  const snapshots = Array.isArray(booking?.serviceSnapshots)
    ? booking.serviceSnapshots
    : [];

  if (snapshots.some(isUnlimitedMileageService)) return true;
  if (snapshots.length > 0) return false;

  const serviceIds = booking?.additionalServiceIds ?? [];
  if (!serviceIds.length) return false;

  const services = await AdditionalService.find({ _id: { $in: serviceIds } })
    .select("name")
    .lean();
  return services.some(isUnlimitedMileageService);
}
