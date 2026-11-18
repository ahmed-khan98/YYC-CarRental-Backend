import mongoose from "mongoose";

const appConfigSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: "default", unique: true },
    preAuthorizedAmount: { type: Number, required: true, default: 800 },
    userBookingEnabled: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export const AppConfig = mongoose.model("AppConfig", appConfigSchema);
