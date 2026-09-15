import { Booking } from "../models/booking.model.js";
import { rentalPeriodsConflictEitherWay } from "./datesOverlap.js";

function isActiveBooking(status) {
  return status !== "cancelled" && status !== "completed";
}

export async function collectUnavailableCarIds({
  pickupDate,
  returnDate,
  pickupTime = "00:00",
  returnTime = "23:59",
}) {
  const bookings = await Booking.find({
    status: { $nin: ["cancelled", "completed"] },
  }).select("carId pickupDate pickupTime returnDate returnTime status");

  const unavailable = new Set();
  for (const booking of bookings) {
    if (!isActiveBooking(booking.status)) continue;
    const overlaps = rentalPeriodsConflictEitherWay(
      booking.pickupDate,
      booking.pickupTime,
      booking.returnDate,
      booking.returnTime,
      pickupDate,
      pickupTime,
      returnDate,
      returnTime,
    );
    if (overlaps) {
      unavailable.add(booking.carId.toString());
    }
  }
  return unavailable;
}
