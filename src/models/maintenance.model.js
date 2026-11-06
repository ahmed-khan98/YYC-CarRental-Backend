import mongoose from "mongoose";

const maintenanceSchema = new mongoose.Schema(
  {
    carId: { type: mongoose.Schema.Types.ObjectId, ref: "Car", required: true },
    type: { type: String, required: true },
    description: { type: String, required: true },
    scheduledDate: { type: String, required: true },
    completedDate: { type: String },
    cost: { type: Number },
    status: {
      type: String,
      enum: ["scheduled", "in_progress", "completed"],
      default: "scheduled",
    },
    notes: { type: String },
  },
  { timestamps: true },
);

maintenanceSchema.index({ carId: 1, createdAt: -1 });
maintenanceSchema.index({ status: 1, createdAt: -1 });

export const Maintenance = mongoose.model("Maintenance", maintenanceSchema);
