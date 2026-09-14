import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { ErrorHandler } from "./utils/ErrorHanlder.js";
import { ApiError } from "./utils/ApiError.js";
import { ApiResponse } from "./utils/ApiResponse.js";
import { getUploadsRoot } from "./utils/localFileStore.js";
import mongoose from "mongoose";
import authRouter from "./routes/auth.routes.js";
import userRouter from "./routes/user.routes.js";
import carRouter from "./routes/car.routes.js";
import bookingRouter from "./routes/booking.routes.js";
import locationRouter from "./routes/location.routes.js";
import serviceRouter from "./routes/service.routes.js";
import maintenanceRouter from "./routes/maintenance.routes.js";
import inspectionRouter from "./routes/inspection.routes.js";
import uploadRouter from "./routes/upload.routes.js";
import contactRouter from "./routes/contact.routes.js";

const app = express();

app.get("/", (_req, res) => {
  res.send("server running — OK");
});

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

app.use(express.static("public"));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

app.use("/uploads", express.static(getUploadsRoot(), { index: false, maxAge: "7d" }));

function health(_req, res) {
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        status: "ok",
        database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      },
      "OK",
    ),
  );
}

app.get("/api/v1/health", health);
app.get("/api/health", health);
app.get("/api/v1/ping", (_req, res) => {
  return res.status(200).json(new ApiResponse(200, { pong: true }, "OK"));
});

const apiRoutes = [
  ["/auth", authRouter],
  ["/user", userRouter],
  ["/users", userRouter],
  ["/car", carRouter],
  ["/cars", carRouter],
  ["/booking", bookingRouter],
  ["/bookings", bookingRouter],
  ["/location", locationRouter],
  ["/locations", locationRouter],
  ["/service", serviceRouter],
  ["/services", serviceRouter],
  ["/maintenance", maintenanceRouter],
  ["/inspection", inspectionRouter],
  ["/inspections", inspectionRouter],
  ["/upload", uploadRouter],
  ["/contact", contactRouter],
];

for (const prefix of ["/api/v1", "/api"]) {
  for (const [routePath, router] of apiRoutes) {
    app.use(`${prefix}${routePath}`, router);
  }
}

app.use((_req, _res, next) => {
  next(new ApiError(404, "Route not found"));
});

app.use(ErrorHandler);

export { app };
