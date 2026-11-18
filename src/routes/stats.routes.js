import { Router } from "express";
import { getPublicStats } from "../controllers/stats.controller.js";

const router = Router();

router.route("/").get(getPublicStats);
router.route("/public").get(getPublicStats);

export default router;
