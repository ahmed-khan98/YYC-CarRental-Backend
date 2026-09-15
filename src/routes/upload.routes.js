import express, { Router } from "express";
import {
  completeChunkUpload,
  putChunkUpload,
  startChunkUpload,
  uploadFile,
  uploadMultipleFiles,
} from "../controllers/upload.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.route("/").post(verifyJWT, upload.single("file"), uploadFile);
router.route("/multiple").post(verifyJWT, upload.array("files", 12), uploadMultipleFiles);
router.route("/sessions").post(verifyJWT, startChunkUpload);
router
  .route("/sessions/:id/chunks/:index")
  .put(verifyJWT, express.raw({ type: () => true, limit: "800kb" }), putChunkUpload)
  .post(verifyJWT, upload.single("chunk"), putChunkUpload);
router.route("/sessions/:id/complete").post(verifyJWT, completeChunkUpload);

export default router;
