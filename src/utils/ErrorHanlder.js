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
  } else {
    console.error(err);
    res.status(500).json({
      status: "error",
      statusCode: 500,
      message: "Internal Server Error",
      success: false,
      errors: [],
      data: null,
    });
  }
};

export { ErrorHandler };
