import mongoose from "mongoose";

const appConfigSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: "default", unique: true },
    preAuthorizedAmount: { type: Number, required: true, default: 800 },
  },
  { timestamps: true },
);

export const AppConfig = mongoose.model("AppConfig", appConfigSchema);
