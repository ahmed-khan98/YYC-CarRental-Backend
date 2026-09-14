import { Maintenance } from "../models/maintenance.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";

const listMaintenanceByCar = asyncHandler(async (req, res) => {
  const records = await Maintenance.find({ carId: req.params.carId });
  return res.status(200).json(new ApiResponse(200, formatDocs(records), "Maintenance records fetched"));
});

const listMaintenance = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const query = status ? { status } : {};
  const records = await Maintenance.find(query);
  return res.status(200).json(new ApiResponse(200, formatDocs(records), "Maintenance records fetched"));
});

const createMaintenance = asyncHandler(async (req, res) => {
  const record = await Maintenance.create({ ...req.body, status: "scheduled" });
  return res.status(201).json(new ApiResponse(201, formatDoc(record), "Maintenance record created"));
});

const updateMaintenance = asyncHandler(async (req, res) => {
  const patch = normalizeUpdateBody(req.body, { textKeys: ["notes", "description"] });
  const record = await Maintenance.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });
  if (!record) {
    throw new ApiError(404, "Maintenance record not found");
  }
  return res.status(200).json(new ApiResponse(200, formatDoc(record), "Maintenance record updated"));
});

export {
  listMaintenanceByCar,
  listMaintenance,
  createMaintenance,
  updateMaintenance,
};
