import { Feature } from "../models/feature.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { cached, invalidateCache } from "../utils/ttlCache.js";
import { requireFields, requireFound, sendCreated, sendOk } from "../utils/http.js";
import { ApiError } from "../utils/ApiError.js";

const FEATURE_CACHE_TTL_MS = 30_000;

function featureName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function featureNameKey(name) {
  return name.trim().toLowerCase();
}

async function assertUniqueName(name, excludeId) {
  const nameKey = featureNameKey(name);
  const query = excludeId ? { nameKey, _id: { $ne: excludeId } } : { nameKey };
  const existing = await Feature.findOne(query).lean();
  if (existing) {
    throw new ApiError(409, "Feature already exists");
  }
}

const listFeatures = asyncHandler(async (req, res) => {
  const { activeOnly } = req.query;
  const onlyActive = activeOnly === "true";
  const key = onlyActive ? "features:active" : "features:all";
  const features = await cached(key, FEATURE_CACHE_TTL_MS, async () => {
    const query = onlyActive ? { isActive: { $ne: false } } : {};
    return formatDocs(await Feature.find(query).sort({ name: 1 }).lean());
  });
  return sendOk(res, features, "Features fetched");
});

const getFeatureById = asyncHandler(async (req, res) => {
  const feature = requireFound(
    await Feature.findById(req.params.id).lean(),
    "Feature not found",
  );
  return sendOk(res, formatDoc(feature), "Feature fetched");
});

const createFeature = asyncHandler(async (req, res) => {
  requireFields(req.body, ["name"]);
  const name = featureName(req.body.name);
  if (!name) throw new ApiError(400, "name is required");
  await assertUniqueName(name);
  const feature = await Feature.create({
    name,
    nameKey: featureNameKey(name),
  });
  invalidateCache("features");
  return sendCreated(res, formatDoc(feature), "Feature created");
});

const updateFeature = asyncHandler(async (req, res) => {
  const patch = {};
  if (req.body.name != null) {
    const name = featureName(req.body.name);
    if (!name) throw new ApiError(400, "name is required");
    await assertUniqueName(name, req.params.id);
    patch.name = name;
    patch.nameKey = featureNameKey(name);
  }
  const feature = requireFound(
    await Feature.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true }),
    "Feature not found",
  );
  invalidateCache("features");
  return sendOk(res, formatDoc(feature), "Feature updated");
});

const deleteFeature = asyncHandler(async (req, res) => {
  requireFound(await Feature.findByIdAndDelete(req.params.id), "Feature not found");
  invalidateCache("features");
  return sendOk(res, { success: true }, "Feature deleted");
});

export {
  listFeatures,
  getFeatureById,
  createFeature,
  updateFeature,
  deleteFeature,
};
