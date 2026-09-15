import { Router } from "express";
import {
  createInspection,
  getCheckInTermsPdf,
  getInspectionById,
  getSignedCheckInPdf,
  listCheckInOutBoard,
  listInspectionsByBooking,
  listInspectionsByCar,
  listAllInspections,
} from "../controllers/inspection.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { checkRole } from "../middlewares/checkRole.js";

const router = Router();

router.route("/").post(verifyJWT, checkRole("admin", "sub_admin"), createInspection);
router.route("/admin").get(verifyJWT, checkRole("admin", "sub_admin"), listAllInspections);
router.route("/check-in-out").get(verifyJWT, checkRole("admin", "sub_admin"), listCheckInOutBoard);
router.route("/terms-pdf/:bookingId").post(verifyJWT, checkRole("admin", "sub_admin"), getCheckInTermsPdf).get(verifyJWT, checkRole("admin", "sub_admin"), getCheckInTermsPdf);
router.route("/signed-pdf/:inspectionId").get(verifyJWT, getSignedCheckInPdf);
router.route("/booking/:bookingId").get(verifyJWT, listInspectionsByBooking);
router.route("/car/:carId").get(verifyJWT, checkRole("admin", "sub_admin"), listInspectionsByCar);
router.route("/:id").get(verifyJWT, getInspectionById);

export default router;
