import mongoose from "mongoose";
import mongooseAggregatePaginate from "mongoose-aggregate-paginate-v2";

const carSchema = new mongoose.Schema(
  {
    make: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, required: true },
    category: {
      type: String,
      enum: ["economy", "compact", "sedan", "suv", "luxury", "sports", "van"],
      required: true,
    },
    color: { type: String, required: true },
    licensePlate: { type: String, required: true },
    vin: { type: String, required: true },
    dailyRate: { type: Number, required: true },
    imageUrl: { type: String },
    imageUrls: [{ type: String }],
    seats: { type: Number, required: true },
    transmission: { type: String, enum: ["automatic", "manual"], required: true },
    fuelType: {
      type: String,
      enum: ["gasoline", "diesel", "electric", "hybrid"],
      required: true,
    },
    isAvailable: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["active", "deactive"],
      default: "active",
    },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: "Location" },
    mileage: { type: Number, required: true, min: 0 },
    dailyMileageLimit: { type: Number, required: true, min: 0 },
    chargePerExtraKm: { type: Number, required: true, min: 0 },
    features: [{ type: String }],
    description: { type: String },
  },
  { timestamps: true },
);

/** Soft delete is the only supported delete path. Do not cascade-remove bookings. */
carSchema.pre("findOneAndDelete", function blockHardCarDelete(next) {
  next(new Error("Cars cannot be hard-deleted. Use status deactive instead."));
});

carSchema.plugin(mongooseAggregatePaginate);

export const CAR_STATUS_ACTIVE = "active";
export const CAR_STATUS_DEACTIVE = "deactive";

/** Missing status is treated as active so existing Mongo documents stay visible. */
export function isCarDeactivated(car) {
  return car?.status === CAR_STATUS_DEACTIVE;
}

export function activeCarsMatch() {
  return { status: { $ne: CAR_STATUS_DEACTIVE } };
}

/**
 * Booking populate / historic booking reads must see deactivated cars.
 * Never add a default pre('find') that forces status=active — that would
 * make booking.populate('carId') return null after a soft delete.
 * Customer catalogs filter with activeCarsMatch() at the controller instead.
 */
carSchema.pre(/^find/, function keepDeactivatedCarsForPopulate() {
  if (this.getOptions()?.includeDeactivated !== true) return;
  const query = this.getQuery();
  if (Object.prototype.hasOwnProperty.call(query, "status")) {
    delete query.status;
  }
});

export const Car = mongoose.model("Car", carSchema);

function toObjectIds(ids = []) {
  return [...new Set((ids ?? []).map((id) => String(id ?? "")).filter(Boolean))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

/** Bypasses query middleware so deactivated cars still hydrate onto bookings. */
export async function findCarsIncludingDeactivated(ids = []) {
  const objectIds = toObjectIds(ids);
  if (!objectIds.length) return [];
  const docs = await Car.collection.find({ _id: { $in: objectIds } }).toArray();
  return docs.map((doc) => Car.hydrate(doc));
}

export async function findCarIncludingDeactivated(id) {
  const [car] = await findCarsIncludingDeactivated([id]);
  return car ?? null;
}
