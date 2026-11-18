import mongoose from "mongoose";

const featureSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true, lowercase: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

featureSchema.index({ nameKey: 1 }, { unique: true });
featureSchema.index({ isActive: 1 });

export const Feature = mongoose.model("Feature", featureSchema);
