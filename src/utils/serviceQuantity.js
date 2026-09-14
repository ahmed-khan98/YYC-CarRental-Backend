/** Whether the booking UI should show a +/- quantity counter for this service. */
export function serviceAllowsQuantity(service) {
  if (!service) return false;
  return service.allowQuantity === true;
}

/**
 * @param {Array<{ serviceId: string; quantity: number }>} serviceQuantities
 * @param {string} serviceId
 * @param {number} [legacyExtraDriverCount]
 */
export function getServiceQuantity(serviceQuantities, serviceId, legacyExtraDriverCount) {
  const entries = Array.isArray(serviceQuantities) ? serviceQuantities : [];
  const match = entries.find((entry) => String(entry.serviceId) === String(serviceId));
  if (match?.quantity) return Math.max(1, Number(match.quantity) || 1);
  if (legacyExtraDriverCount) return Math.max(1, Number(legacyExtraDriverCount) || 1);
  return 1;
}

export function buildServiceQuantityMap(serviceQuantities, legacyExtraDriverCount, extraDriverServiceId) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const entry of serviceQuantities ?? []) {
    if (entry?.serviceId) {
      map[String(entry.serviceId)] = Math.max(1, Number(entry.quantity) || 1);
    }
  }
  if (extraDriverServiceId && legacyExtraDriverCount && !map[String(extraDriverServiceId)]) {
    map[String(extraDriverServiceId)] = Math.max(1, Number(legacyExtraDriverCount) || 1);
  }
  return map;
}

export function normalizeServiceQuantitiesInput(additionalServiceIds = [], serviceQuantitiesInput = []) {
  const allowedIds = new Set(additionalServiceIds.map(String));
  return (Array.isArray(serviceQuantitiesInput) ? serviceQuantitiesInput : [])
    .filter((entry) => entry?.serviceId && allowedIds.has(String(entry.serviceId)))
    .map((entry) => ({
      serviceId: String(entry.serviceId),
      quantity: Math.max(1, Number(entry.quantity) || 1),
    }));
}
