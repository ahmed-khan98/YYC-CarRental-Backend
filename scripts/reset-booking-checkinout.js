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

const inspections = await VehicleInspection.find({ bookingId });
const checkIn = inspections.find((i) => i.type === "check_in");
const checkOut = inspections.find((i) => i.type === "check_out");
const inspectionIds = inspections.map((i) => ({
  id: i._id.toString(),
  type: i.type,
  mileage: i.mileage,
}));

console.log("Inspections:", inspectionIds);

const car = booking.carId ? await Car.findById(booking.carId) : null;
const revertCarMileage = checkIn?.mileage ?? booking.checkInMileage ?? null;

const beforeBillCount = booking.billEntries?.length ?? 0;
const removedBillEntries = [];

booking.billEntries = (booking.billEntries ?? []).filter((entry) => {
  const shouldRemove =
    entry.entryType === "payment" ||
    entry.source === "manual" ||
    entry.systemKey === "extra_mileage";
  if (shouldRemove) {
    removedBillEntries.push({
      id: entry._id?.toString(),
      title: entry.title,
      entryType: entry.entryType,
      amount: entry.amount,
      systemKey: entry.systemKey ?? null,
    });
    return false;
  }
  return true;
});

console.log("Removed bill entries:", removedBillEntries);

for (const entry of booking.billEntries ?? []) {
  entry.invoiceNumber = undefined;
  entry.invoicePdfUrl = undefined;
}

booking.status = "confirmed";
booking.checkInVisibleToUser = false;
booking.checkOutVisibleToUser = false;
booking.paymentStatus = "pending";
booking.extraMileageCharge = 0;
booking.invoiceSequence = 0;
booking.set("checkInBillSnapshot", undefined);
booking.set("checkOutBillSnapshot", undefined);

await syncBookingBillEntries(booking, car);
await booking.save();

await Booking.findByIdAndUpdate(bookingId, {
  $unset: {
    checkInMileage: "",
    checkOutMileage: "",
    totalDrivenKm: "",
    allowedMileageKm: "",
    extraMileageKm: "",
    checkInBillSnapshot: "",
    checkOutBillSnapshot: "",
    invoiceSequence: "",
    "billEntries.$[].invoiceNumber": "",
    "billEntries.$[].invoicePdfUrl": "",
  },
});

const delResult = await VehicleInspection.deleteMany({ bookingId });
console.log("Deleted inspections:", delResult.deletedCount);

if (car && revertCarMileage != null) {
  await Car.findByIdAndUpdate(car._id, { mileage: revertCarMileage });
  console.log("Car mileage reverted to check-in baseline:", revertCarMileage);
} else if (car) {
  console.log("Car mileage unchanged:", car.mileage);
}

const updated = await Booking.findById(bookingId);
const remainingInspections = await VehicleInspection.find({ bookingId }).select("_id type");
console.log("Updated booking:", {
  status: updated.status,
  totalAmount: updated.totalAmount,
  extraMileageCharge: updated.extraMileageCharge,
  extraMileageKm: updated.extraMileageKm,
  billEntries: updated.billEntries.length,
  removedBillEntries: beforeBillCount - updated.billEntries.length,
  remainingInspections: remainingInspections.map((i) => ({
    id: i._id.toString(),
    type: i.type,
  })),
});

await mongoose.disconnect();
console.log("Done. Booking ready for check-in / check-out retest.");
