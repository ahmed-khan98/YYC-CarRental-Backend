import { Router } from "express";
import { listServices, createService, updateService, deleteService } from "../controllers/service.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { checkRole } from "../middlewares/checkRole.js";

const router = Router();

router.route("/").get(listServices).post(verifyJWT, checkRole("admin", "sub_admin"), createService);
router.route("/:id").patch(verifyJWT, checkRole("admin", "sub_admin"), updateService).delete(verifyJWT, checkRole("admin"), deleteService);

export default router;
