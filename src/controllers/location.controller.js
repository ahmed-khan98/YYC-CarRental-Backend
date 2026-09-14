import { Location } from "../models/location.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";

const listLocations = asyncHandler(async (req, res) => {
  const { activeOnly } = req.query;
  const query = activeOnly === "true" ? { isActive: true } : {};
  const locations = await Location.find(query);
  return res.status(200).json(new ApiResponse(200, formatDocs(locations), "Locations fetched"));
});

const getLocationById = asyncHandler(async (req, res) => {
  const location = await Location.findById(req.params.id);
  if (!location) {
    throw new ApiError(404, "Location not found");
  }
  return res.status(200).json(new ApiResponse(200, formatDoc(location), "Location fetched"));
});

const createLocation = asyncHandler(async (req, res) => {
  const location = await Location.create({ ...req.body, isActive: true });
  return res.status(201).json(new ApiResponse(201, formatDoc(location), "Location created"));
});

const updateLocation = asyncHandler(async (req, res) => {
  const patch = normalizeUpdateBody(req.body, { textKeys: ["phone"] });
  const location = await Location.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  if (!location) {
    throw new ApiError(404, "Location not found");
  }
  return res.status(200).json(new ApiResponse(200, formatDoc(location), "Location updated"));
});

const deleteLocation = asyncHandler(async (req, res) => {
  const location = await Location.findByIdAndDelete(req.params.id);
  if (!location) {
    throw new ApiError(404, "Location not found");
  }
  return res.status(200).json(new ApiResponse(200, { success: true }, "Location deleted"));
});

export {
  listLocations,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation,
};
