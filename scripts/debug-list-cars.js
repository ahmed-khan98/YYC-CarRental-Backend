import "../src/loadEnv.js";
import mongoose from "mongoose";
import { Car, activeCarsMatch } from "../src/models/car.model.js";
import { enrichCar, sanitizeCarForPublic } from "../src/utils/enrichCar.js";
import { aggregatePaginate } from "../src/utils/paginate.js";

function inspect(label, err) {
  console.error("EXCEPTION at", label);
  console.error("name:", err?.name);
  console.error("message:", err?.message);
  console.error(err?.stack);
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("connected", mongoose.connection.host, mongoose.connection.name);

  const match = { ...activeCarsMatch() };
  console.log("match", JSON.stringify(match));
  console.log("aggregatePaginate type", typeof Car.aggregatePaginate);

  const rawCount = await Car.collection.countDocuments({});
  const activeCount = await Car.collection.countDocuments(match);
  const deactiveCount = await Car.collection.countDocuments({ status: "deactive" });
  console.log({ rawCount, activeCount, deactiveCount });

  const sample = await Car.collection.find({}).limit(3).toArray();
  for (const car of sample) {
    console.log("sample", {
      id: String(car._id),
      status: car.status,
      imageUrlsType: Array.isArray(car.imageUrls) ? "array" : typeof car.imageUrls,
      imageUrlType: typeof car.imageUrl,
      mileage: car.mileage,
      dailyMileageLimit: car.dailyMileageLimit,
      chargePerExtraKm: car.chargePerExtraKm,
      keys: Object.keys(car),
    });
  }

  try {
    const result = await aggregatePaginate(
      Car,
      [{ $match: match }, { $sort: { createdAt: -1 } }],
      { query: {} },
      { defaultLimit: 200 },
    );
    console.log("paginate", {
      docs: result?.docs?.length,
      totalDocs: result?.totalDocs,
      keys: result ? Object.keys(result) : null,
    });
    const cars = result.docs.map((car) => {
      try {
        return sanitizeCarForPublic(enrichCar(car));
      } catch (err) {
        inspect("enrich/sanitize one car", err);
        console.error("bad car keys", Object.keys(car || {}), {
          imageUrls: car?.imageUrls,
          _id: car?._id,
          _idType: typeof car?._id,
        });
        throw err;
      }
    });
    console.log("mapped", cars.length, "firstId", cars[0]?._id);
  } catch (err) {
    inspect("aggregatePaginate or map", err);
  }

  try {
    const cars = await Car.find(match).sort({ createdAt: -1 });
    console.log("find count", cars.length);
    cars.forEach((car) => sanitizeCarForPublic(enrichCar(car)));
    console.log("find enrich ok");
  } catch (err) {
    inspect("Car.find path", err);
  }
} catch (err) {
  inspect("top-level", err);
} finally {
  await mongoose.disconnect().catch(() => {});
}
