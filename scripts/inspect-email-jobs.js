import "../src/loadEnv.js";
import mongoose from "mongoose";
import { EmailJob } from "../src/models/emailJob.model.js";

await mongoose.connect(process.env.MONGODB_URI);
const ids = ["6ab2e552f9bb435cd5d9f432", "6aa6e4dfc154bb500a5bd97c"];
const jobs = await EmailJob.find({ bookingId: { $in: ids } })
  .sort({ createdAt: 1 })
  .lean();
console.log(
  JSON.stringify(
    jobs.map((job) => ({
      id: String(job._id),
      type: job.type,
      bookingId: String(job.bookingId),
      entryId: job.entryId ? String(job.entryId) : null,
      inspectionId: job.inspectionId ? String(job.inspectionId) : null,
      status: job.status,
      attempts: job.attempts,
      messageId: job.messageId ?? null,
      lastError: job.lastError ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })),
    null,
    2,
  ),
);
await mongoose.disconnect();
