import mongoose from "mongoose";
import { ApiError } from "./ApiError.js";
import {
  isDuplicateKeyError,
  messageFromDuplicateKeyError,
  messageFromMongooseCastError,
  messageFromMongooseValidationError,
} from "./mongooseErrors.js";

function sendError(res, statusCode, message, errors = []) {
  res.status(statusCode).json({
    status: "error",
    statusCode,
    message,
    success: false,
    errors,
    data: null,
  });
}

function logClientError(message) {
  console.warn(message);
}

const ErrorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiError) {
    if (err.statusCode >= 500) {
      console.error(err);
    } else {
      logClientError(err.message);
    }
    sendError(res, err.statusCode, err.message, err.errors);
    return;
  }

  if (err instanceof mongoose.Error.ValidationError || err?.name === "ValidationError") {
    const message = messageFromMongooseValidationError(err);
    logClientError(message);
    sendError(res, 400, message);
    return;
  }

  if (err instanceof mongoose.Error.CastError || err?.name === "CastError") {
    const message = messageFromMongooseCastError(err);
    logClientError(message);
    sendError(res, 400, message);
    return;
  }

  if (isDuplicateKeyError(err)) {
    const message = messageFromDuplicateKeyError(err);
    logClientError(message);
    sendError(res, 400, message);
    return;
  }

  if (err?.name === "JsonWebTokenError" || err?.name === "TokenExpiredError") {
    logClientError("Invalid or expired token");
    sendError(res, 401, "Invalid or expired token");
    return;
  }

  console.error(err);
  sendError(res, 500, "Internal Server Error");
};

export { ErrorHandler };
