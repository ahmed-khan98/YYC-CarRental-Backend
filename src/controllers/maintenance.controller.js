import { Maintenance } from "../models/maintenance.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc } from "../utils/formatDoc.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";

const MAINT_CAR_FIELDS = "make model licensePlate";

function refId(ref) {
  if (!ref) return undefined;
  if (typeof ref === "string") return ref;
  return ref._id?.toString?.() ?? String(ref);
}

function formatMaintenance(record) {
  const doc = formatDoc(record);
  return {
    ...doc,
    carId: refId(record.carId) ?? doc.carId,
    car: record.populated("carId") ? formatDoc(record.get("carId")) : null,
  };
}

async function loadMaintenance(id) {
  return Maintenance.findById(id).populate("carId", MAINT_CAR_FIELDS);
}

const listMaintenanceByCar = asyncHandler(async (req, res) => {
  const records = await Maintenance.find({ carId: req.params.carId })
    .sort({ createdAt: -1 })
    .populate("carId", MAINT_CAR_FIELDS);
  return res.status(200).json(new ApiResponse(200, records.map(formatMaintenance), "Maintenance records fetched"));
});

const listMaintenance = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const query = status ? { status } : {};
  const records = await Maintenance.find(query)
    .sort({ createdAt: -1 })
    .populate("carId", MAINT_CAR_FIELDS);
  return res.status(200).json(new ApiResponse(200, records.map(formatMaintenance), "Maintenance records fetched"));
});

const createMaintenance = asyncHandler(async (req, res) => {
  const created = await Maintenance.create({ ...req.body, status: "scheduled" });
  const record = await loadMaintenance(created._id);
  return res.status(201).json(new ApiResponse(201, formatMaintenance(record), "Maintenance record created"));
});

const updateMaintenance = asyncHandler(async (req, res) => {
  const patch = normalizeUpdateBody(req.body, { textKeys: ["notes", "description"] });
  const updated = await Maintenance.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });
  if (!updated) {
    throw new ApiError(404, "Maintenance record not found");
  }
  const record = await loadMaintenance(updated._id);
  return res.status(200).json(new ApiResponse(200, formatMaintenance(record), "Maintenance record updated"));
});

export {
  listMaintenanceByCar,
  listMaintenance,
  createMaintenance,
  updateMaintenance,
};
