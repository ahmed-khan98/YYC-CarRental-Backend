import { VehicleInspection } from "../models/vehicleInspection.model.js";
import { Booking } from "../models/booking.model.js";
import { Car } from "../models/car.model.js";
import { User } from "../models/user.model.js";
import { Location } from "../models/location.model.js";
import { isStaff } from "../middlewares/auth.middleware.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { aggregatePaginate, paginatedPayload, wantsPagination } from "../utils/paginate.js";
import { formatDoc } from "../utils/formatDoc.js";
import { enrichCar } from "../utils/enrichCar.js";
import { formatInspections } from "../utils/formatInspection.js";
import {
  uploadToStorage,
  uploadPdfToStorage,
  fetchStoredPdf,
  readStoredFile,
} from "../utils/localFileStore.js";
import {
  buildAgreementContext,
  generateCheckInAgreementPdf,
  generateSignedCheckInAgreementPdf,
  parseSignatureDataUrl,
  resolveCheckInPaidAmount,
} from "../utils/checkInAgreementPdf.js";
import { calculateRentalDays } from "../utils/rentalPricing.js";
import { calculateExtraMileageBilling } from "../utils/extraMileage.js";
import {
  resolveBookedChargePerExtraKm,
  resolveBookedDailyMileageLimit,
} from "../utils/bookingSnapshot.js";
import {
  applyInspectionActorToBooking,
  createdByFields,
  performedByFields,
  staffUpdatedByFields,
} from "../utils/bookingAudit.js";
import {
  resolveBookingExtraDriverCount,
  validateExtraDriverCheckInDetails,
  normalizeExtraDriverCheckInDetails,
} from "../utils/extraDriver.js";
import {
  validateMainDriverCheckInDetails,
  normalizeMainDriverCheckInDetails,
} from "../utils/mainDriver.js";
import {
  appendBillEntry,
  capturePhaseBillSnapshot,
  syncBookingBillEntries,
  computeBillSummary,
} from "../utils/billing.js";
import {
  applySecurityDepositOnCheckIn,
  SECURITY_DEPOSIT_AMOUNT,
} from "../utils/securityDeposit.js";
import {
  attachInvoiceToBillEntry,
  attachInvoicesForChangedEntries,
  snapshotBillEntryState,
} from "../utils/billInvoicePdf.js";
import { EMAIL_JOB_TYPE } from "../models/emailJob.model.js";
import { enqueueEmailJob } from "../utils/emailJobs.js";

async function loadAgreementPdfContext(
  bookingId,
  checkInDraft = {},
  checkOutDraft = {},
  issuedAt,
  options = {},
) {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  const [car, customer, pickupLocation, dropoffLocation] = await Promise.all([
    Car.findById(booking.carId),
    User.findById(booking.userId),
    Location.findById(booking.pickupLocationId),
    Location.findById(booking.dropoffLocationId),
  ]);

  return buildAgreementContext({
    booking,
    car,
    customer,
    pickupLocation,
    dropoffLocation,
    checkInDraft,
    checkOutDraft,
    issuedAt,
    mode: options.mode,
    paidAmountOverride: options.paidAmountOverride,
    paymentCutoffAt: options.paymentCutoffAt,
    checkInAt: options.checkInAt,
    checkOutAt: options.checkOutAt,
  });
}

function sendPdf(res, pdfBuffer, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  return res.send(pdfBuffer);
}

function checkInPaymentSnapshot(inspection, booking) {
  return resolveCheckInPaidAmount({
    billEntries: booking.billEntries,
    pendingCheckInPaid: inspection.paidAmountAtCheckIn,
    paidAmountOverride: inspection.paidAmountAtCheckIn,
    paymentCutoffAt: inspection.createdAt ?? inspection._creationTime,
  });
}

function checkInDraftFromInspection(inspection) {
  if (!inspection) return {};
  return {
    mainDriver: inspection.mainDriver,
    mileage: inspection.mileage,
    fuelLevel: inspection.fuelLevel,
    notes: inspection.notes,
    extraDrivers: inspection.extraDrivers,
  };
}

function billEntryId(entry) {
  if (!entry) return "";
  if (entry._id != null) return String(entry._id);
  return String(entry.entryId ?? "");
}

export async function attachInspectionInvoices(bookingId, previousBillEntries, pendingInvoiceEntryIds = []) {
  if (previousBillEntries == null && pendingInvoiceEntryIds.length === 0) {
    return Booking.findById(bookingId);
  }

  const booking = await Booking.findById(bookingId);
  if (!booking) return null;

  if (previousBillEntries != null) {
    await attachInvoicesForChangedEntries(booking, previousBillEntries);
  }

  for (const entryId of pendingInvoiceEntryIds) {
    const entry = (booking.billEntries ?? []).find((item) => billEntryId(item) === String(entryId));
    if (!entry || entry.invoicePdfUrl) continue;
    await attachInvoiceToBillEntry(booking, entry);
  }

  await booking.save();
  return booking;
}

export async function generateAndStoreCheckInAgreement(inspectionId) {
  const inspection = await VehicleInspection.findById(inspectionId);
  if (!inspection || inspection.type !== "check_in") {
    return { inspection: null, booking: null, pdfBuffer: null };
  }

  const booking = await Booking.findById(inspection.bookingId);
  if (!booking) {
    return { inspection, booking: null, pdfBuffer: null };
  }
  if (!inspection.signatureImageUrl) {
    throw new Error("Check-in signature image is missing");
  }

  const context = await loadAgreementPdfContext(
    inspection.bookingId,
    checkInDraftFromInspection(inspection),
    {},
    inspection.createdAt ?? inspection._creationTime,
    {
      mode: "check_in",
      paidAmountOverride: checkInPaymentSnapshot(inspection, booking),
      paymentCutoffAt: inspection.createdAt ?? inspection._creationTime,
    },
  );

  const signatureBuffer = await readStoredFile(inspection.signatureImageUrl);
  if (!signatureBuffer) {
    throw new Error("Failed to load signature image for check-in PDF");
  }

  const pdfBuffer = await generateSignedCheckInAgreementPdf(context, signatureBuffer);
  const pdfUpload = await uploadPdfToStorage(pdfBuffer, "check-in-documents");
  inspection.signedPdfUrl = pdfUpload.secure_url;
  if (inspection.paidAmountAtCheckIn == null) {
    inspection.paidAmountAtCheckIn = checkInPaymentSnapshot(inspection, booking);
  }
  await inspection.save();

  return { inspection, booking, pdfBuffer };
}

function queueCheckInDocuments({ bookingId, inspectionId, previousBillEntries, pendingInvoiceEntryIds }) {
  return enqueueEmailJob({
    type: EMAIL_JOB_TYPE.CHECKIN_AGREEMENT,
    bookingId,
    inspectionId,
    payload: { previousBillEntries, pendingInvoiceEntryIds },
  }).catch((err) => {
    console.error("Failed to enqueue check-in agreement email:", err?.message || err);
  });
}

function queueCheckOutDocuments({ bookingId, inspectionId, previousBillEntries, pendingInvoiceEntryIds }) {
  return enqueueEmailJob({
    type: EMAIL_JOB_TYPE.CHECKOUT_INVOICE,
    bookingId,
    inspectionId,
    payload: { previousBillEntries, pendingInvoiceEntryIds },
  }).catch((err) => {
    console.error("Failed to enqueue check-out invoice email:", err?.message || err);
  });
}

/** Build the check-out agreement from saved inspection + booking charges, never from a draft. */
export async function generateSavedCheckoutAgreementPdf(checkOutInspection) {
  const checkIn = await VehicleInspection.findOne({
    bookingId: checkOutInspection.bookingId,
    type: "check_in",
  });
  if (!checkIn) {
    throw new ApiError(404, "Check-in inspection not found");
  }
  if (!checkIn.signatureImageUrl) {
    throw new ApiError(400, "Check-in signature is required to generate the check-out PDF");
  }

  const signatureBuffer = await readStoredFile(checkIn.signatureImageUrl);
  if (!signatureBuffer) {
    throw new ApiError(500, "Failed to load check-in signature for the check-out PDF");
  }

  const context = await loadAgreementPdfContext(
    checkOutInspection.bookingId,
    checkInDraftFromInspection(checkIn),
    {
      mileage: checkOutInspection.mileage,
      fuelLevel: checkOutInspection.fuelLevel,
      notes: checkOutInspection.notes,
    },
    checkOutInspection.createdAt ?? checkOutInspection._creationTime ?? new Date(),
    {
      mode: "check_out",
      checkInAt: checkIn.createdAt ?? checkIn._creationTime,
      checkOutAt: checkOutInspection.createdAt ?? checkOutInspection._creationTime,
    },
  );
  return generateSignedCheckInAgreementPdf(context, signatureBuffer);
}

const getCheckInTermsPdf = asyncHandler(async (req, res) => {
  const mode = req.body?.mode === "check_out" ? "check_out" : "check_in";
  let checkInDraft = {
    mainDriver: req.body?.mainDriver,
    mileage: req.body?.mileage,
    fuelLevel: req.body?.fuelLevel,
    notes: req.body?.notes,
    extraDrivers: req.body?.extraDrivers,
    paymentAmount: req.body?.paymentAmount,
  };
  let checkOutDraft = {};
  let checkInAt;

  if (mode === "check_out") {
    const checkIn = await VehicleInspection.findOne({
      bookingId: req.params.bookingId,
      type: "check_in",
    });
    if (!checkIn) {
      throw new ApiError(400, "Check-in is required before generating the check-out PDF");
    }
    checkInDraft = checkInDraftFromInspection(checkIn);
    checkInAt = checkIn.createdAt ?? checkIn._creationTime;
    checkOutDraft = {
      mileage: req.body?.mileage,
      fuelLevel: req.body?.fuelLevel,
      notes: req.body?.notes,
      paymentAmount: req.body?.paymentAmount,
      chargeEntries: req.body?.chargeEntries,
    };
  }

  const context = await loadAgreementPdfContext(
    req.params.bookingId,
    checkInDraft,
    mode === "check_in" ? {} : checkOutDraft,
    undefined,
    { mode, checkInAt },
  );
  const pdfBuffer = await generateCheckInAgreementPdf(context);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${mode}-agreement-${req.params.bookingId}.pdf"`,
  );
  res.send(pdfBuffer);
});

const getSignedCheckInPdf = asyncHandler(async (req, res) => {
  const inspection = await VehicleInspection.findById(req.params.inspectionId);
  if (!inspection || (inspection.type !== "check_in" && inspection.type !== "check_out")) {
    throw new ApiError(404, "Signed agreement PDF not found");
  }

  const booking = await Booking.findById(inspection.bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  const staff = isStaff(req.user);
  if (!staff) {
    if (booking.userId.toString() !== req.user._id.toString()) {
      throw new ApiError(403, "Forbidden");
    }
    const visible =
      inspection.type === "check_in" ? booking.checkInVisibleToUser : booking.checkOutVisibleToUser;
    if (!visible) {
      throw new ApiError(403, "Forbidden");
    }
  }

  const filename = `${inspection.type}-${booking._id}.pdf`;

  if (inspection.signedPdfUrl) {
    const storedPdf = await fetchStoredPdf(inspection.signedPdfUrl);
    if (storedPdf) {
      return sendPdf(res, storedPdf, filename);
    }
  }

  if (inspection.type === "check_in") {
    if (!inspection.signatureImageUrl) {
      throw new ApiError(404, "Signature not found for this agreement");
    }
    const context = await loadAgreementPdfContext(
      inspection.bookingId,
      checkInDraftFromInspection(inspection),
      {},
      inspection.createdAt ?? inspection._creationTime,
      {
        mode: "check_in",
        paidAmountOverride: checkInPaymentSnapshot(inspection, booking),
        paymentCutoffAt: inspection.createdAt ?? inspection._creationTime,
      },
    );
    const signatureBuffer = await readStoredFile(inspection.signatureImageUrl);
    if (!signatureBuffer) {
      throw new ApiError(500, "Failed to load signature image");
    }
    if (inspection.paidAmountAtCheckIn == null) {
      inspection.paidAmountAtCheckIn = checkInPaymentSnapshot(inspection, booking);
      await inspection.save();
    }
    return sendPdf(
      res,
      await generateSignedCheckInAgreementPdf(context, signatureBuffer),
      filename,
    );
  }

  const pdfBuffer = await generateSavedCheckoutAgreementPdf(inspection);
  if (!inspection.signedPdfUrl) {
    const pdfUpload = await uploadPdfToStorage(pdfBuffer, "check-out-documents");
    inspection.signedPdfUrl = pdfUpload.secure_url;
    await inspection.save();
  }
  return sendPdf(res, pdfBuffer, filename);
});

const createInspection = asyncHandler(async (req, res) => {
  if (!isStaff(req.user)) {
    throw new ApiError(403, "Forbidden");
  }

  const {
    carId,
    bookingId,
    type,
    mileage,
    fuelLevel,
    notes,
    imageUrls,
    signatureDataUrl,
    paymentEntry,
    chargeEntries,
    extraDrivers,
    mainDriver,
  } = req.body;

  if (type !== "check_in" && type !== "check_out") {
    throw new ApiError(400, "Invalid inspection type");
  }

  if (type === "check_in" && !signatureDataUrl) {
    throw new ApiError(400, "Customer signature is required to complete check-in");
  }

  let signatureImageUrl;
  let paidAmountAtCheckIn;
  let normalizedExtraDrivers;
  let normalizedMainDriver;

  if (type === "check_in") {
    const mainDriverError = validateMainDriverCheckInDetails(mainDriver);
    if (mainDriverError) {
      throw new ApiError(400, mainDriverError);
    }
    normalizedMainDriver = normalizeMainDriverCheckInDetails(mainDriver);

    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError(404, "Booking not found");

    const expectedDriverCount = resolveBookingExtraDriverCount(booking);
    const driverValidationError = validateExtraDriverCheckInDetails(
      expectedDriverCount,
      extraDrivers,
    );
    if (driverValidationError) {
      throw new ApiError(400, driverValidationError);
    }
    if (expectedDriverCount > 0) {
      normalizedExtraDrivers = normalizeExtraDriverCheckInDetails(extraDrivers);
    }

    const issuedAt = new Date();
    paidAmountAtCheckIn = resolveCheckInPaidAmount({
      billEntries: booking.billEntries,
      pendingCheckInPaid: paymentEntry?.amount,
      paymentCutoffAt: issuedAt,
    });
    let signatureBuffer;
    try {
      signatureBuffer = parseSignatureDataUrl(signatureDataUrl);
    } catch {
      throw new ApiError(400, "Invalid signature image format");
    }
    const signatureUpload = await uploadToStorage(signatureBuffer, "check-in-signatures", {
      ext: ".png",
      mimetype: "image/png",
    });
    signatureImageUrl = signatureUpload.secure_url;
  }

  if (type === "check_out") {
    await VehicleInspection.deleteMany({
      bookingId,
      type: "check_out",
      $or: [{ signedPdfUrl: { $exists: false } }, { signedPdfUrl: null }, { signedPdfUrl: "" }],
    });

    const checkIn = await VehicleInspection.findOne({ bookingId, type: "check_in" });
    if (!checkIn) {
      throw new ApiError(400, "Check-in inspection is required before check-out");
    }
    if (Number(mileage) < checkIn.mileage) {
      throw new ApiError(400, "Check-out mileage cannot be less than check-in mileage");
    }
    if (!checkIn.signatureImageUrl) {
      throw new ApiError(400, "Check-in signature is required to generate the check-out PDF");
    }

    signatureImageUrl = checkIn.signatureImageUrl;
  }

  const storedImageUrls = Array.isArray(imageUrls)
    ? imageUrls.map((url) => String(url ?? "").trim()).filter(Boolean)
    : [];

  const inspection = await VehicleInspection.create({
    carId,
    bookingId,
    type,
    mileage,
    fuelLevel,
    notes,
    imageUrls: storedImageUrls,
    signatureImageUrl,
    ...(type === "check_in" && paidAmountAtCheckIn != null ? { paidAmountAtCheckIn } : {}),
    ...(type === "check_in" ? { securityDepositAmount: SECURITY_DEPOSIT_AMOUNT } : {}),
    conductedBy: req.user._id,
    ...performedByFields(req.user),
    ...(normalizedMainDriver ? { mainDriver: normalizedMainDriver } : {}),
    ...(normalizedExtraDrivers?.length ? { extraDrivers: normalizedExtraDrivers } : {}),
  });

  let mileageBilling = null;
  let invoicePreviousSnapshot = null;
  const pendingInvoiceEntryIds = [];

  if (type === "check_out") {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError(404, "Booking not found");

    const car = await Car.findById(carId);
    if (!car) throw new ApiError(404, "Car not found");

    const checkIn = await VehicleInspection.findOne({ bookingId, type: "check_in" });
    if (!checkIn) {
      throw new ApiError(400, "Check-in inspection is required before check-out");
    }

    if (Number(mileage) < checkIn.mileage) {
      throw new ApiError(400, "Check-out mileage cannot be less than check-in mileage");
    }

    const rentalDays = calculateRentalDays(
      booking.pickupDate,
      booking.pickupTime,
      booking.returnDate,
      booking.returnTime,
    );

    mileageBilling = calculateExtraMileageBilling({
      checkInMileage: checkIn.mileage,
      checkOutMileage: Number(mileage),
      dailyMileageLimit: resolveBookedDailyMileageLimit(booking, car),
      chargePerExtraKm: resolveBookedChargePerExtraKm(booking, car),
      rentalDays,
    });

    booking.checkInMileage = checkIn.mileage;
    booking.checkOutMileage = Number(mileage);
    booking.totalDrivenKm = mileageBilling.totalDrivenKm;
    booking.allowedMileageKm = mileageBilling.allowedMileageKm;
    booking.extraMileageKm = mileageBilling.extraMileageKm;
    booking.extraMileageCharge = mileageBilling.extraMileageCharge;

    invoicePreviousSnapshot = snapshotBillEntryState(booking.billEntries);
    await syncBookingBillEntries(booking, car);
    applyInspectionActorToBooking(booking, type, req.user);
    Object.assign(booking, staffUpdatedByFields(req.user));
    await booking.save();

    await Car.findByIdAndUpdate(carId, { mileage });
    mileageBilling = {
      ...mileageBilling,
      newTotalAmount: computeBillSummary(booking.billEntries).totalBill,
    };

  }

  const paymentAmount = Number(paymentEntry?.amount);
  const normalizedCharges =
    type === "check_out" && Array.isArray(chargeEntries)
      ? chargeEntries
          .map((entry) => ({
            title: String(entry?.title ?? "").trim(),
            description: String(entry?.description ?? "").trim() || undefined,
            amount: Number(entry?.amount),
          }))
          .filter((entry) => entry.title && Number.isFinite(entry.amount) && entry.amount > 0)
      : [];

  if (normalizedCharges.length > 0 || paymentAmount > 0) {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError(404, "Booking not found");

    if (invoicePreviousSnapshot == null) {
      invoicePreviousSnapshot = snapshotBillEntryState(booking.billEntries);
    }

    const addedChargeEntries = [];
    for (const charge of normalizedCharges) {
      appendBillEntry(booking, {
        title: charge.title,
        description: charge.description,
        amount: charge.amount,
        entryType: "charge",
        status: "unpaid",
        source: "manual",
        phase: type === "check_out" ? "check_out" : "check_in",
        ...createdByFields(req.user),
      });
      const chargeBillEntry = booking.billEntries[booking.billEntries.length - 1];
      addedChargeEntries.push(chargeBillEntry);
      pendingInvoiceEntryIds.push(billEntryId(chargeBillEntry));
    }

    if (paymentAmount > 0) {
      const defaultTitle = type === "check_in" ? "Check-In Payment" : "Check-Out Payment";
      appendBillEntry(booking, {
        title: paymentEntry?.title?.trim() || defaultTitle,
        description: paymentEntry?.description?.trim() || undefined,
        amount: paymentAmount,
        entryType: "payment",
        source: "manual",
        phase: type === "check_in" ? "check_in" : "check_out",
        paidVia: "e_transfer",
        ...createdByFields(req.user),
      });
      const paymentBillEntry = booking.billEntries[booking.billEntries.length - 1];
      pendingInvoiceEntryIds.push(billEntryId(paymentBillEntry));
    }

    const settled = computeBillSummary(booking.billEntries).totalUnpaid <= 0;
    if (settled && paymentAmount > 0) {
      for (const chargeBillEntry of addedChargeEntries) {
        chargeBillEntry.status = "paid";
        pendingInvoiceEntryIds.push(billEntryId(chargeBillEntry));
      }
    }

    if (type === "check_in") {
      applySecurityDepositOnCheckIn(booking);
    }

    applyInspectionActorToBooking(booking, type, req.user);
    Object.assign(booking, staffUpdatedByFields(req.user));
    await booking.save();
  }

  if (type === "check_in" || type === "check_out") {
    const snapshotBooking = await Booking.findById(bookingId);
    if (snapshotBooking) {
      if (type === "check_in") {
        applySecurityDepositOnCheckIn(snapshotBooking, inspection.createdAt ?? new Date());
      }
      const phase = type === "check_in" ? "check_in" : "check_out";
      capturePhaseBillSnapshot(snapshotBooking, phase);
      applyInspectionActorToBooking(snapshotBooking, type, req.user);
      Object.assign(snapshotBooking, staffUpdatedByFields(req.user));
      await snapshotBooking.save();
    }
  }

  if (type === "check_in") {
    queueCheckInDocuments({
      bookingId,
      inspectionId: inspection._id,
      previousBillEntries: invoicePreviousSnapshot,
      pendingInvoiceEntryIds,
    });
  }

  if (type === "check_out") {
    queueCheckOutDocuments({
      bookingId,
      inspectionId: inspection._id,
      previousBillEntries: invoicePreviousSnapshot,
      pendingInvoiceEntryIds,
    });
  }

  const [formatted] = await formatInspections([inspection]);
  return res.status(201).json(new ApiResponse(201, {
      ...formatted,
      mileageBilling: mileageBilling ?? undefined,
    },
    "Inspection created",
  ));
});

const listInspectionsByBooking = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  const staff = isStaff(req.user);
  if (!staff && booking.userId.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden");
  }

  const inspections = await VehicleInspection.find({ bookingId: req.params.bookingId });
  const visibleInspections = staff
    ? inspections
    : inspections.filter((insp) => {
        if (insp.type === "check_in") return booking.checkInVisibleToUser;
        if (insp.type === "check_out") return booking.checkOutVisibleToUser;
        return false;
      });

  return res.status(200).json(new ApiResponse(200, await formatInspections(visibleInspections), "Inspections fetched"));
});

const listInspectionsByCar = asyncHandler(async (req, res) => {
  if (!isStaff(req.user)) {
    throw new ApiError(403, "Forbidden");
  }

  const inspections = await VehicleInspection.find({ carId: req.params.carId });
  return res.status(200).json(new ApiResponse(200, await formatInspections(inspections), "Inspections fetched"));
});

const CHECKINOUT_CAR_FIELDS = "make model year category transmission dailyRate imageUrl imageUrls";
const CHECKINOUT_USER_FIELDS = "name email phone";
const CHECKINOUT_LOCATION_FIELDS = "name";
const CHECKINOUT_ADMIN_FIELDS = "name role";
const INSPECTION_BOOKING_FIELDS =
  "userId carId pickupLocationId dropoffLocationId pickupDate pickupTime returnDate returnTime status totalAmount";

function refId(ref) {
  if (!ref) return undefined;
  if (typeof ref === "string") return ref;
  return ref._id?.toString?.() ?? String(ref);
}

function populatedDoc(parent, path) {
  return parent.populated(path) ? formatDoc(parent.get(path)) : null;
}

function formatCheckInOutBooking(booking, checkIn, checkOut) {
  const doc = formatDoc(booking);
  return {
    ...doc,
    userId: refId(booking.userId),
    carId: refId(booking.carId),
    pickupLocationId: refId(booking.pickupLocationId),
    dropoffLocationId: refId(booking.dropoffLocationId),
    user: populatedDoc(booking, "userId"),
    car: booking.populated("carId") ? enrichCar(booking.get("carId")) : null,
    pickupLocation: populatedDoc(booking, "pickupLocationId"),
    dropoffLocation: populatedDoc(booking, "dropoffLocationId"),
    checkIn: checkIn ?? null,
    checkOut: checkOut ?? null,
    checkInPerformedBy: checkIn?.performedBy ?? null,
    checkOutPerformedBy: checkOut?.performedBy ?? null,
  };
}

const CHECKINOUT_BOOKING_POPULATE = [
  { path: "userId", select: CHECKINOUT_USER_FIELDS },
  { path: "carId", select: CHECKINOUT_CAR_FIELDS },
  { path: "pickupLocationId", select: CHECKINOUT_LOCATION_FIELDS },
  { path: "dropoffLocationId", select: CHECKINOUT_LOCATION_FIELDS },
];

const listCheckInOutBoard = asyncHandler(async (req, res) => {
  if (!isStaff(req.user)) {
    throw new ApiError(403, "Forbidden");
  }

  const [activeBookings, completedBookings] = await Promise.all([
    Booking.find({ status: { $in: ["confirmed", "checked_in"] } })
      .sort({ createdAt: -1 })
      .populate(CHECKINOUT_BOOKING_POPULATE),
    Booking.find({ status: "completed" })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate(CHECKINOUT_BOOKING_POPULATE),
  ]);
  const bookings = [...activeBookings, ...completedBookings];
  const bookingIds = bookings.map((booking) => booking._id);

  const inspections = await VehicleInspection.find({ bookingId: { $in: bookingIds } })
    .sort({ createdAt: -1 })
    .populate("conductedBy", CHECKINOUT_ADMIN_FIELDS)
    .populate("performedByUserId", CHECKINOUT_ADMIN_FIELDS);

  const formatted = await formatInspections(inspections);
  const latestByKey = new Map();
  for (const inspection of formatted) {
    const bookingId = refId(inspection.bookingId);
    if (!bookingId) continue;
    const key = `${bookingId}:${inspection.type}`;
    if (!latestByKey.has(key)) {
      latestByKey.set(key, inspection);
    }
  }

  const items = bookings.map((booking) => {
    const id = booking._id.toString();
    return formatCheckInOutBooking(
      booking,
      latestByKey.get(`${id}:check_in`),
      latestByKey.get(`${id}:check_out`),
    );
  });

  return res.status(200).json(new ApiResponse(200, items, "Check-in/out board fetched"));
});

const getInspectionById = asyncHandler(async (req, res) => {
  const inspection = await VehicleInspection.findById(req.params.id)
    .populate({ path: "carId", select: CHECKINOUT_CAR_FIELDS })
    .populate({
      path: "bookingId",
      select: INSPECTION_BOOKING_FIELDS,
      populate: CHECKINOUT_BOOKING_POPULATE,
    })
    .populate("conductedBy", CHECKINOUT_ADMIN_FIELDS)
    .populate("performedByUserId", CHECKINOUT_ADMIN_FIELDS);

  if (!inspection) {
    throw new ApiError(404, "Inspection not found");
  }

  const booking = inspection.populated("bookingId") ? inspection.get("bookingId") : null;
  const staff = isStaff(req.user);
  const bookingUserId = booking ? refId(booking.userId) : null;
  if (!staff && bookingUserId !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden");
  }

  const [formatted] = await formatInspections([inspection]);
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        ...formatted,
        bookingId: refId(inspection.bookingId),
        carId: refId(inspection.carId),
        conductedBy: refId(inspection.conductedBy),
        car: inspection.populated("carId") ? enrichCar(inspection.get("carId")) : null,
        user: booking ? populatedDoc(booking, "userId") : null,
        pickupLocation: booking ? populatedDoc(booking, "pickupLocationId") : null,
        dropoffLocation: booking ? populatedDoc(booking, "dropoffLocationId") : null,
        admin: populatedDoc(inspection, "conductedBy") ?? populatedDoc(inspection, "performedByUserId"),
        booking: booking ? formatCheckInOutBooking(booking, null, null) : null,
      },
      "Inspection fetched",
    ),
  );
});

const listAllInspections = asyncHandler(async (req, res) => {
  if (!isStaff(req.user)) {
    throw new ApiError(403, "Forbidden");
  }

  const result = await aggregatePaginate(
    VehicleInspection,
    [{ $sort: { createdAt: -1 } }],
    req,
    { defaultLimit: wantsPagination(req) ? 50 : 200 },
  );
  const items = await formatInspections(result.docs);
  if (wantsPagination(req)) {
    return res.status(200).json(new ApiResponse(200, paginatedPayload(items, result), "Inspections fetched"));
  }
  return res.status(200).json(new ApiResponse(200, items, "Inspections fetched"));
});

export {
  getCheckInTermsPdf,
  getSignedCheckInPdf,
  createInspection,
  listInspectionsByBooking,
  listInspectionsByCar,
  listCheckInOutBoard,
  getInspectionById,
  listAllInspections,
};
