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
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { collectUnavailableCarIds } from "../utils/carAvailability.js";
import { enrichCar, normalizeCarImageFields, sanitizeCarForPublic, stampBookingsForCar } from "../utils/enrichCar.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";
import { aggregatePaginate, paginatedPayload, wantsPagination } from "../utils/paginate.js";

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
  const { category, locationId, availableOnly, includeDeactivated, includeInactive } = query;
  const match = {};
  if (availableOnly === "true") match.isAvailable = true;
  if (typeof category === "string" && category) match.category = category;
  if (typeof locationId === "string" && mongoose.Types.ObjectId.isValid(locationId)) {
    match.locationId = new mongoose.Types.ObjectId(locationId);
  }
  const staffWantsDeactivated =
    isStaff(req.user) && (includeDeactivated === "true" || includeInactive === "true");
  if (!staffWantsDeactivated) {
    Object.assign(match, activeCarsMatch());
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
    return res.status(200).json(new ApiResponse(200, paginatedPayload(cars, result), "Cars fetched"));
  }
  return res.status(200).json(new ApiResponse(200, cars, "Cars fetched"));
});

const listAvailableCars = asyncHandler(async (req, res) => {
  const { pickupDate, returnDate, pickupTime, returnTime } = req.query;
  if (!pickupDate || !returnDate) {
    throw new ApiError(400, "pickupDate and returnDate are required");
  }

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

  const cars = await Car.find(match).sort({ createdAt: -1 });
  return res.status(200).json(
    new ApiResponse(
      200,
      cars.map((car) => formatCarForRequest(req, car)).filter(Boolean),
      "Available cars fetched",
    ),
  );
});

const getCarById = asyncHandler(async (req, res) => {
  const car = await Car.findById(req.params.id);
  if (!car || (!isStaff(req.user) && isCarDeactivated(car))) {
    throw new ApiError(404, "Car not found");
  }
  return res.status(200).json(new ApiResponse(200, formatCarForRequest(req, car), "Car fetched"));
});

const createCar = asyncHandler(async (req, res) => {
  
  const validated = validateCarFields(req.body, { requireAll: true });

  const car = await Car.create({
    ...normalizeCarImageFields(req.body),
    isAvailable: true,
    status: CAR_STATUS_ACTIVE,
  });
  return res.status(201).json(new ApiResponse(201, enrichCar(car), "Car created"));
});

const updateCar = asyncHandler(async (req, res) => {
  const patch = normalizeCarImageFields(normalizeUpdateBody(req.body, {
    textKeys: ["description"],
    numberKeys: ["mileage", "dailyMileageLimit", "chargePerExtraKm"],
  }));
  delete patch.status;
  const car = await Car.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  if (!car) {
    throw new ApiError(404, "Car not found");
  }
  return res.status(200).json(new ApiResponse(200, enrichCar(car), "Car updated"));
});

const deleteCar = asyncHandler(async (req, res) => {
  const car = await Car.findById(req.params.id);
  if (!car) {
    throw new ApiError(404, "Car not found");
  }
  if (!isCarDeactivated(car)) {
    car.status = CAR_STATUS_DEACTIVE;
    car.isAvailable = false;
    await car.save();
    await stampBookingsForCar(car);
  }
  return res.status(200).json(new ApiResponse(200, enrichCar(car), "Car deactivated"));
});

export {
  listCars,
  listAvailableCars,
  getCarById,
  createCar,
  updateCar,
  deleteCar,
};
