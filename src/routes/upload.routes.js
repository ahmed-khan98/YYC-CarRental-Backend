import { Router } from "express";
import { uploadFile, uploadMultipleFiles } from "../controllers/upload.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.route("/").post(verifyJWT, upload.single("file"), uploadFile);
router.route("/multiple").post(verifyJWT, upload.array("files", 12), uploadMultipleFiles);

export default router;
