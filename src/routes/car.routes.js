import { Router } from "express";
import { listCars, listAvailableCars, getCarById, createCar, updateCar, deleteCar } from "../controllers/car.controller.js";
import { optionalAuth, verifyJWT } from "../middlewares/auth.middleware.js";
import { checkRole } from "../middlewares/checkRole.js";

const router = Router();

router.route("/available").get(optionalAuth, listAvailableCars);
router.route("/").get(optionalAuth, listCars).post(verifyJWT, checkRole("admin", "sub_admin"), createCar);
router.route("/:id").get(optionalAuth, getCarById).patch(verifyJWT, checkRole("admin", "sub_admin"), updateCar).delete(verifyJWT, checkRole("admin"), deleteCar);

export default router;
