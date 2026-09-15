import { Router } from "express";
import {
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
  cancelBooking,
  getCancellationPreview,
  updateCheckInOutVisibility,
  addBillEntry,
  updateBillEntry,
  deleteBillEntry,
  refundBookingSecurityDeposit,
  getBillEntryInvoicePdf,
  getFullInvoicePdf,
} from "../controllers/booking.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { checkRole } from "../middlewares/checkRole.js";
import { billAttachmentUpload } from "../middlewares/multer.middleware.js";

const router = Router();

router.route("/unavailable").get(getUnavailableCarIds);
router.route("/my").get(verifyJWT, getMyBookings);
router.route("/admin").get(verifyJWT, checkRole("admin", "sub_admin"), getAdminBookings);
router.route("/admin/overview").get(verifyJWT, checkRole("admin", "sub_admin"), getAdminOverview);
router.route("/admin/car/:carId").get(verifyJWT, checkRole("admin", "sub_admin"), getAdminBookingsByCar);
router.route("/").post(verifyJWT, createBooking);
router.route("/admin").post(verifyJWT, checkRole("admin", "sub_admin"), adminCreateBooking);

router.route("/:id/detail").get(verifyJWT, getBookingDetail);
router.route("/:id").get(getBookingById);
router.route("/:id/admin").patch(verifyJWT, checkRole("admin", "sub_admin"), adminUpdateBooking);
router.route("/:id/status").patch(verifyJWT, updateBookingStatus);
router.route("/:id/check-in-out-visibility").patch(verifyJWT, checkRole("admin", "sub_admin"), updateCheckInOutVisibility);
router.route("/:id/cancellation-preview").get(verifyJWT, getCancellationPreview);
router.route("/:id/cancel").post(verifyJWT, cancelBooking);
router.route("/:id/bill-entries").post(
  verifyJWT,
  checkRole("admin", "sub_admin"),
  billAttachmentUpload.single("attachment"),
  addBillEntry,
);
router.route("/:id/security-deposit/refund").post(verifyJWT, checkRole("admin", "sub_admin"), refundBookingSecurityDeposit);
router.route("/:id/invoice-pdf").get(verifyJWT, getFullInvoicePdf);
router.route("/:id/bill-entries/:entryId/invoice-pdf").get(verifyJWT, getBillEntryInvoicePdf);
router.route("/:id/bill-entries/:entryId").patch(verifyJWT, checkRole("admin", "sub_admin"), updateBillEntry).delete(verifyJWT, checkRole("admin"), deleteBillEntry);

export default router;
