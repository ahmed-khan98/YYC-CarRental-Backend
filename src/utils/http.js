import { ApiError } from "./ApiError.js";
import { ApiResponse } from "./ApiResponse.js";

export function sendOk(res, data, message = "Success", statusCode = 200) {
  return res.status(statusCode).json(new ApiResponse(statusCode, data, message));
}

export function sendCreated(res, data, message = "Created") {
  return sendOk(res, data, message, 201);
}

export function requireFound(doc, message = "Not found") {
  if (!doc) throw new ApiError(404, message);
  return doc;
}

export async function findByIdOrThrow(Model, id, message = "Not found") {
  return requireFound(await Model.findById(id), message);
}

export function requireFields(body = {}, fields = []) {
  const missing = fields.filter((key) => {
    const value = body[key];
    return value === undefined || value === null || (typeof value === "string" && !value.trim());
  });
  if (missing.length) {
    throw new ApiError(400, `${missing[0]} is required`);
  }
}
