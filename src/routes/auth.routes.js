import { Router } from "express";
import { login, logout, refreshToken, register, getMe } from "../controllers/auth.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/register").post(register);
router.route("/login").post(login);
router.route("/refresh").post(refreshToken);
router.route("/logout").post(verifyJWT, logout);
router.route("/me").get(verifyJWT, getMe);

export default router;
