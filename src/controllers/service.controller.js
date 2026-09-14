import { AdditionalService } from "../models/additionalService.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";

const listServices = asyncHandler(async (req, res) => {
  const { activeOnly } = req.query;
  const query = activeOnly === "true" ? { isActive: true } : {};
  const services = await AdditionalService.find(query);
  return res.status(200).json(new ApiResponse(200, formatDocs(services), "Services fetched"));
});

const createService = asyncHandler(async (req, res) => {
  const service = await AdditionalService.create({ ...req.body, isActive: true });
  return res.status(201).json(new ApiResponse(201, formatDoc(service), "Service created"));
});

const updateService = asyncHandler(async (req, res) => {
  const patch = normalizeUpdateBody(req.body, { textKeys: ["description"] });
  const service = await AdditionalService.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });
  if (!service) {
    throw new ApiError(404, "Service not found");
  }
  return res.status(200).json(new ApiResponse(200, formatDoc(service), "Service updated"));
});

const deleteService = asyncHandler(async (req, res) => {
  const service = await AdditionalService.findByIdAndDelete(req.params.id);
  if (!service) {
    throw new ApiError(404, "Service not found");
  }
  return res.status(200).json(new ApiResponse(200, { success: true }, "Service deleted"));
});

export {
  listServices,
  createService,
  updateService,
  deleteService,
};
