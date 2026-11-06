import { Maintenance } from "../models/maintenance.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc } from "../utils/formatDoc.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";
import { requireFound, sendCreated, sendOk } from "../utils/http.js";

const MAINT_CAR_FIELDS = "make model licensePlate";

function refId(ref) {
  if (!ref) return undefined;
  if (typeof ref === "string") return ref;
  return ref._id?.toString?.() ?? String(ref);
}

function populatedCar(record) {
  if (typeof record?.populated === "function" && record.populated("carId")) {
    return formatDoc(record.get("carId"));
  }
  const value = record?.carId;
  if (value && typeof value === "object" && (value.make || value.model || value.licensePlate)) {
    return formatDoc(value);
  }
  return null;
}

function formatMaintenance(record) {
  const doc = formatDoc(record);
  return {
    ...doc,
    carId: refId(record.carId) ?? doc.carId,
    car: populatedCar(record),
  };
}

async function loadMaintenance(id) {
  return Maintenance.findById(id).populate("carId", MAINT_CAR_FIELDS);
}

const listMaintenanceByCar = asyncHandler(async (req, res) => {
  const records = await Maintenance.find({ carId: req.params.carId })
    .sort({ createdAt: -1 })
    .select("-__v")
    .populate("carId", MAINT_CAR_FIELDS)
    .lean();
  return sendOk(res, records.map(formatMaintenance), "Maintenance records fetched");
});

const listMaintenance = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const query = status ? { status } : {};
  const records = await Maintenance.find(query)
    .sort({ createdAt: -1 })
    .select("-__v")
    .populate("carId", MAINT_CAR_FIELDS)
    .lean();
  return sendOk(res, records.map(formatMaintenance), "Maintenance records fetched");
});

const createMaintenance = asyncHandler(async (req, res) => {
  const created = await Maintenance.create({ ...req.body, status: "scheduled" });
  const record = await loadMaintenance(created._id);
  return sendCreated(res, formatMaintenance(record), "Maintenance record created");
});

const updateMaintenance = asyncHandler(async (req, res) => {
  const patch = normalizeUpdateBody(req.body, { textKeys: ["notes", "description"] });
  const updated = requireFound(
    await Maintenance.findByIdAndUpdate(req.params.id, patch, {
      new: true,
      runValidators: true,
    }),
    "Maintenance record not found",
  );
  const record = await loadMaintenance(updated._id);
  return sendOk(res, formatMaintenance(record), "Maintenance record updated");
});

export {
  listMaintenanceByCar,
  listMaintenance,
  createMaintenance,
  updateMaintenance,
};
