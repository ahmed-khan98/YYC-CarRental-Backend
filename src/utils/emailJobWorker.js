import { Booking } from "../models/booking.model.js";
import { EMAIL_JOB_TYPE, EmailJob } from "../models/emailJob.model.js";
import { VehicleInspection } from "../models/vehicleInspection.model.js";
import {
  attachInspectionInvoices,
  generateAndStoreCheckInAgreement,
  generateSavedCheckoutAgreementPdf,
} from "../controllers/inspection.controller.js";
import { sendBillingChargeEmail } from "./billingChargeEmail.js";
import { sendBookingConfirmationEmail } from "./bookingConfirmationEmail.js";
import { sendCheckInAgreementEmail } from "./checkInAgreementEmail.js";
import { sendCheckOutInvoiceEmail } from "./checkOutInvoiceEmail.js";
import {
  attachInvoiceToBillEntry,
  attachInvoicesForChangedEntries,
  generateCheckOutInvoicePdf,
  generateFullInvoicePdf,
} from "./billInvoicePdf.js";
import { computeDepositTotals } from "./securityDeposit.js";
import { fetchStoredPdf, readStoredFile, uploadPdfToStorage } from "./localFileStore.js";
import {
  claimNextEmailJob,
  isPermanentEmailFailure,
  markEmailJobFailure,
  markEmailJobSent,
  recoverStuckEmailJobs,
} from "./emailJobs.js";

const DEFAULT_POLL_MS = 15_000;

function asError(reason, message) {
  const err = new Error(message || reason);
  err.reason = reason;
  err.code = reason;
  return err;
}

function requirePdf(buffer, label) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 5) {
    throw asError("no_pdf", `${label} PDF is missing`);
  }
  return buffer;
}

async function loadStoredPdf(url) {
  if (!url) return null;
  return (await fetchStoredPdf(url)) || (await readStoredFile(url));
}

async function persistJobPdf(job, buffer, folder) {
  const pdf = requirePdf(buffer, job.type);
  const uploaded = await uploadPdfToStorage(pdf, folder);
  job.pdfUrl = uploaded.secure_url;
  await job.save();
  return pdf;
}

async function pdfForJob(job, folder, builder) {
  const existing = await loadStoredPdf(job.pdfUrl);
  if (existing) return requirePdf(existing, job.type);
  job.pdfUrl = undefined;
  const built = await builder();
  return persistJobPdf(job, built, folder);
}

async function assertStillSendable(job) {
  const fresh = await EmailJob.findById(job._id).select("status messageId");
  if (!fresh || fresh.status === "failed" || fresh.status === "sent") {
    throw asError("cancelled", "Email job was cancelled");
  }
  if (fresh.messageId) {
    await markEmailJobSent(job, { messageId: fresh.messageId });
    return false;
  }

  const alreadySent = await EmailJob.findOne({
    _id: { $ne: job._id },
    type: job.type,
    bookingId: job.bookingId,
    status: "sent",
    ...(job.entryId ? { entryId: job.entryId } : {}),
    ...(job.inspectionId ? { inspectionId: job.inspectionId } : {}),
  }).select("messageId");
  if (alreadySent) {
    await markEmailJobSent(job, { messageId: alreadySent.messageId || "duplicate_skipped" });
    return false;
  }
  return true;
}

function applySendResult(job, mailed) {
  if (mailed && mailed.skipped === false) {
    return markEmailJobSent(job, mailed.info);
  }
  const reason = mailed?.reason || "send_failed";
  const err = asError(reason, `Email skipped: ${reason}`);
  return markEmailJobFailure(job, err, { permanent: isPermanentEmailFailure(err) });
}

async function processBookingInvoice(job) {
  const booking = await Booking.findById(job.bookingId);
  if (!booking) throw asError("missing_booking", "Booking not found");

  await attachInvoicesForChangedEntries(booking, []);
  if (booking.isModified()) await booking.save();

  const pdfBuffer = await pdfForJob(job, "booking-invoices", () => generateFullInvoicePdf(booking));

  if (job.payload?.sendEmail === false) {
    job.lastErrorCode = "skipped_admin";
    return markEmailJobSent(job, { messageId: "skipped_admin" });
  }

  if (!(await assertStillSendable(job))) return;
  return applySendResult(job, await sendBookingConfirmationEmail(booking, pdfBuffer));
}

async function processCheckInAgreement(job) {
  await attachInspectionInvoices(
    job.bookingId,
    job.payload?.previousBillEntries ?? null,
    job.payload?.pendingInvoiceEntryIds ?? [],
  );

  const inspection = await VehicleInspection.findById(job.inspectionId);
  const booking = await Booking.findById(job.bookingId);
  if (!inspection) throw asError("missing_inspection", "Check-in inspection not found");
  if (!booking) throw asError("missing_booking", "Booking not found");

  let pdfBuffer = await loadStoredPdf(job.pdfUrl || inspection.signedPdfUrl);
  if (!pdfBuffer) {
    const generated = await generateAndStoreCheckInAgreement(job.inspectionId);
    pdfBuffer = generated?.pdfBuffer;
    if (generated?.inspection?.signedPdfUrl) {
      job.pdfUrl = generated.inspection.signedPdfUrl;
      await job.save();
    }
  } else if (!job.pdfUrl && inspection.signedPdfUrl) {
    job.pdfUrl = inspection.signedPdfUrl;
    await job.save();
  }

  requirePdf(pdfBuffer, "check-in agreement");
  const inspectionStillThere = await VehicleInspection.exists({ _id: job.inspectionId });
  if (!inspectionStillThere) throw asError("missing_inspection", "Check-in inspection not found");
  if (!(await assertStillSendable(job))) return;
  return applySendResult(
    job,
    await sendCheckInAgreementEmail(booking, pdfBuffer),
  );
}

async function processCheckOutInvoice(job) {
  await attachInspectionInvoices(
    job.bookingId,
    job.payload?.previousBillEntries ?? null,
    job.payload?.pendingInvoiceEntryIds ?? [],
  );

  const booking = await Booking.findById(job.bookingId);
  if (!booking) throw asError("missing_booking", "Booking not found");

  const pdfBuffer = await pdfForJob(job, "checkout-invoices", () => generateCheckOutInvoicePdf(booking));
  if (!(await assertStillSendable(job))) return;
  const mailed = await sendCheckOutInvoiceEmail(booking, pdfBuffer);
  await applySendResult(job, mailed);
  if (mailed?.skipped) return;

  if (!job.inspectionId) return;
  const inspection = await VehicleInspection.findById(job.inspectionId);
  if (!inspection || inspection.signedPdfUrl) return;
  try {
    const agreement = await generateSavedCheckoutAgreementPdf(inspection);
    const uploaded = await uploadPdfToStorage(agreement, "check-out-documents");
    inspection.signedPdfUrl = uploaded.secure_url;
    await inspection.save();
  } catch (err) {
    console.error("Check-out agreement store failed after invoice email:", err?.message || err);
  }
}

async function processBillingInvoice(job) {
  const booking = await Booking.findById(job.bookingId);
  if (!booking) throw asError("missing_booking", "Booking not found");
  const entry = booking.billEntries?.id(job.entryId);
  if (!entry) throw asError("missing_entry", "Bill entry not found");

  let pdfBuffer = await loadStoredPdf(job.pdfUrl || entry.invoicePdfUrl);
  if (!pdfBuffer) {
    pdfBuffer = await attachInvoiceToBillEntry(booking, entry);
    if (booking.isModified()) await booking.save();
    if (entry.invoicePdfUrl) {
      job.pdfUrl = entry.invoicePdfUrl;
      await job.save();
    }
  } else if (!job.pdfUrl && entry.invoicePdfUrl) {
    job.pdfUrl = entry.invoicePdfUrl;
    await job.save();
  }
  requirePdf(pdfBuffer, "billing invoice");

  const attachmentUrl = job.extraAttachmentUrl || entry.attachmentUrl;
  let extraAttachment;
  if (attachmentUrl) {
    const content = await readStoredFile(attachmentUrl);
    if (content) {
      extraAttachment = {
        filename: job.extraAttachmentName || entry.attachmentName || "attachment",
        content,
        contentType: "application/octet-stream",
      };
    }
  }

  const { remainingAmount } = computeDepositTotals(booking);
  if (!(await assertStillSendable(job))) return;
  return applySendResult(
    job,
    await sendBillingChargeEmail({
      booking,
      entry,
      pdfBuffer,
      remainingDeposit: remainingAmount,
      attachment: extraAttachment,
    }),
  );
}

async function processEmailJob(job) {
  if (job.messageId && job.status !== "sent") {
    return markEmailJobSent(job, { messageId: job.messageId });
  }
  if (!(await assertStillSendable(job))) return;

  switch (job.type) {
    case EMAIL_JOB_TYPE.BOOKING_INVOICE:
      return processBookingInvoice(job);
    case EMAIL_JOB_TYPE.CHECKIN_AGREEMENT:
      return processCheckInAgreement(job);
    case EMAIL_JOB_TYPE.CHECKOUT_INVOICE:
      return processCheckOutInvoice(job);
    case EMAIL_JOB_TYPE.BILLING_INVOICE:
      return processBillingInvoice(job);
    default:
      throw asError("unknown_type", `Unknown email job type: ${job.type}`);
  }
}

async function tick() {
  if (tick.running) return;
  tick.running = true;
  try {
    await recoverStuckEmailJobs();
    const job = await claimNextEmailJob();
    if (!job) return;
    try {
      await processEmailJob(job);
    } catch (err) {
      await markEmailJobFailure(job, err, { permanent: isPermanentEmailFailure(err) });
    }
  } catch (err) {
    console.error("Email job worker tick failed:", err?.message || err);
  } finally {
    tick.running = false;
  }
}

export function startEmailJobWorker() {
  const pollMs = Number(process.env.EMAIL_JOB_POLL_MS) || DEFAULT_POLL_MS;
  console.log(`✓ Email job worker every ${pollMs}ms`);
  tick();
  const timer = setInterval(tick, pollMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
