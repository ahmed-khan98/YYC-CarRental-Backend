import mongoose from "mongoose";

const additionalServiceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    dailyRate: { type: Number, required: true },
    chargeType: {
      type: String,
      enum: ["per_day", "per_trip"],
      default: "per_day",
    },
    category: {
      type: String,
      enum: ["equipment", "driver", "insurance", "other"],
      required: true,
    },
    /** Shows +/- quantity counter on booking for any service (e.g. spare wheel × 2). */
    allowQuantity: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

additionalServiceSchema.index({ isActive: 1 });
additionalServiceSchema.index({ category: 1, isActive: 1 });

export const AdditionalService = mongoose.model("AdditionalService", additionalServiceSchema);
