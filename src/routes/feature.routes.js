import { Router } from "express";
import {
  listFeatures,
  getFeatureById,
  createFeature,
  updateFeature,
  deleteFeature,
} from "../controllers/feature.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { checkRole } from "../middlewares/checkRole.js";

const router = Router();

router.route("/").get(listFeatures).post(verifyJWT, checkRole("admin", "sub_admin"), createFeature);
router
  .route("/:id")
  .get(getFeatureById)
  .patch(verifyJWT, checkRole("admin", "sub_admin"), updateFeature)
  .delete(verifyJWT, checkRole("admin"), deleteFeature);

export default router;
