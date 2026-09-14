import mongoose from "mongoose";
import { Car } from "../models/car.model.js";
import { isStaff } from "../middlewares/auth.middleware.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { enrichCar, sanitizeCarForPublic } from "../utils/enrichCar.js";
import { normalizeUpdateBody } from "../utils/patchPayload.js";
import { aggregatePaginate, paginatedPayload, wantsPagination } from "../utils/paginate.js";

function formatCarForRequest(req, car) {
  const enriched = enrichCar(car);
  return isStaff(req.user) ? enriched : sanitizeCarForPublic(enriched);
}

const listCars = asyncHandler(async (req, res) => {
  const { category, locationId, availableOnly } = req.query;
  const match = {};
  if (availableOnly === "true") match.isAvailable = true;
  if (category) match.category = category;
  if (locationId && mongoose.Types.ObjectId.isValid(locationId)) {
    match.locationId = new mongoose.Types.ObjectId(locationId);
  }

  const result = await aggregatePaginate(
    Car,
    [{ $match: match }, { $sort: { createdAt: -1 } }],
    req,
    { defaultLimit: wantsPagination(req) ? 50 : 200 },
  );
  const cars = result.docs.map((car) => formatCarForRequest(req, car));
  if (wantsPagination(req)) {
    return res.status(200).json(new ApiResponse(200, paginatedPayload(cars, result), "Cars fetched"));
  }
  return res.status(200).json(new ApiResponse(200, cars, "Cars fetched"));
});

const getCarById = asyncHandler(async (req, res) => {
  const car = await Car.findById(req.params.id);
  if (!car) {
    throw new ApiError(404, "Car not found");
  }
  return res.status(200).json(new ApiResponse(200, formatCarForRequest(req, car), "Car fetched"));
});

const createCar = asyncHandler(async (req, res) => {
  const car = await Car.create({ ...req.body, isAvailable: true });
  return res.status(201).json(new ApiResponse(201, enrichCar(car), "Car created"));
});

const updateCar = asyncHandler(async (req, res) => {
  const patch = normalizeUpdateBody(req.body, {
    textKeys: ["description"],
    numberKeys: ["mileage", "dailyMileageLimit", "chargePerExtraKm"],
  });
  const car = await Car.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  if (!car) {
    throw new ApiError(404, "Car not found");
  }
  return res.status(200).json(new ApiResponse(200, enrichCar(car), "Car updated"));
});

const deleteCar = asyncHandler(async (req, res) => {
  const car = await Car.findByIdAndDelete(req.params.id);
  if (!car) {
    throw new ApiError(404, "Car not found");
  }
  return res.status(200).json(new ApiResponse(200, { success: true }, "Car deleted"));
});

export {
  listCars,
  getCarById,
  createCar,
  updateCar,
  deleteCar,
};
