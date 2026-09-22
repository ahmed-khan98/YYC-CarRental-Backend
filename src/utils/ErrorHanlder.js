import { ApiError } from "./ApiError.js";

const ErrorHandler = (err, req, res, next) => {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      status: "error",
      statusCode: err.statusCode,
      message: err.message,
      success: err.success,
      errors: err.errors,
      data: err.data,
    });
    return;
  }

  if (err?.name === "JsonWebTokenError" || err?.name === "TokenExpiredError") {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Invalid or expired token",
      success: false,
      errors: [],
      data: null,
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    status: "error",
    statusCode: 500,
    message: "Internal Server Error",
    success: false,
    errors: [],
    data: null,
  });
};

export { ErrorHandler };
