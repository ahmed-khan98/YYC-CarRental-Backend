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
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: "Location" },
    mileage: { type: Number },
    dailyMileageLimit: { type: Number },
    chargePerExtraKm: { type: Number },
    features: [{ type: String }],
    description: { type: String },
  },
  { timestamps: true },
);

carSchema.plugin(mongooseAggregatePaginate);
export const Car = mongoose.model("Car", carSchema);
