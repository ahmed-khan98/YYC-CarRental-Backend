import { Router } from "express";
import { getConfig, updateConfig } from "../controllers/config.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { requireFullAdmin } from "../middlewares/checkRole.js";

const router = Router();

router.route("/").get(verifyJWT, requireFullAdmin, getConfig).patch(verifyJWT, requireFullAdmin, updateConfig);

export default router;
