import "../src/loadEnv.js";
import mongoose from "mongoose";
import { Car, activeCarsMatch } from "../src/models/car.model.js";

await mongoose.connect(process.env.MONGODB_URI);
const filter = activeCarsMatch();
const [total, active, deactive, missing] = await Promise.all([
  Car.collection.countDocuments({}),
  Car.collection.countDocuments(filter),
  Car.collection.countDocuments({ status: "deactive" }),
  Car.collection.countDocuments({ $or: [{ status: { $exists: false } }, { status: null }] }),
]);
const deactiveSamples = await Car.collection
  .find({ status: "deactive" }, { projection: { make: 1, model: 1, status: 1, year: 1 } })
  .limit(8)
  .toArray();
console.log(JSON.stringify({
  mongoFilter: filter,
  total,
  activeMatch: active,
  deactive,
  missingOrNullStatus: missing,
  deactiveSamples: deactiveSamples.map((c) => ({
    id: String(c._id),
    make: c.make,
    model: c.model,
    year: c.year,
    status: c.status,
  })),
}, null, 2));
await mongoose.disconnect();
