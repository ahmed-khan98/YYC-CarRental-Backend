import "../src/loadEnv.js";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { User } from "../src/models/user.model.js";

await mongoose.connect(process.env.MONGODB_URI);
const admin = await User.findOne({ role: { $in: ["admin", "sub_admin"] }, isActive: { $ne: false } }).select("_id role");
if (!admin) {
  console.log(JSON.stringify({ error: "no staff user" }));
  await mongoose.disconnect();
  process.exit(1);
}
const token = jwt.sign({ userId: String(admin._id) }, process.env.JWT_SECRET, { expiresIn: "10m" });
const res = await fetch("http://127.0.0.1:5001/api/v1/cars?includeDeactivated=true", {
  headers: { Authorization: `Bearer ${token}` },
});
const body = await res.json();
const data = Array.isArray(body.data) ? body.data : body.data?.items || [];
console.log(JSON.stringify({
  httpStatus: res.status,
  staffRole: admin.role,
  success: body.success,
  count: data.length,
  statuses: data.map((c) => c.status ?? null),
  deactiveCount: data.filter((c) => c.status === "deactive").length,
  cars: data.map((c) => ({ id: c._id, make: c.make, model: c.model, status: c.status })),
}, null, 2));
await mongoose.disconnect();
