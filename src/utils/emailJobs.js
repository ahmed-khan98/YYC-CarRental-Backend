import { EmailJob } from "../models/emailJob.model.js";

const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
];
const LOCK_MS = 4 * 60_000;
const PERMANENT_REASONS = new Set([
  "no_email",
  "undeliverable",
  "INVALID_RECIPIENT",
  "EMAIL_UNDELIVERABLE",
  "missing_booking",
  "missing_entry",
  "missing_inspection",
  "unknown_type",
  "cancelled",
  "superseded",
]);

export function isPermanentEmailFailure(reasonOrErr) {
  const reason = String(reasonOrErr?.reason || reasonOrErr?.code || reasonOrErr || "");
  return PERMANENT_REASONS.has(reason);
}

export function nextRetryDelayMs(attempts) {
  const index = Math.max(0, Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[index];
}

function isBookingScopedType(type) {
  return type === "checkin_agreement" || type === "checkout_invoice" || type === "booking_invoice";
}

function sameOpenJobFilter({ type, bookingId, entryId, inspectionId }) {
  const filter = {
    type,
    bookingId,
    status: { $in: ["pending", "processing"] },
  };
  if (isBookingScopedType(type)) return filter;
  if (entryId) filter.entryId = entryId;
  if (inspectionId) filter.inspectionId = inspectionId;
  return filter;
}

export async function cancelEmailJobs({ bookingId, type, reason = "cancelled" }) {
  return EmailJob.updateMany(
    {
      bookingId,
      ...(type ? { type } : {}),
      status: { $in: ["pending", "processing", "failed"] },
    },
    {
      $set: {
        status: "failed",
        lastError: reason,
        lastErrorCode: "cancelled",
      },
      $unset: { lockedAt: 1 },
    },
  );
}

export async function enqueueEmailJob({
  type,
  bookingId,
  entryId,
  inspectionId,
  extraAttachmentUrl,
  extraAttachmentName,
  payload = {},
  refresh = false,
}) {
  if (!type || !bookingId) {
    throw new Error("Email job requires type and bookingId");
  }

  if (isBookingScopedType(type)) {
    await EmailJob.updateMany(
      {
        type,
        bookingId,
        status: { $in: ["pending", "processing"] },
        ...(inspectionId ? { inspectionId: { $ne: inspectionId } } : {}),
      },
      {
        $set: {
          status: "failed",
          lastError: "Superseded by a newer job",
          lastErrorCode: "superseded",
        },
        $unset: { lockedAt: 1 },
      },
    );
  }

  const existing = await EmailJob.findOne(
    sameOpenJobFilter({ type, bookingId, entryId, inspectionId }),
  );
  if (existing) {
    if (inspectionId) existing.inspectionId = inspectionId;
    if (entryId) existing.entryId = entryId;
    if (refresh) {
      existing.pdfUrl = undefined;
      existing.status = "pending";
      existing.nextRetryAt = new Date();
      existing.lockedAt = undefined;
      existing.extraAttachmentUrl = extraAttachmentUrl || existing.extraAttachmentUrl;
      existing.extraAttachmentName = extraAttachmentName || existing.extraAttachmentName;
      if (payload && Object.keys(payload).length) existing.payload = payload;
    }
    if (existing.isModified()) await existing.save();
    return existing;
  }

  return EmailJob.create({
    type,
    bookingId,
    entryId,
    inspectionId,
    extraAttachmentUrl,
    extraAttachmentName,
    payload,
    status: "pending",
    nextRetryAt: new Date(),
  });
}

export async function recoverStuckEmailJobs(now = new Date()) {
  await EmailJob.updateMany(
    { status: "processing", messageId: { $nin: [null, ""] } },
    { $set: { status: "sent" }, $unset: { lockedAt: 1, nextRetryAt: 1 } },
  );
  const cutoff = new Date(now.getTime() - LOCK_MS);
  const result = await EmailJob.updateMany(
    { status: "processing", lockedAt: { $lt: cutoff }, messageId: { $in: [null, ""] } },
    { $set: { status: "pending", nextRetryAt: now }, $unset: { lockedAt: 1 } },
  );
  if (result.modifiedCount) {
    console.warn("Email job worker requeued stuck jobs:", result.modifiedCount);
  }
}

export async function claimNextEmailJob(now = new Date()) {
  return EmailJob.findOneAndUpdate(
    {
      status: "pending",
      nextRetryAt: { $lte: now },
      $or: [{ messageId: { $exists: false } }, { messageId: null }, { messageId: "" }],
    },
    {
      $set: { status: "processing", lockedAt: now },
    },
    { sort: { nextRetryAt: 1, createdAt: 1 }, new: true },
  );
}

export async function markEmailJobSent(job, info) {
  job.status = "sent";
  job.messageId = info?.messageId || job.messageId;
  job.lastError = undefined;
  job.lastErrorCode = undefined;
  job.lockedAt = undefined;
  job.nextRetryAt = undefined;
  await job.save();
}

export async function markEmailJobFailure(job, err, { permanent = false } = {}) {
  const attempts = (job.attempts || 0) + 1;
  const reason = err?.reason || err?.code || "";
  const giveUp = permanent || isPermanentEmailFailure(err) || attempts >= (job.maxAttempts || 10);

  job.attempts = attempts;
  job.lastError = String(err?.message || err).slice(0, 500);
  job.lastErrorCode = String(reason || (giveUp ? "failed" : "retry")).slice(0, 80);
  job.lockedAt = undefined;

  if (giveUp) {
    job.status = "failed";
    console.error("Email job failed permanently:", {
      id: String(job._id),
      type: job.type,
      bookingId: String(job.bookingId),
      attempts,
      message: job.lastError,
    });
  } else {
    job.status = "pending";
    job.nextRetryAt = new Date(Date.now() + nextRetryDelayMs(attempts));
    console.warn("Email job retry scheduled:", {
      id: String(job._id),
      type: job.type,
      bookingId: String(job.bookingId),
      attempts,
      nextRetryAt: job.nextRetryAt,
      message: job.lastError,
    });
  }

  await job.save();
}
