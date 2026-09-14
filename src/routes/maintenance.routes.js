import { Router } from "express";
import {
  listMaintenanceByCar,
  listMaintenance,
  createMaintenance,
  updateMaintenance,
} from "../controllers/maintenance.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { checkRole } from "../middlewares/checkRole.js";

const router = Router();

router.route("/car/:carId").get(verifyJWT, checkRole("admin", "sub_admin"), listMaintenanceByCar);
router.route("/").get(verifyJWT, checkRole("admin", "sub_admin"), listMaintenance).post(verifyJWT, checkRole("admin", "sub_admin"), createMaintenance);
router.route("/:id").patch(verifyJWT, checkRole("admin", "sub_admin"), updateMaintenance);

export default router;
