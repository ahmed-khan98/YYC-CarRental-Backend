import { AdditionalService } from "../models/additionalService.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";
import { cached, invalidateCache } from "../utils/ttlCache.js";
import { requireFound, sendCreated, sendOk } from "../utils/http.js";

const SERVICE_CACHE_TTL_MS = 30_000;

const listServices = asyncHandler(async (req, res) => {
  // Temporary: getAll returns only active records (missing isActive treated as active)
  // const { activeOnly } = req.query;
  // const key = `services:${activeOnly === "true" ? "active" : "all"}`;
  const key = "services:active";
  const services = await cached(key, SERVICE_CACHE_TTL_MS, async () => {
    // const query = activeOnly === "true" ? { isActive: true } : {};
    const query = { isActive: { $ne: false } };
    return formatDocs(await AdditionalService.find(query).lean());
  });
  return sendOk(res, services, "Services fetched");
});

const createService = asyncHandler(async (req, res) => {
  const service = await AdditionalService.create({ ...req.body, isActive: true });
  invalidateCache("services");
  return sendCreated(res, formatDoc(service), "Service created");
});

const updateService = asyncHandler(async (req, res) => {
  const patch = normalizeUpdateBody(req.body, { textKeys: ["description"] });
  const service = requireFound(
    await AdditionalService.findByIdAndUpdate(req.params.id, patch, {
      new: true,
      runValidators: true,
    }),
    "Service not found",
  );
  invalidateCache("services");
  return sendOk(res, formatDoc(service), "Service updated");
});

const deactivateService = asyncHandler(async (req, res) => {
  const service = requireFound(
    await AdditionalService.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true, runValidators: true }),
    "Service not found",
  );
  invalidateCache("services");
  return sendOk(res, formatDoc(service), "Service deactivated");
});

const deleteService = asyncHandler(async (req, res) => {
  // Temporary: hard delete commented out — soft deactivate instead
  // requireFound(await AdditionalService.findByIdAndDelete(req.params.id), "Service not found");
  // invalidateCache("services");
  // return sendOk(res, { success: true }, "Service deleted");
  requireFound(
    await AdditionalService.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true, runValidators: true }),
    "Service not found",
  );
  invalidateCache("services");
  return sendOk(res, { success: true }, "Service deleted");
});

export {
  listServices,
  createService,
  updateService,
  deactivateService,
  deleteService,
};
