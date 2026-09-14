import { Router } from "express";
import {
  listLocations,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation,
} from "../controllers/location.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { checkRole } from "../middlewares/checkRole.js";

const router = Router();

router.route("/").get(listLocations).post(verifyJWT, checkRole("admin", "sub_admin"), createLocation);
router.route("/:id").get(getLocationById).patch(verifyJWT, checkRole("admin", "sub_admin"), updateLocation).delete(verifyJWT, checkRole("admin"), deleteLocation);

export default router;
