import { Location } from "../models/location.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";
import { cached, invalidateCache } from "../utils/ttlCache.js";
import { requireFound, sendCreated, sendOk } from "../utils/http.js";

const LOCATION_CACHE_TTL_MS = 30_000;

const listLocations = asyncHandler(async (req, res) => {
  // Temporary: getAll returns only active records (missing isActive treated as active)
  // const { activeOnly } = req.query;
  // const key = `locations:${activeOnly === "true" ? "active" : "all"}`;
  const key = "locations:active";
  const locations = await cached(key, LOCATION_CACHE_TTL_MS, async () => {
    // const query = activeOnly === "true" ? { isActive: true } : {};
    const query = { isActive: { $ne: false } };
    return formatDocs(await Location.find(query).lean());
  });
  return sendOk(res, locations, "Locations fetched");
});

const getLocationById = asyncHandler(async (req, res) => {
  const location = requireFound(
    await Location.findById(req.params.id).lean(),
    "Location not found",
  );
  return sendOk(res, formatDoc(location), "Location fetched");
});

const createLocation = asyncHandler(async (req, res) => {
  const location = await Location.create({ ...req.body, isActive: true });
  invalidateCache("locations");
  return sendCreated(res, formatDoc(location), "Location created");
});

const updateLocation = asyncHandler(async (req, res) => {
  const patch = normalizeUpdateBody(req.body, { textKeys: ["phone"] });
  const location = requireFound(
    await Location.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true }),
    "Location not found",
  );
  invalidateCache("locations");
  return sendOk(res, formatDoc(location), "Location updated");
});

const deactivateLocation = asyncHandler(async (req, res) => {
  const location = requireFound(
    await Location.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true, runValidators: true }),
    "Location not found",
  );
  invalidateCache("locations");
  return sendOk(res, formatDoc(location), "Location deactivated");
});

const deleteLocation = asyncHandler(async (req, res) => {
  // Temporary: hard delete commented out — soft deactivate instead
  // requireFound(await Location.findByIdAndDelete(req.params.id), "Location not found");
  // invalidateCache("locations");
  // return sendOk(res, { success: true }, "Location deleted");
  requireFound(
    await Location.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true, runValidators: true }),
    "Location not found",
  );
  invalidateCache("locations");
  return sendOk(res, { success: true }, "Location deleted");
});

export {
  listLocations,
  getLocationById,
  createLocation,
  updateLocation,
  deactivateLocation,
  deleteLocation,
};
