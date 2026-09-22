import mongoose from "mongoose";

const EMAIL_JOB_TYPES = [
  "booking_invoice",
  "checkin_agreement",
  "checkout_invoice",
  "billing_invoice",
];

const emailJobSchema = new mongoose.Schema(
  {
    type: { type: String, enum: EMAIL_JOB_TYPES, required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    entryId: { type: mongoose.Schema.Types.ObjectId },
    inspectionId: { type: mongoose.Schema.Types.ObjectId, ref: "VehicleInspection" },
    status: {
      type: String,
      enum: ["pending", "processing", "sent", "failed"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 10 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date },
    pdfUrl: { type: String },
    extraAttachmentUrl: { type: String },
    extraAttachmentName: { type: String },
    messageId: { type: String },
    lastError: { type: String },
    lastErrorCode: { type: String },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

emailJobSchema.index({ type: 1, bookingId: 1, entryId: 1, status: 1 });
emailJobSchema.index({ status: 1, nextRetryAt: 1 });

export const EMAIL_JOB_TYPE = Object.freeze({
  BOOKING_INVOICE: "booking_invoice",
  CHECKIN_AGREEMENT: "checkin_agreement",
  CHECKOUT_INVOICE: "checkout_invoice",
  BILLING_INVOICE: "billing_invoice",
});

export const EmailJob = mongoose.model("EmailJob", emailJobSchema);
