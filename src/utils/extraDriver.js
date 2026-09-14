/** Matches the additional-driver add-on by category or service name. */
export function isExtraDriverService(service) {
  if (!service) return false;
  const name = service.name?.toLowerCase() ?? "";
  return (
    service.category === "driver" ||
    name.includes("extra driver") ||
    name.includes("additional driver")
  );
}

export async function findExtraDriverService(AdditionalService, additionalServiceIds = []) {
  if (!additionalServiceIds.length) return null;
  for (const svcId of additionalServiceIds) {
    const svc = await AdditionalService.findById(svcId);
    if (isExtraDriverService(svc)) return svc;
  }
  return null;
}

export function validateExtraDriverDetails(extraDriverCount, extraDriverNames) {
  const count = Number(extraDriverCount) || 0;
  const names = Array.isArray(extraDriverNames) ? extraDriverNames : [];

  if (count < 1) {
    return "At least one additional driver is required";
  }

  if (names.length !== count) {
    return "Provide the full name for each additional driver";
  }

  for (let i = 0; i < names.length; i++) {
    if (!names[i]?.trim()) {
      return `Additional driver ${i + 1} name is required`;
    }
  }

  return null;
}

export function resolveBookingExtraDriverCount(booking) {
  const count = Number(booking?.extraDriverCount) || 0;
  if (count > 0) return count;

  const snapshots = Array.isArray(booking?.serviceSnapshots) ? booking.serviceSnapshots : [];
  const driverSnapshot = snapshots.find(isExtraDriverService);
  if (driverSnapshot?.quantity > 0) return driverSnapshot.quantity;

  const names = Array.isArray(booking?.extraDriverNames) ? booking.extraDriverNames : [];
  return names.filter((name) => name?.trim()).length;
}

export function validateExtraDriverCheckInDetails(expectedCount, extraDrivers) {
  const count = Number(expectedCount) || 0;
  if (count < 1) return null;

  const drivers = Array.isArray(extraDrivers) ? extraDrivers : [];
  if (drivers.length !== count) {
    return `License details are required for all ${count} additional driver(s)`;
  }

  for (let i = 0; i < drivers.length; i++) {
    const driver = drivers[i] ?? {};
    if (!driver.fullName?.trim()) {
      return `Driver ${i + 1}: full name is required`;
    }
    if (!driver.licenseNumber?.trim()) {
      return `Driver ${i + 1}: license number is required`;
    }
    if (!driver.licenseExpiryDate?.trim()) {
      return `Driver ${i + 1}: license expiry date is required`;
    }
    if (!driver.countryOfIssue?.trim()) {
      return `Driver ${i + 1}: country of issue is required`;
    }
    if (!isStoredImageUrl(driver.licenseImageUrl)) {
      return `Driver ${i + 1}: license image is required`;
    }
  }

  return null;
}

function isStoredImageUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function normalizeExtraDriverCheckInDetails(extraDrivers) {
  return extraDrivers.map((driver) => ({
    fullName: driver.fullName.trim(),
    licenseNumber: driver.licenseNumber.trim(),
    licenseExpiryDate: driver.licenseExpiryDate.trim(),
    countryOfIssue: driver.countryOfIssue.trim(),
    licenseImageUrl: driver.licenseImageUrl.trim(),
  }));
}

export { normalizeExtraDriverCheckInDetails };
