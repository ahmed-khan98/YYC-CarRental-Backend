import mongoose from "mongoose";
import mongooseAggregatePaginate from "mongoose-aggregate-paginate-v2";

const vehicleInspectionSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true },
    carId: { type: mongoose.Schema.Types.ObjectId, ref: "Car", required: true },
    type: { type: String, enum: ["check_in", "check_out"], required: true },
    mileage: { type: Number, required: true },
    fuelLevel: {
      type: String,
      enum: ["empty", "quarter", "half", "three_quarter", "full"],
      required: true,
    },
    notes: { type: String },
    imageUrls: [{ type: String }],
    signedPdfUrl: { type: String },
    /** Paid total frozen on the check-in agreement (check-in payment only). */
    paidAmountAtCheckIn: { type: Number },
    /** Security-deposit pre-authorization frozen at check-in (server-forced). */
    securityDepositAmount: { type: Number },
    signatureImageUrl: { type: String },
    conductedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    performedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    performedByName: { type: String },
    performedByRole: { type: String, enum: ["admin", "sub_admin", "customer"] },
    mainDriver: {
      fullLegalName: { type: String },
      dateOfBirth: { type: String },
      phoneNumber: { type: String },
      emailAddress: { type: String },
      homeAddressLine1: { type: String },
      homeAddressLine2: { type: String },
      homeAddressLine3: { type: String },
      licenseNumber: { type: String },
      issuingProvince: { type: String },
      licenseExpiryDate: { type: String },
      policyNo: { type: String },
      licenseImageUrl: { type: String },
    },
    extraDrivers: [
      {
        fullName: { type: String, required: true },
        licenseNumber: { type: String, required: true },
        licenseExpiryDate: { type: String, required: true },
        countryOfIssue: { type: String, required: true },
        licenseImageUrl: { type: String },
      },
    ],
  },
  { timestamps: true },
);

vehicleInspectionSchema.plugin(mongooseAggregatePaginate);
export const VehicleInspection = mongoose.model("VehicleInspection", vehicleInspectionSchema);
