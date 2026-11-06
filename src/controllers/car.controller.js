import mongoose from "mongoose";
import {
  Car,
  CAR_STATUS_ACTIVE,
  CAR_STATUS_DEACTIVE,
  activeCarsMatch,
  isCarDeactivated,
} from "../models/car.model.js";
import { isStaff } from "../middlewares/auth.middleware.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { collectUnavailableCarIds } from "../utils/carAvailability.js";
import { enrichCar, normalizeCarImageFields, sanitizeCarForPublic, stampBookingsForCar } from "../utils/enrichCar.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";
import { aggregatePaginate, paginatedPayload, wantsPagination } from "../utils/paginate.js";
import { validateCarFields } from "../utils/validateCar.js";
import { requireFound, sendCreated, sendOk } from "../utils/http.js";
import { bookingWindowError } from "../utils/bookingWindow.js";

function formatCarForRequest(req, car) {
  try {
    const enriched = enrichCar(car);
    if (!enriched) return null;
    return isStaff(req.user) ? enriched : sanitizeCarForPublic(enriched);
  } catch {
    return null;
  }
}

const listCars = asyncHandler(async (req, res) => {
  const query = req.query && typeof req.query === "object" ? req.query : {};
  const { category, locationId, availableOnly } = query;
  // Public list always returns active cars only. includeDeactivated / includeInactive are no-ops.
  const match = { ...activeCarsMatch() };
  if (availableOnly === "true") match.isAvailable = true;
  if (typeof category === "string" && category) match.category = category;
  if (typeof locationId === "string" && mongoose.Types.ObjectId.isValid(locationId)) {
    match.locationId = new mongoose.Types.ObjectId(locationId);
  }

  const result = await aggregatePaginate(
    Car,
    [{ $match: match }, { $sort: { createdAt: -1 } }],
    req,
    { defaultLimit: wantsPagination(req) ? 50 : 200 },
  );
  const docs = Array.isArray(result?.docs) ? result.docs : [];
  const cars = docs.map((car) => formatCarForRequest(req, car)).filter(Boolean);
  if (wantsPagination(req)) {
    return sendOk(res, paginatedPayload(cars, result), "Cars fetched");
  }
  return sendOk(res, cars, "Cars fetched");
});

const listAvailableCars = asyncHandler(async (req, res) => {
  const { pickupDate, returnDate, pickupTime, returnTime } = req.query;
  if (!pickupDate || !returnDate) {
    throw new ApiError(400, "pickupDate and returnDate are required");
  }
  const windowError = bookingWindowError(pickupDate);
  if (windowError) throw new ApiError(400, windowError);

  const unavailable = await collectUnavailableCarIds({
    pickupDate,
    returnDate,
    pickupTime: pickupTime || "00:00",
    returnTime: returnTime || "23:59",
  });

  const match = { isAvailable: true, ...activeCarsMatch() };
  if (unavailable.size > 0) {
    match._id = {
      $nin: [...unavailable]
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id)),
    };
  }

  const cars = await Car.find(match).sort({ createdAt: -1 }).lean();
  return sendOk(
    res,
    cars.map((car) => formatCarForRequest(req, car)).filter(Boolean),
    "Available cars fetched",
  );
});

const getCarById = asyncHandler(async (req, res) => {
  const car = await Car.findById(req.params.id).lean();
  if (!car || (!isStaff(req.user) && isCarDeactivated(car))) {
    throw new ApiError(404, "Car not found");
  }
  return sendOk(res, formatCarForRequest(req, car), "Car fetched");
});

const createCar = asyncHandler(async (req, res) => {
  const validated = validateCarFields(req.body, { requireAll: true });

  const car = await Car.create({
    ...normalizeCarImageFields(req.body),
    ...validated,
    isAvailable: true,
    status: CAR_STATUS_ACTIVE,
  });
  return sendCreated(res, enrichCar(car), "Car created");
});

const updateCar = asyncHandler(async (req, res) => {
  const patch = normalizeCarImageFields(normalizeUpdateBody(req.body, {
    textKeys: ["description"],
    numberKeys: ["mileage", "dailyMileageLimit", "chargePerExtraKm"],
  }));
  delete patch.status;
  const car = requireFound(
    await Car.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true }),
    "Car not found",
  );
  return sendOk(res, enrichCar(car), "Car updated");
});

const deleteCar = asyncHandler(async (req, res) => {
  const car = requireFound(await Car.findById(req.params.id), "Car not found");
  if (!isCarDeactivated(car)) {
    car.status = CAR_STATUS_DEACTIVE;
    car.isAvailable = false;
    await car.save();
    await stampBookingsForCar(car);
  }
  return sendOk(res, enrichCar(car), "Car deactivated");
});

export {
  listCars,
  listAvailableCars,
  getCarById,
  createCar,
  updateCar,
  deleteCar,
};
