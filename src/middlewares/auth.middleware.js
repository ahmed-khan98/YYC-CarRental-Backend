import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export function isStaff(user) {
  return !!user && (user.role === "admin" || user.role === "sub_admin");
}

export function isFullAdmin(user) {
  return !!user && user.role === "admin";
}

export const verifyJWT = asyncHandler(async (req, res, next) => {
  try {
    const token =
      req.cookies?.accessToken ||
      req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      throw new ApiError(401, "Unauthorized request");
    }

    const decodedToken = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decodedToken?.userId).select("-password -refreshToken");

    if (!user) {
      throw new ApiError(401, "Invalid Access Token");
    }
    if (user.isActive === false) {
      throw new ApiError(401, "This account has been deactivated");
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error?.name === "TokenExpiredError") {
      if (req.originalUrl.includes("/logout")) {
        return next();
      }
      throw new ApiError(401, "Session Expired. Please login again.");
    }
    throw new ApiError(401, error?.message || "Invalid access token");
  }
});

export const optionalAuth = asyncHandler(async (req, res, next) => {
  try {
    const token =
      req.cookies?.accessToken ||
      req.header("Authorization")?.replace("Bearer ", "");
    if (token) {
      const decodedToken = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decodedToken?.userId).select("-password -refreshToken");
      if (user && user.isActive !== false) {
        req.user = user;
      }
    }
    next();
  } catch {
    next();
  }
});

export const authenticate = verifyJWT;
