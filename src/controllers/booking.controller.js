import { Booking } from "../models/booking.model.js";
import { Car } from "../models/car.model.js";
import { User } from "../models/user.model.js";
import { Location } from "../models/location.model.js";
import { AdditionalService } from "../models/additionalService.model.js";
import { VehicleInspection } from "../models/vehicleInspection.model.js";
import { isStaff } from "../middlewares/auth.middleware.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { aggregatePaginate, paginatedPayload, wantsPagination } from "../utils/paginate.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { enrichCar, sanitizeCarForPublic } from "../utils/enrichCar.js";
import { collectUnavailableCarIds } from "../utils/carAvailability.js";
import { rentalPeriodsConflictEitherWay } from "../utils/datesOverlap.js";
import { calculateRentalDays, isValidRentalPeriod } from "../utils/rentalPricing.js";
import { calculateServiceCharge } from "../utils/serviceCharge.js";
import { patchText } from "../utils/patchPayload.js";
import {
  getServiceQuantity,
  normalizeServiceQuantitiesInput,
  serviceAllowsQuantity,
} from "../utils/serviceQuantity.js";
import {
  findExtraDriverService,
  validateExtraDriverDetails,
} from "../utils/extraDriver.js";
import {
  buildCarPricingSnapshot,
  buildLiveServiceDetailList,
  buildServiceSnapshots,
  calculateTotalFromSnapshots,
  formatServiceSnapshotsForDetail,
  hasPricingSnapshot,
  resolveBookedDailyRate,
} from "../utils/bookingSnapshot.js";
import {
  checkInPerformedByFields,
  checkOutPerformedByFields,
  createdByFields,
  resolveBookingActor,
  staffUpdatedByFields,
} from "../utils/bookingAudit.js";
import {
  computeBillSummary,
  formatBillEntries,
  formatBillEntriesWithActors,
  appendBillEntry,
  syncBookingBillEntries,
  getBillEntryTotals,
} from "../utils/billing.js";
import {
  applySecurityDepositOnCheckIn,
  assertDepositPaymentAllowed,
  computeDepositTotals,
  formatSecurityDeposit,
  normalizePaidVia,
  persistSecurityDepositStatus,
  refundSecurityDeposit,
} from "../utils/securityDeposit.js";
import { sendBillingChargeEmail } from "../utils/billingChargeEmail.js";
import { uploadBillAttachment } from "./upload.controller.js";
import { isStoredImageUrl, readStoredFile } from "../utils/localFileStore.js";
import {
  assignInvoiceNumber,
  attachInvoiceToBillEntry,
  attachInvoicesForChangedEntries,
  snapshotBillEntryState,
  buildFullInvoiceNumber,
  canHaveInvoice,
  generateEntryInvoicePdf,
  generateFullInvoicePdf,
} from "../utils/billInvoicePdf.js";
import { sendBookingConfirmationEmail } from "../utils/bookingConfirmationEmail.js";
import { runInBackground } from "../utils/backgroundJob.js";
import {
  applyUserCancellationBilling,
  buildCancellationPreview,
  resolveCancellationPolicy,
} from "../utils/cancellation.js";
import {
  inspectionsForBooking,
  latestInspectionsByBookingIds,
  visibleInspectionsForViewer,
} from "../utils/formatInspection.js";

function queueBookingConfirmationDocuments(bookingId, { sendEmail = true } = {}) {
  runInBackground("Booking confirmation documents", async () => {
    const fresh = await Booking.findById(bookingId);
    if (!fresh) return;
    await attachInvoicesForChangedEntries(fresh, []);
    await fresh.save();
    if (!sendEmail) {
      console.info("Booking confirmation email skipped: admin-created booking", {
        bookingId: String(bookingId),
      });
      return;
    }
    await sendBookingConfirmationEmail(fresh);
  });
}

function isActiveBooking(status) {
  return status !== "cancelled" && status !== "completed";
}

async function findConflictingBooking(
  carId,
  pickupDate,
  pickupTime,
  returnDate,
  returnTime,
  excludeBookingId = null,
) {
  const query = { carId };
  if (excludeBookingId) {
    query._id = { $ne: excludeBookingId };
  }

  const existingBookings = await Booking.find(query);
  return existingBookings.find(
    (b) =>
      isActiveBooking(b.status) &&
      rentalPeriodsConflictEitherWay(
        b.pickupDate,
        b.pickupTime,
        b.returnDate,
        b.returnTime,
        pickupDate,
        pickupTime ?? "00:00",
        returnDate,
        returnTime ?? "23:59",
      ),
  );
}

const USER_AVAILABILITY_ERROR = "Car is not available for the selected dates and times.";
const ADMIN_AVAILABILITY_ERROR =
  "Car is not available for the selected dates and times. A 4-hour buffer is required between bookings.";

async function calculateAndSnapshotTotal(
  car,
  pickupDate,
  pickupTime,
  returnDate,
  returnTime,
  additionalServiceIds = [],
  serviceQuantities = [],
  legacyExtraDriverCount,
  extraMileageCharge = 0,
) {
  const carPricing = buildCarPricingSnapshot(car);
  const serviceSnapshots = await buildServiceSnapshots(
    additionalServiceIds,
    serviceQuantities,
    legacyExtraDriverCount,
  );

  const pricing = calculateTotalFromSnapshots({
    bookedDailyRate: carPricing.bookedDailyRate,
    serviceSnapshots,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    extraMileageCharge,
  });

  return {
    ...pricing,
    ...carPricing,
    serviceSnapshots,
  };
}

async function resolveStoredServiceQuantities(additionalServiceIds = [], serviceQuantitiesInput = []) {
  const normalized = normalizeServiceQuantitiesInput(additionalServiceIds, serviceQuantitiesInput);
  const quantityById = Object.fromEntries(
    normalized.map((entry) => [entry.serviceId, entry.quantity]),
  );

  /** @type {Array<{ serviceId: string; quantity: number }>} */
  const stored = [];

  for (const svcId of additionalServiceIds) {
    const svc = await AdditionalService.findById(svcId);
    if (!svc) continue;

    const quantity = quantityById[String(svcId)] ?? 1;
    if (quantity > 1 && !serviceAllowsQuantity(svc)) {
      throw new ApiError(400, `${svc.name} does not support quantity`);
    }

    stored.push({ serviceId: String(svcId), quantity });
  }

  return stored;
}

const getUnavailableCarIds = asyncHandler(async (req, res) => {
  const { pickupDate, returnDate, pickupTime, returnTime } = req.query;
  if (!pickupDate || !returnDate) {
    return res.status(200).json(new ApiResponse(200, [], "Unavailable cars fetched"));
  }

  const unavailable = await collectUnavailableCarIds({
    pickupDate,
    returnDate,
    pickupTime: pickupTime ?? "00:00",
    returnTime: returnTime ?? "23:59",
  });

  return res.status(200).json(new ApiResponse(200, Array.from(unavailable), "Unavailable cars fetched"));
});

const LIST_LOCATION_FIELDS = "name";
const LIST_CUSTOMER_FIELDS = "name email";
const LIST_CAR_CORE_FIELDS = "make model year licensePlate";
const LIST_CAR_IMAGE_FIELDS = "make model year licensePlate category imageUrl imageUrls";

const MY_BOOKING_POPULATE = [
  { path: "carId", select: LIST_CAR_IMAGE_FIELDS },
  { path: "pickupLocationId", select: LIST_LOCATION_FIELDS },
  { path: "dropoffLocationId", select: LIST_LOCATION_FIELDS },
];

const ADMIN_LIST_POPULATE = [
  { path: "userId", select: LIST_CUSTOMER_FIELDS },
  { path: "carId", select: LIST_CAR_CORE_FIELDS },
  { path: "pickupLocationId", select: LIST_LOCATION_FIELDS },
  { path: "dropoffLocationId", select: LIST_LOCATION_FIELDS },
];

const CAR_CALENDAR_BOOKING_POPULATE = [
  { path: "userId", select: LIST_CUSTOMER_FIELDS },
  { path: "pickupLocationId", select: LIST_LOCATION_FIELDS },
  { path: "dropoffLocationId", select: LIST_LOCATION_FIELDS },
];

const OVERVIEW_BOOKING_POPULATE = [
  { path: "carId", select: LIST_CAR_CORE_FIELDS },
];

const CAR_CALENDAR_FIELDS = "make model year licensePlate color category dailyRate imageUrl imageUrls isAvailable";

function populatedSnapshot(booking, path) {
  return booking.populated(path) ? formatDoc(booking.get(path)) : null;
}

function formatListBooking(booking) {
  const doc = formatBookingWithIds(booking);
  const car = booking.populated("carId") ? enrichCar(booking.get("carId")) : null;
  return {
    ...doc,
    user: populatedSnapshot(booking, "userId"),
    car,
    pickupLocation: populatedSnapshot(booking, "pickupLocationId"),
    dropoffLocation: populatedSnapshot(booking, "dropoffLocationId"),
  };
}

const getMyBookings = asyncHandler(async (req, res) => {
  const result = await aggregatePaginate(
    Booking,
    [{ $match: { userId: req.user._id } }, { $sort: { createdAt: -1 } }],
    req,
    { defaultLimit: wantsPagination(req) ? 50 : 200 },
  );
  const bookings = await Booking.populate(
    result.docs.map((doc) => Booking.hydrate(doc)),
    MY_BOOKING_POPULATE,
  );
  const latestByKey = await latestInspectionsByBookingIds(bookings.map((booking) => booking._id));
  const items = bookings.map((booking) => {
    const attached = visibleInspectionsForViewer(
      booking,
      inspectionsForBooking(latestByKey, String(booking._id)),
      false,
    );
    return {
      ...formatListBooking(booking),
      ...attached,
    };
  });
  if (wantsPagination(req)) {
    return res.status(200).json(new ApiResponse(200, paginatedPayload(items, result), "Bookings fetched"));
  }
  return res.status(200).json(new ApiResponse(200, items, "Bookings fetched"));
});

const getAdminBookings = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const match = status ? { status } : {};
  const result = await aggregatePaginate(
    Booking,
    [{ $match: match }, { $sort: { createdAt: -1 } }],
    req,
    { defaultLimit: wantsPagination(req) ? 50 : 200 },
  );
  const bookings = await Booking.populate(
    result.docs.map((doc) => Booking.hydrate(doc)),
    ADMIN_LIST_POPULATE,
  );
  const items = bookings.map((booking) => {
    const billSummary = computeBillSummary(booking.billEntries);
    return {
      ...formatListBooking(booking),
      balanceDue: billSummary.totalUnpaid,
    };
  });
  if (wantsPagination(req)) {
    return res.status(200).json(new ApiResponse(200, paginatedPayload(items, result), "Bookings fetched"));
  }
  return res.status(200).json(new ApiResponse(200, items, "Bookings fetched"));
});

const getAdminBookingsByCar = asyncHandler(async (req, res) => {
  const car = await Car.findById(req.params.carId).select(CAR_CALENDAR_FIELDS);
  if (!car) {
    throw new ApiError(404, "Car not found");
  }

  const bookings = await Booking.find({ carId: req.params.carId })
    .sort({ pickupDate: 1 })
    .populate(CAR_CALENDAR_BOOKING_POPULATE);

  return res.status(200).json(new ApiResponse(200, {
    car: enrichCar(car),
    bookings: bookings.map((booking) => {
      const item = formatListBooking(booking);
      return {
        ...item,
        customerName: item.user?.name ?? item.user?.email ?? "Unknown customer",
        customerEmail: item.user?.email ?? null,
      };
    }),
  }, "Car bookings fetched"));
});

const getAdminOverview = asyncHandler(async (req, res) => {
  const [
    totalCars,
    availableCars,
    totalBookings,
    pendingBookings,
    checkedInBookings,
    customers,
    locations,
    revenueAgg,
    recentBookings,
  ] = await Promise.all([
    Car.countDocuments(),
    Car.countDocuments({ isAvailable: true }),
    Booking.countDocuments(),
    Booking.countDocuments({ status: "pending" }),
    Booking.countDocuments({ status: "checked_in" }),
    User.countDocuments({ role: "customer" }),
    Location.countDocuments(),
    Booking.aggregate([
      { $match: { status: { $ne: "cancelled" } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Booking.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("pickupDate totalAmount status carId")
      .populate(OVERVIEW_BOOKING_POPULATE),
  ]);

  return res.status(200).json(new ApiResponse(200, {
    stats: {
      totalCars,
      availableCars,
      totalBookings,
      pendingBookings,
      checkedInBookings,
      revenue: revenueAgg[0]?.total ?? 0,
      customers,
      locations,
    },
    recentBookings: recentBookings.map((booking) => {
      const car = booking.populated("carId") ? formatDoc(booking.get("carId")) : null;
      return {
        _id: booking._id.toString(),
        pickupDate: booking.pickupDate,
        totalAmount: booking.totalAmount,
        status: booking.status,
        car: car
          ? {
              _id: car._id,
              make: car.make,
              model: car.model,
              year: car.year,
              licensePlate: car.licensePlate,
            }
          : null,
      };
    }),
  }, "Overview fetched"));
});

const LOCATION_DETAIL_FIELDS = "name";
const CUSTOMER_DETAIL_FIELDS = "name email phone";
const DETAIL_CAR_FIELDS =
  "make model year licensePlate color category transmission fuelType seats dailyRate imageUrl imageUrls dailyMileageLimit chargePerExtraKm";

function refId(ref) {
  if (!ref) return undefined;
  if (typeof ref === "string") return ref;
  return ref._id?.toString?.() ?? String(ref);
}

function formatBookingWithIds(booking) {
  const doc = formatDoc(booking);
  doc.userId = refId(booking.userId);
  doc.carId = refId(booking.carId);
  doc.pickupLocationId = refId(booking.pickupLocationId);
  doc.dropoffLocationId = refId(booking.dropoffLocationId);
  return doc;
}

const getBookingDetail = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  const isAdmin = isStaff(req.user);
  if (!isAdmin && booking.userId.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden");
  }

  const car = await Car.findById(booking.carId);

  const days = calculateRentalDays(
    booking.pickupDate,
    booking.pickupTime,
    booking.returnDate,
    booking.returnTime,
  );

  let servicesWithQuantity;
  let baseAmount;
  let servicesAmount;

  if (hasPricingSnapshot(booking)) {
    servicesWithQuantity = formatServiceSnapshotsForDetail(booking.serviceSnapshots);
    baseAmount = (booking.bookedDailyRate ?? 0) * days;
    servicesAmount = servicesWithQuantity.reduce(
      (sum, s) => sum + calculateServiceCharge(s, days, s.quantity ?? 1),
      0,
    );
  } else {
    servicesWithQuantity = await buildLiveServiceDetailList(booking);
    baseAmount = car ? resolveBookedDailyRate(booking, car) * days : 0;
    servicesAmount = servicesWithQuantity.reduce(
      (sum, s) => sum + calculateServiceCharge(s, days, s.quantity ?? 1),
      0,
    );
  }

  const extraMileageCharge = booking.extraMileageCharge ?? 0;

  if (booking.status !== "cancelled") {
    await syncBookingBillEntries(booking, car);
    if (booking.isModified()) {
      await booking.save();
    }
  }

  const billEntries = await formatBillEntriesWithActors(booking.billEntries, booking, User);
  const billSummary = computeBillSummary(booking.billEntries);
  const securityDeposit = formatSecurityDeposit(booking, await securityDepositExtras(booking));

  const createdByUserId = booking.createdByUserId ?? booking.userId;
  const createdByRole = booking.createdByRole ?? "customer";
  const latestByKey = await latestInspectionsByBookingIds([booking._id]);
  const attached = inspectionsForBooking(latestByKey, String(booking._id));
  const visibleInspections = visibleInspectionsForViewer(booking, attached, isAdmin);
  const [, createdBy, updatedBy, checkInPerformedBy, checkOutPerformedBy] = await Promise.all([
    booking.populate([
      { path: "carId", select: DETAIL_CAR_FIELDS },
      { path: "pickupLocationId", select: LOCATION_DETAIL_FIELDS },
      { path: "dropoffLocationId", select: LOCATION_DETAIL_FIELDS },
      { path: "userId", select: CUSTOMER_DETAIL_FIELDS },
    ]),
    resolveBookingActor(User, createdByUserId, createdByRole, booking.createdByName),
    booking.updatedByUserId && booking.updatedByRole
      ? resolveBookingActor(User, booking.updatedByUserId, booking.updatedByRole, booking.updatedByName)
      : null,
    resolveBookingActor(
      User,
      booking.checkInPerformedByUserId ??
        attached.checkIn?.performedByUserId ??
        attached.checkIn?.conductedBy,
      booking.checkInPerformedByRole ?? attached.checkIn?.performedByRole,
      booking.checkInPerformedByName ?? attached.checkIn?.performedByName,
    ),
    resolveBookingActor(
      User,
      booking.checkOutPerformedByUserId ??
        attached.checkOut?.performedByUserId ??
        attached.checkOut?.conductedBy,
      booking.checkOutPerformedByRole ?? attached.checkOut?.performedByRole,
      booking.checkOutPerformedByName ?? attached.checkOut?.performedByName,
    ),
  ]);

  const detailCar = booking.populated("carId") ? enrichCar(booking.get("carId")) : null;

  return res.status(200).json(new ApiResponse(200, {
      booking: {
        ...formatBookingWithIds(booking),
        ...visibleInspections,
      },
      car: detailCar ? (isAdmin ? detailCar : sanitizeCarForPublic(detailCar)) : null,
      pickupLocation: booking.populated("pickupLocationId")
        ? formatDoc(booking.pickupLocationId)
        : null,
      dropoffLocation: booking.populated("dropoffLocationId")
        ? formatDoc(booking.dropoffLocationId)
        : null,
      user: booking.populated("userId") ? formatDoc(booking.userId) : null,
      services: servicesWithQuantity,
      days,
      baseAmount,
      servicesAmount,
      extraMileageCharge,
      totalDrivenKm: booking.totalDrivenKm ?? null,
      allowedMileageKm: booking.allowedMileageKm ?? null,
      extraMileageKm: booking.extraMileageKm ?? null,
      createdBy,
      updatedBy,
      checkInPerformedBy,
      checkOutPerformedBy,
      billEntries,
      billSummary,
      securityDeposit,
      inspections: visibleInspections.inspections,
      checkIn: visibleInspections.checkIn,
      checkOut: visibleInspections.checkOut,
    },
    "Booking detail fetched",
  ));
});

const getBookingById = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }
  return res.status(200).json(new ApiResponse(200, formatDoc(booking), "Booking fetched"));
});

const createBooking = asyncHandler(async (req, res) => {
  const {
    carId,
    pickupLocationId,
    dropoffLocationId,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    additionalServiceIds,
    licenseUrl,
    notes,
    extraDriverCount,
    extraDriverNames,
    serviceQuantities,
  } = req.body;

  const car = await Car.findById(carId);
  if (!car) throw new ApiError(404, "Car not found");

  const storedQuantities = await resolveStoredServiceQuantities(
    additionalServiceIds ?? [],
    serviceQuantities ?? [],
  );

  const extraDriverService = await findExtraDriverService(
    AdditionalService,
    additionalServiceIds ?? [],
  );
  const hasExtraDriver = Boolean(extraDriverService);
  const driverCount = hasExtraDriver
    ? getServiceQuantity(
        storedQuantities,
        String(extraDriverService._id),
        Number(extraDriverCount) || 1,
      )
    : undefined;

  if (hasExtraDriver) {
    const validationError = validateExtraDriverDetails(driverCount, extraDriverNames);
    if (validationError) throw new ApiError(400, validationError);
  }

  const conflicting = await findConflictingBooking(
    carId,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
  );

  if (conflicting) {
    throw new ApiError(400, USER_AVAILABILITY_ERROR);
  }

  if (!isValidRentalPeriod(pickupDate, pickupTime, returnDate, returnTime)) {
    throw new ApiError(400, "Return must be after pickup");
  }

  const { total: totalAmount, ...pricingSnapshot } = await calculateAndSnapshotTotal(
    car,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    additionalServiceIds ?? [],
    storedQuantities,
    driverCount,
  );

  const booking = await Booking.create({
    userId: req.user._id,
    carId,
    pickupLocationId,
    dropoffLocationId,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    status: "confirmed",
    totalAmount,
    bookedDailyRate: pricingSnapshot.bookedDailyRate,
    bookedDailyMileageLimit: pricingSnapshot.bookedDailyMileageLimit,
    bookedChargePerExtraKm: pricingSnapshot.bookedChargePerExtraKm,
    serviceSnapshots: pricingSnapshot.serviceSnapshots,
    additionalServiceIds,
    serviceQuantities: storedQuantities,
    extraDriverCount: hasExtraDriver ? driverCount : undefined,
    extraDriverNames: hasExtraDriver
      ? extraDriverNames.map((name) => name.trim())
      : undefined,
    licenseUrl,
    notes,
    paymentStatus: "pending",
    ...createdByFields(req.user),
  });

  await syncBookingBillEntries(booking, car);
  await booking.save();

  queueBookingConfirmationDocuments(booking._id);

  return res.status(201).json(new ApiResponse(201, formatDoc(booking), "Booking created"));
});

const adminCreateBooking = asyncHandler(async (req, res) => {
  const {
    userId,
    carId,
    pickupLocationId,
    dropoffLocationId,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    additionalServiceIds,
    serviceQuantities,
    extraDriverCount,
    extraDriverNames,
    notes,
  } = req.body;

  const car = await Car.findById(carId);
  if (!car) throw new ApiError(404, "Car not found");

  const storedQuantities = await resolveStoredServiceQuantities(
    additionalServiceIds ?? [],
    serviceQuantities ?? [],
  );

  const extraDriverService = await findExtraDriverService(
    AdditionalService,
    additionalServiceIds ?? [],
  );
  const hasExtraDriver = Boolean(extraDriverService);
  const driverCount = hasExtraDriver
    ? getServiceQuantity(
        storedQuantities,
        String(extraDriverService._id),
        Number(extraDriverCount) || 1,
      )
    : undefined;

  if (hasExtraDriver) {
    const validationError = validateExtraDriverDetails(driverCount, extraDriverNames);
    if (validationError) throw new ApiError(400, validationError);
  }

  const conflicting = await findConflictingBooking(
    carId,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
  );
  if (conflicting) {
    throw new ApiError(400, ADMIN_AVAILABILITY_ERROR);
  }

  if (!isValidRentalPeriod(pickupDate, pickupTime, returnDate, returnTime)) {
    throw new ApiError(400, "Return must be after pickup");
  }

  const { total: totalAmount, ...pricingSnapshot } = await calculateAndSnapshotTotal(
    car,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    additionalServiceIds ?? [],
    storedQuantities,
    driverCount,
  );

  const booking = await Booking.create({
    userId,
    carId,
    pickupLocationId,
    dropoffLocationId,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    status: "confirmed",
    totalAmount,
    bookedDailyRate: pricingSnapshot.bookedDailyRate,
    bookedDailyMileageLimit: pricingSnapshot.bookedDailyMileageLimit,
    bookedChargePerExtraKm: pricingSnapshot.bookedChargePerExtraKm,
    serviceSnapshots: pricingSnapshot.serviceSnapshots,
    additionalServiceIds,
    serviceQuantities: storedQuantities,
    extraDriverCount: hasExtraDriver ? driverCount : undefined,
    extraDriverNames: hasExtraDriver
      ? extraDriverNames.map((name) => name.trim())
      : undefined,
    notes,
    paymentStatus: "pending",
    ...createdByFields(req.user),
  });

  await syncBookingBillEntries(booking, car);
  await booking.save();

  queueBookingConfirmationDocuments(booking._id, { sendEmail: false });

  return res.status(201).json(new ApiResponse(201, formatDoc(booking), "Booking created"));
});

const adminUpdateBooking = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  const {
    carId,
    pickupLocationId,
    dropoffLocationId,
    pickupDate,
    pickupTime,
    returnDate,
    returnTime,
    additionalServiceIds,
    serviceQuantities,
    extraDriverCount,
    extraDriverNames,
    notes,
    paymentStatus,
    status,
  } = req.body;

  const nextCarId = carId ?? booking.carId.toString();
  const car = await Car.findById(nextCarId);
  if (!car) throw new ApiError(404, "Car not found");

  const nextPickupDate = pickupDate ?? booking.pickupDate;
  const nextPickupTime = pickupTime ?? booking.pickupTime ?? "10:00";
  const nextReturnDate = returnDate ?? booking.returnDate;
  const nextReturnTime = returnTime ?? booking.returnTime ?? "10:00";
  const nextServiceIds =
    additionalServiceIds !== undefined
      ? additionalServiceIds
      : (booking.additionalServiceIds ?? []).map((id) => id.toString());

  const servicesTouched =
    additionalServiceIds !== undefined ||
    serviceQuantities !== undefined ||
    extraDriverNames !== undefined ||
    extraDriverCount !== undefined;

  let nextStoredQuantities = booking.serviceQuantities ?? [];
  let nextDriverCount = booking.extraDriverCount;
  let nextExtraDriverNames = booking.extraDriverNames;

  if (servicesTouched) {
    nextStoredQuantities = await resolveStoredServiceQuantities(
      nextServiceIds,
      serviceQuantities !== undefined ? serviceQuantities : (booking.serviceQuantities ?? []),
    );

    const extraDriverService = await findExtraDriverService(AdditionalService, nextServiceIds);
    const hasExtraDriver = Boolean(extraDriverService);

    if (hasExtraDriver) {
      nextDriverCount = getServiceQuantity(
        nextStoredQuantities,
        String(extraDriverService._id),
        Number(extraDriverCount) || booking.extraDriverCount || 1,
      );
      const names = extraDriverNames !== undefined ? extraDriverNames : (booking.extraDriverNames ?? []);
      const validationError = validateExtraDriverDetails(nextDriverCount, names);
      if (validationError) throw new ApiError(400, validationError);
      nextExtraDriverNames = names.map((name) => name.trim());
    } else {
      nextDriverCount = undefined;
      nextExtraDriverNames = undefined;
    }
  }

  if (!isValidRentalPeriod(nextPickupDate, nextPickupTime, nextReturnDate, nextReturnTime)) {
    throw new ApiError(400, "Return must be after pickup");
  }

  const conflicting = await findConflictingBooking(
    nextCarId,
    nextPickupDate,
    nextPickupTime,
    nextReturnDate,
    nextReturnTime,
    booking._id,
  );
  if (conflicting) {
    throw new ApiError(400, ADMIN_AVAILABILITY_ERROR);
  }

  const carChanged = Boolean(carId && carId !== booking.carId.toString());
  const shouldRefreshSnapshots =
    carChanged || servicesTouched || !hasPricingSnapshot(booking);

  let bookedDailyRate = booking.bookedDailyRate;
  let bookedDailyMileageLimit = booking.bookedDailyMileageLimit;
  let bookedChargePerExtraKm = booking.bookedChargePerExtraKm;
  let serviceSnapshots = booking.serviceSnapshots ?? [];

  if (shouldRefreshSnapshots) {
    const carPricing = buildCarPricingSnapshot(car);
    bookedDailyRate = carPricing.bookedDailyRate;
    bookedDailyMileageLimit = carPricing.bookedDailyMileageLimit;
    bookedChargePerExtraKm = carPricing.bookedChargePerExtraKm;
    serviceSnapshots = await buildServiceSnapshots(
      nextServiceIds,
      nextStoredQuantities,
      nextDriverCount,
    );
  }

  if (carId) booking.carId = carId;
  if (pickupLocationId) booking.pickupLocationId = pickupLocationId;
  if (dropoffLocationId) booking.dropoffLocationId = dropoffLocationId;
  if (pickupDate) booking.pickupDate = pickupDate;
  if (pickupTime !== undefined) booking.pickupTime = pickupTime;
  if (returnDate) booking.returnDate = returnDate;
  if (returnTime !== undefined) booking.returnTime = returnTime;
  if (additionalServiceIds !== undefined) booking.additionalServiceIds = additionalServiceIds;
  if (servicesTouched) {
    booking.serviceQuantities = nextStoredQuantities;
    booking.extraDriverCount = nextDriverCount;
    booking.extraDriverNames = nextExtraDriverNames;
  }
  booking.bookedDailyRate = bookedDailyRate;
  booking.bookedDailyMileageLimit = bookedDailyMileageLimit;
  booking.bookedChargePerExtraKm = bookedChargePerExtraKm;
  booking.serviceSnapshots = serviceSnapshots;
  if (notes !== undefined) booking.notes = patchText(notes);

  if (status) {
    if (status === "checked_in" || status === "checked_out") {
      throw new ApiError(400, "Use the check-in/out flow for this status");
    }
    booking.status = status;
  }

  const previousBillEntries = snapshotBillEntryState(booking.billEntries);
  await syncBookingBillEntries(booking, car);
  await attachInvoicesForChangedEntries(booking, previousBillEntries);
  if (paymentStatus === "refunded") {
    booking.paymentStatus = "refunded";
  }
  Object.assign(booking, staffUpdatedByFields(req.user));
  await booking.save();

  return res.status(200).json(new ApiResponse(200, formatDoc(booking), "Booking updated"));
});

const updateBookingStatus = asyncHandler(async (req, res) => {
  const { status, cancellationReason } = req.body;
  const staff = isStaff(req.user);

  if ((status === "checked_in" || status === "checked_out") && !staff) {
    throw new ApiError(403, "Forbidden");
  }

  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  booking.status = status === "checked_out" ? "completed" : status;
  if (cancellationReason) booking.cancellationReason = cancellationReason;
  if (status === "checked_in") {
    applySecurityDepositOnCheckIn(booking);
    Object.assign(booking, checkInPerformedByFields(req.user));
  }
  if (status === "checked_out") {
    Object.assign(booking, checkOutPerformedByFields(req.user));
  }
  Object.assign(booking, staffUpdatedByFields(req.user));
  await booking.save();
  return res.status(200).json(new ApiResponse(200, formatDoc(booking), "Booking updated"));
});

const updateCheckInOutVisibility = asyncHandler(async (req, res) => {
  const { checkInVisibleToUser, checkOutVisibleToUser } = req.body;
  const patch = {};

  if (typeof checkInVisibleToUser === "boolean") {
    patch.checkInVisibleToUser = checkInVisibleToUser;
  }
  if (typeof checkOutVisibleToUser === "boolean") {
    patch.checkOutVisibleToUser = checkOutVisibleToUser;
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "No visibility fields provided");
  }

  const booking = await Booking.findByIdAndUpdate(
    req.params.id,
    { ...patch, ...staffUpdatedByFields(req.user) },
    { new: true },
  );
  if (!booking) throw new ApiError(404, "Booking not found");
  return res.status(200).json(new ApiResponse(200, formatDoc(booking), "Booking updated"));
});

const getCancellationPreview = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  const isOwner = booking.userId.toString() === req.user._id.toString();
  if (!isStaff(req.user) && !isOwner) {
    throw new ApiError(403, "Forbidden");
  }

  if (booking.status === "cancelled") {
    throw new ApiError(400, "Booking is already cancelled");
  }

  const car = await Car.findById(booking.carId);
  return res.status(200).json(new ApiResponse(200, buildCancellationPreview(booking, car), "Cancellation preview fetched"));
});

const cancelBooking = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  const isAdmin = isStaff(req.user);
  const isOwner = booking.userId.toString() === req.user._id.toString();

  if (!isAdmin && !isOwner) {
    throw new ApiError(403, "Forbidden");
  }

  if (booking.status === "cancelled") {
    throw new ApiError(400, "Booking is already cancelled");
  }

  if (!isAdmin) {
    if (booking.status !== "pending" && booking.status !== "confirmed") {
      throw new ApiError(400, "This booking can no longer be cancelled");
    }

    const policy = resolveCancellationPolicy(booking);
    if (policy.type === "past_pickup") {
      throw new ApiError(400, "Cancellation is not available after pick-up time");
    }
  }

  if (isAdmin && !reason) {
    throw new ApiError(400, "Admin must provide a cancellation reason");
  }

  let cancellationSummary;
  const car = await Car.findById(booking.carId);

  const shouldApplyCancellationBilling =
    booking.status !== "checked_in" &&
    booking.status !== "checked_out" &&
    booking.status !== "completed";

  if (shouldApplyCancellationBilling) {
    const previousBillEntries = snapshotBillEntryState(booking.billEntries);
    cancellationSummary = applyUserCancellationBilling(booking, car);
    booking.cancellationPolicy = cancellationSummary.policy;
    booking.cancellationRefundAmount = cancellationSummary.refundAmount || undefined;
    await attachInvoicesForChangedEntries(booking, previousBillEntries);
  }

  booking.status = "cancelled";
  booking.cancellationReason = isAdmin ? reason : undefined;
  booking.cancelledBy = isAdmin ? "admin" : "user";
  if (isAdmin) {
    Object.assign(booking, staffUpdatedByFields(req.user));
  }
  await booking.save();

  return res.status(200).json(new ApiResponse(200, {
      ...formatDoc(booking),
      cancellationSummary,
      billEntries: formatBillEntries(booking.billEntries, booking),
      billSummary: computeBillSummary(booking.billEntries),
    },
    "Booking cancelled",
  ));
});

async function securityDepositExtras(booking) {
  if (booking.checkOutBillSnapshot?.capturedAt) {
    return { checkOutAt: booking.checkOutBillSnapshot.capturedAt };
  }
  if (booking.checkOutMileage == null && booking.status !== "completed" && booking.status !== "checked_out") {
    return {};
  }
  const checkOut = await VehicleInspection.findOne({
    bookingId: booking._id,
    type: "check_out",
  }).select("createdAt");
  return checkOut?.createdAt ? { checkOutAt: checkOut.createdAt } : {};
}

async function billEntryResponse(booking) {
  return {
    booking: formatDoc(booking),
    billEntries: await formatBillEntriesWithActors(booking.billEntries, booking, User),
    billSummary: computeBillSummary(booking.billEntries),
    securityDeposit: formatSecurityDeposit(booking, await securityDepositExtras(booking)),
  };
}


function sanitizeAttachmentName(name) {
  const raw = String(name || "attachment").trim() || "attachment";
  return raw.replace(/[^\w.\- ()]/g, "_").slice(0, 120);
}

const addBillEntry = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  const { title, description, amount, entryType, status, paid, paidVia } = req.body;
  if (!title?.trim() || amount == null || Number(amount) < 0) {
    throw new ApiError(400, "Title and a valid amount are required");
  }
  if (entryType !== "charge" && entryType !== "payment") {
    throw new ApiError(400, "entryType must be charge or payment");
  }

  const allowedStatuses = ["unpaid", "paid", "refund"];
  let entryStatus = status;
  if (entryStatus == null && paid !== undefined) {
    entryStatus = paid ? "paid" : "unpaid";
  }
  if (entryStatus != null && !allowedStatuses.includes(entryStatus)) {
    throw new ApiError(400, "status must be unpaid, paid, or refund");
  }

  let resolvedStatus =
    entryStatus ??
    (entryType === "payment" ? "paid" : "unpaid");
  let resolvedPaidVia =
    resolvedStatus === "paid" ? normalizePaidVia(paidVia) ?? "e_transfer" : normalizePaidVia(paidVia);

  if (entryType === "charge") {
    const method = normalizePaidVia(paidVia);
    if (!method) {
      throw new ApiError(400, "Payment method is required. Choose Pre-authorized or E-Transfer.");
    }
    resolvedPaidVia = method;
    resolvedStatus = method === "deposit" ? "paid" : "unpaid";
  }

  const chargeTotals = entryType === "charge" ? getBillEntryTotals(Number(amount)) : null;
  if (resolvedPaidVia === "deposit") {
    assertDepositPaymentAllowed(
      booking,
      {
        title: title.trim(),
        amount: Number(amount),
        entryType,
        status: resolvedStatus,
        totalAmount: chargeTotals?.totalAmount,
      },
      resolvedPaidVia,
    );
  }

  let attachmentUrl;
  let attachmentName;
  let emailAttachment;
  if (req.file) {
    attachmentName = sanitizeAttachmentName(req.file.originalname);
    emailAttachment = {
      filename: attachmentName,
      content: req.file.buffer,
      contentType: req.file.mimetype || "application/octet-stream",
    };
    try {
      const uploaded = await uploadBillAttachment(req.file);
      attachmentUrl = uploaded?.secure_url;
    } catch (err) {
      console.error("Bill attachment upload failed:", {
        bookingId: String(booking._id),
        message: err?.message,
      });
    }
  } else if (req.body?.attachmentUrl) {
    attachmentUrl = String(req.body.attachmentUrl).trim();
    if (!isStoredImageUrl(attachmentUrl)) {
      throw new ApiError(400, "Invalid attachment URL");
    }
    attachmentName = sanitizeAttachmentName(req.body.attachmentName || "attachment");
    try {
      const buffer = await readStoredFile(attachmentUrl);
      if (buffer) {
        emailAttachment = {
          filename: attachmentName,
          content: buffer,
          contentType: "application/octet-stream",
        };
      }
    } catch {
      // Charge still saves; email can go without the ticket file.
    }
  }

  appendBillEntry(booking, {
    title: title.trim(),
    description: description?.trim() || undefined,
    amount: Number(amount),
    entryType,
    status: resolvedStatus,
    source: "manual",
    paidVia: resolvedPaidVia,
    attachmentUrl,
    attachmentName,
    ...createdByFields(req.user),
  });
  persistSecurityDepositStatus(booking);
  Object.assign(booking, staffUpdatedByFields(req.user));
  await booking.save();

  const newEntry = booking.billEntries[booking.billEntries.length - 1];
  let pdfBuffer = null;
  try {
    pdfBuffer = await Promise.race([
      attachInvoiceToBillEntry(booking, newEntry),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("invoice timeout")), 12_000);
      }),
    ]);
    if (booking.isModified()) {
      await booking.save();
    }
  } catch (err) {
    console.error("Bill entry invoice failed:", {
      bookingId: String(booking._id),
      message: err?.message,
    });
  }

  if (entryType === "charge") {
    const { remainingAmount } = computeDepositTotals(booking);
    const mailed = await sendBillingChargeEmail({
      booking,
      entry: newEntry,
      pdfBuffer,
      remainingDeposit: remainingAmount,
      attachment: emailAttachment,
    });
    if (mailed?.skipped) {
      console.error("Billing charge email did not send:", {
        bookingId: String(booking._id),
        reason: mailed.reason,
      });
    }
  }

  return res.status(201).json(new ApiResponse(201, await billEntryResponse(booking), "Bill entry created"));
});

const updateBillEntry = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  const entry = booking.billEntries?.id(req.params.entryId);
  if (!entry) throw new ApiError(404, "Bill entry not found");
  if (entry.source === "system") {
    throw new ApiError(400, "System bill entries cannot be edited");
  }

  const { title, description, amount, status, paid, paidVia } = req.body;
  if (title !== undefined) entry.title = String(title).trim();
  if (description !== undefined) entry.description = description?.trim() || undefined;
  if (amount !== undefined) {
    const nextAmount = Number(amount);
    if (Number.isNaN(nextAmount) || nextAmount < 0) {
      throw new ApiError(400, "Invalid amount");
    }
    entry.amount = nextAmount;
    if (entry.entryType === "charge") {
      const totals = getBillEntryTotals(entry.amount);
      entry.taxAmount = totals.taxAmount;
      entry.totalAmount = totals.totalAmount;
    }
  }
  if (status !== undefined) {
    if (!["unpaid", "paid", "refund"].includes(status)) {
      throw new ApiError(400, "status must be unpaid, paid, or refund");
    }
    entry.status = status;
  } else if (paid !== undefined) {
    entry.status = paid ? "paid" : "unpaid";
  }

  if (entry.status === "paid") {
    const resolvedPaidVia = normalizePaidVia(paidVia) ?? entry.paidVia ?? "e_transfer";
    assertDepositPaymentAllowed(booking, entry, resolvedPaidVia, {
      excludeEntryId: entry._id,
    });
    entry.paidVia = resolvedPaidVia;
  } else if (paidVia !== undefined) {
    const resolvedPaidVia = normalizePaidVia(paidVia);
    if (resolvedPaidVia) entry.paidVia = resolvedPaidVia;
  }

  await attachInvoiceToBillEntry(booking, entry);

  const summary = computeBillSummary(booking.billEntries);
  booking.totalAmount = summary.totalBill;
  booking.paymentStatus =
    summary.totalUnpaid <= 0 && summary.totalBill > 0 ? "paid" : "pending";
  persistSecurityDepositStatus(booking);

  Object.assign(booking, staffUpdatedByFields(req.user));
  await booking.save();
  return res.status(200).json(new ApiResponse(200, await billEntryResponse(booking), "Bill updated"));
});

const getFullInvoicePdf = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  const staff = isStaff(req.user);
  if (!staff && booking.userId.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden");
  }

  const invoiceNumber = buildFullInvoiceNumber(booking);
  const pdfBuffer = await generateFullInvoicePdf(booking);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="invoice-${invoiceNumber}.pdf"`,
  );
  res.send(pdfBuffer);
});

const getBillEntryInvoicePdf = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  const staff = isStaff(req.user);
  if (!staff && booking.userId.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden");
  }

  const entry = booking.billEntries?.id(req.params.entryId);
  if (!entry) throw new ApiError(404, "Bill entry not found");
  if (!canHaveInvoice(entry)) {
    throw new ApiError(400, "Invoice is not available for this bill entry");
  }

  const invoiceNumber = assignInvoiceNumber(booking, entry);
  if (booking.isModified()) {
    await booking.save();
  }

  const pdfBuffer = await generateEntryInvoicePdf(booking, entry);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="invoice-${invoiceNumber}.pdf"`,
  );
  res.send(pdfBuffer);
});

const deleteBillEntry = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  const entry = booking.billEntries?.id(req.params.entryId);
  if (!entry) throw new ApiError(404, "Bill entry not found");
  if (entry.source === "system") {
    throw new ApiError(400, "System bill entries cannot be deleted");
  }

  entry.deleteOne();

  const summary = computeBillSummary(booking.billEntries);
  booking.totalAmount = summary.totalBill;
  booking.paymentStatus =
    summary.totalUnpaid <= 0 && summary.totalBill > 0 ? "paid" : "pending";
  persistSecurityDepositStatus(booking);

  Object.assign(booking, staffUpdatedByFields(req.user));
  await booking.save();
  return res.status(200).json(new ApiResponse(200, await billEntryResponse(booking), "Bill updated"));
});

const refundBookingSecurityDeposit = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) throw new ApiError(404, "Booking not found");

  refundSecurityDeposit(booking, await securityDepositExtras(booking));
  Object.assign(booking, staffUpdatedByFields(req.user));
  await booking.save();
  return res.status(200).json(new ApiResponse(200, await billEntryResponse(booking), "Bill updated"));
});

export {
  getUnavailableCarIds,
  getMyBookings,
  getAdminBookings,
  getAdminBookingsByCar,
  getAdminOverview,
  getBookingDetail,
  getBookingById,
  createBooking,
  adminCreateBooking,
  adminUpdateBooking,
  updateBookingStatus,
  updateCheckInOutVisibility,
  getCancellationPreview,
  cancelBooking,
  addBillEntry,
  updateBillEntry,
  getFullInvoicePdf,
  getBillEntryInvoicePdf,
  deleteBillEntry,
  refundBookingSecurityDeposit,
};
