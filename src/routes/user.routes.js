import { Router } from "express";
import {
  getCurrentUser,
  updateProfile,
  listUsers,
  listSubAdmins,
  createSubAdmin,
  updateSubAdmin,
  createCustomer,
  deleteSubAdmin,
  setUserRole,
} from "../controllers/user.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { checkRole } from "../middlewares/checkRole.js";

const router = Router();

router.route("/me").get(verifyJWT, getCurrentUser);
router.route("/me/profile").patch(verifyJWT, updateProfile);
router.route("/").get(verifyJWT, checkRole("admin", "sub_admin"), listUsers);
router.route("/sub-admins").get(verifyJWT, checkRole("admin"), listSubAdmins).post(verifyJWT, checkRole("admin"), createSubAdmin);
router.route("/sub-admins/:id").patch(verifyJWT, checkRole("admin"), updateSubAdmin).delete(verifyJWT, checkRole("admin"), deleteSubAdmin);
router.route("/customers").post(verifyJWT, checkRole("admin", "sub_admin"), createCustomer);
router.route("/:id/role").patch(verifyJWT, checkRole("admin"), setUserRole);

export default router;
