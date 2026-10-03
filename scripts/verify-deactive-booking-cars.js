import "../src/loadEnv.js";
import mongoose from "mongoose";
import { Booking } from "../src/models/booking.model.js";
import { Car } from "../src/models/car.model.js";
import {
  bookingCarPopulate,
  enrichPopulatedCar,
  ensureBookingCars,
} from "../src/utils/enrichCar.js";

await mongoose.connect(process.env.MONGODB_URI);

const deactiveCars = await Car.find({ status: "deactive" }).select("make model year status");
const missingStatus = await Car.countDocuments({ status: { $exists: false } });
const activeCars = await Car.countDocuments({ status: { $ne: "deactive" } });

const recent = await Booking.find()
  .sort({ createdAt: -1 })
  .limit(15)
  .select("carId status pickupDate")
  .populate(bookingCarPopulate("make model year status"));

const beforeNull = recent.filter((booking) => !enrichPopulatedCar(booking)).length;
await ensureBookingCars(recent);
const afterNull = recent.filter((booking) => !enrichPopulatedCar(booking)).length;

const deactiveIds = deactiveCars.map((car) => car._id);
const deactiveBookings = deactiveIds.length
  ? await Booking.find({ carId: { $in: deactiveIds } })
      .limit(8)
      .select("carId status")
      .populate(bookingCarPopulate("make model year status"))
  : [];
const deactiveBefore = deactiveBookings.map((booking) => Boolean(enrichPopulatedCar(booking)));
await ensureBookingCars(deactiveBookings);
const deactiveAfter = deactiveBookings.map((booking) => {
  const car = enrichPopulatedCar(booking);
  return car ? `${car.make} ${car.model} (${car.status ?? "active"})` : null;
});

console.log(JSON.stringify({
  cars: {
    activeOrLegacy: activeCars,
    deactive: deactiveCars.length,
    deactiveNames: deactiveCars.map((car) => `${car.make} ${car.model}`),
    missingStatus,
  },
  recentBookings: {
    checked: recent.length,
    nullBeforeEnsure: beforeNull,
    nullAfterEnsure: afterNull,
    sample: recent.slice(0, 8).map((booking) => {
      const car = enrichPopulatedCar(booking);
      return {
        id: String(booking._id).slice(-8),
        status: booking.status,
        car: car ? `${car.make} ${car.model}` : null,
      };
    }),
  },
  deactiveCarBookings: {
    found: deactiveBookings.length,
    populatedBeforeEnsure: deactiveBefore,
    carsAfterEnsure: deactiveAfter,
  },
}, null, 2));

await mongoose.disconnect();
