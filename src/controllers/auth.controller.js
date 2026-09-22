import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc } from "../utils/formatDoc.js";

const ADMIN_EMAIL = "ahmedkhn015@gmail.com";
const ADMIN_DISPLAY_NAME = "Admin";

function isPrimaryAdminEmail(email) {
  return typeof email === "string" && email.toLowerCase() === ADMIN_EMAIL;
}

async function ensurePrimaryAdminName(user) {
  if (!user || !isPrimaryAdminEmail(user.email)) return user;
  if (user.name === ADMIN_DISPLAY_NAME) return user;
  user.name = ADMIN_DISPLAY_NAME;
  await user.save();
  return user;
}

function signTokens(userId) {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: "30d" });
  return { accessToken, refreshToken };
}

const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) {
    throw new ApiError(400, "Email and password are required");
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    throw new ApiError(400, "Email already registered");
  }

  const role = isPrimaryAdminEmail(email) ? "admin" : "customer";
  const displayName = isPrimaryAdminEmail(email) ? ADMIN_DISPLAY_NAME : name;
  const user = await User.create({ name: displayName, email, password, role });
  const { accessToken, refreshToken } = signTokens(user._id);
  user.refreshToken = refreshToken;
  await user.save();

  return res.status(201).json(new ApiResponse(201, { token: accessToken, refreshToken, user: formatDoc(user) }, "Registered"));
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    throw new ApiError(400, "Email and password are required");
  }

  const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, "Invalid email or password");
  }
  if (user.isActive === false) {
    throw new ApiError(403, "This account has been deactivated");
  }

  if (isPrimaryAdminEmail(user.email)) {
    user.name = ADMIN_DISPLAY_NAME;
  }

  const { accessToken, refreshToken } = signTokens(user._id);
  user.refreshToken = refreshToken;
  await user.save();

  return res.status(200).json(new ApiResponse(200, { token: accessToken, refreshToken, user: formatDoc(user) }, "Logged in"));
});

const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken: token } = req.body;
  if (!token) {
    throw new ApiError(400, "Refresh token required");
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw new ApiError(401, "Invalid refresh token");
  }

  const user = await User.findById(payload.userId).select("+refreshToken");
  if (!user || user.refreshToken !== token || user.isActive === false) {
    throw new ApiError(401, "Invalid refresh token");
  }

  await ensurePrimaryAdminName(user);
  const accessToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

  return res.status(200).json(new ApiResponse(200, { token: accessToken, refreshToken: token, user: formatDoc(user) }, "Token refreshed"));
});

const logout = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { $unset: { refreshToken: 1 } });
  return res.status(200).json(new ApiResponse(200, { message: "Logged out" }, "Logged out"));
});

const getMe = asyncHandler(async (req, res) => {
  await ensurePrimaryAdminName(req.user);
  return res.status(200).json(new ApiResponse(200, formatDoc(req.user), "Current user fetched"));
});

export {
  register,
  login,
  refreshToken,
  logout,
  getMe,
};
