import "../src/loadEnv.js";
import mongoose from "mongoose";
import { Booking } from "../src/models/booking.model.js";
import { VehicleInspection } from "../src/models/vehicleInspection.model.js";
import { Car } from "../src/models/car.model.js";
import { syncBookingBillEntries } from "../src/utils/billing.js";

const SUFFIX = (process.argv[2] ?? "068cfc4a").toLowerCase();

await mongoose.connect(process.env.MONGODB_URI);

const bookings = await Booking.find({});
const booking = bookings.find((b) => b._id.toString().toLowerCase().endsWith(SUFFIX));
if (!booking) {
  console.log("Booking not found for suffix", SUFFIX);
  process.exit(1);
}

const bookingId = booking._id;
console.log("Found booking:", bookingId.toString(), "status:", booking.status);

const checkIn = await VehicleInspection.findOne({ bookingId, type: "check_in" });
const checkOutCount = await VehicleInspection.countDocuments({ bookingId, type: "check_out" });
console.log("Check-out inspections:", checkOutCount);
console.log("Check-in mileage:", checkIn?.mileage ?? "none");

const car = booking.carId ? await Car.findById(booking.carId) : null;
const checkoutChargeTitles = new Set(["fuel refill"]);

const beforeBillCount = booking.billEntries?.length ?? 0;
booking.billEntries = (booking.billEntries ?? []).filter((entry) => {
  if (entry.systemKey === "extra_mileage") return false;
  if (entry.entryType === "payment" && /check[\s-]?out/i.test(entry.title ?? "")) return false;
  if (entry.phase === "check_out" && entry.entryType === "payment") return false;
  if (
    entry.entryType === "charge" &&
    entry.source === "manual" &&
    (entry.phase === "check_out" ||
      checkoutChargeTitles.has(String(entry.title).trim().toLowerCase()))
  ) {
    return false;
  }
  return true;
});

booking.status = checkIn ? "checked_in" : booking.status;
booking.checkOutVisibleToUser = false;
booking.extraMileageCharge = 0;
booking.set("checkOutBillSnapshot", undefined);

await syncBookingBillEntries(booking, car);
await booking.save();

const delResult = await VehicleInspection.deleteMany({ bookingId, type: "check_out" });
console.log("Deleted check-out inspections:", delResult.deletedCount);

await Booking.findByIdAndUpdate(bookingId, {
  $unset: {
    checkOutMileage: "",
    totalDrivenKm: "",
    allowedMileageKm: "",
    extraMileageKm: "",
    checkOutBillSnapshot: "",
  },
});

if (checkIn && booking.carId) {
  await Car.findByIdAndUpdate(booking.carId, { mileage: checkIn.mileage });
  console.log("Car mileage reverted to check-in:", checkIn.mileage);
}

const updated = await Booking.findById(bookingId);
console.log("Updated booking:", {
  status: updated.status,
  totalAmount: updated.totalAmount,
  extraMileageCharge: updated.extraMileageCharge,
  billEntries: updated.billEntries.length,
  removedBillEntries: beforeBillCount - updated.billEntries.length,
});

await mongoose.disconnect();
console.log("Done.");
