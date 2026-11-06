import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { patchText } from "../utils/patchPayload.js";
import { aggregatePaginate, paginatedPayload, wantsPagination } from "../utils/paginate.js";
import { assertValidEmail } from "../utils/email.js";

const getCurrentUser = asyncHandler(async (req, res) => {
  return res.status(200).json(new ApiResponse(200, formatDoc(req.user), "Current user fetched"));
});

const PRIMARY_ADMIN_EMAIL = "ahmedkhn015@gmail.com";
const PRIMARY_ADMIN_DISPLAY_NAME = "Admin";

const updateProfile = asyncHandler(async (req, res) => {
  const { name, phone, licenseUrl } = req.body;
  const patch = {};
  if (name !== undefined) {
    const email = typeof req.user?.email === "string" ? req.user.email.toLowerCase() : "";
    patch.name = email === PRIMARY_ADMIN_EMAIL ? PRIMARY_ADMIN_DISPLAY_NAME : patchText(name);
  }
  if (phone !== undefined) patch.phone = patchText(phone);
  if (licenseUrl !== undefined) patch.licenseUrl = licenseUrl;
  if (phone && licenseUrl) patch.profileComplete = true;

  const user = await User.findByIdAndUpdate(req.user._id, patch, { new: true });
  return res.status(200).json(new ApiResponse(200, formatDoc(user), "Profile updated"));
});

const listUsers = asyncHandler(async (req, res) => {
  const result = await aggregatePaginate(
    User,
    [{ $project: { password: 0, refreshToken: 0 } }, { $sort: { createdAt: -1 } }],
    req,
    { defaultLimit: wantsPagination(req) ? 50 : 200 },
  );
  const users = formatDocs(result.docs);
  if (wantsPagination(req)) {
    return res.status(200).json(new ApiResponse(200, paginatedPayload(users, result), "Users fetched"));
  }
  return res.status(200).json(new ApiResponse(200, users, "Users fetched"));
});

const listSubAdmins = asyncHandler(async (req, res) => {
  // Temporary: getAll returns only active records (missing isActive treated as active)
  // const subAdmins = await User.find({ role: "sub_admin" })
  const subAdmins = await User.find({ role: "sub_admin", isActive: { $ne: false } })
    .select("-password -refreshToken")
    .sort({ createdAt: -1 })
    .lean();
  return res.status(200).json(new ApiResponse(200, formatDocs(subAdmins), "Sub-admins fetched"));
});

const createSubAdmin = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name?.trim() || !email?.trim() || !password) {
    throw new ApiError(400, "Name, email, and password are required");
  }
  if (password.length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters");
  }
  assertValidEmail(email);

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    throw new ApiError(400, "Email already registered");
  }

  const subAdmin = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    password,
    role: "sub_admin",
    isActive: true,
    createdBy: req.user._id,
  });

  return res.status(201).json(new ApiResponse(201, formatDoc(subAdmin), "Sub-admin created"));
});

const createCustomer = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  if (!name?.trim() || !email?.trim() || !phone?.trim() || !password) {
    throw new ApiError(400, "Name, email, phone, and password are required");
  }
  if (password.length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters");
  }
  assertValidEmail(email);

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    throw new ApiError(400, "Email already registered");
  }

  const customer = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    password,
    phone: phone.trim(),
    role: "customer",
    createdBy: req.user._id,
  });

  return res.status(201).json(new ApiResponse(201, formatDoc(customer), "Customer created"));
});

const updateSubAdmin = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("+password");
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (user.role !== "sub_admin") {
    throw new ApiError(400, "Only sub-admin accounts can be updated from this page");
  }

  const { name, email, password, isActive } = req.body;
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) throw new ApiError(400, "Name is required");
    user.name = trimmed;
  }
  if (email !== undefined) {
    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail) throw new ApiError(400, "Email is required");
    assertValidEmail(normalizedEmail);
    const existing = await User.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
    if (existing) {
      throw new ApiError(400, "Email already registered");
    }
    user.email = normalizedEmail;
  }
  if (password) {
    if (password.length < 6) {
      throw new ApiError(400, "Password must be at least 6 characters");
    }
    user.password = password;
  }
  if (typeof isActive === "boolean") {
    user.isActive = isActive;
    if (!isActive) {
      user.refreshToken = undefined;
    }
  }

  await user.save();
  return res.status(200).json(new ApiResponse(200, formatDoc(user), "Sub-admin updated"));
});

const deactivateSubAdmin = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (user.role !== "sub_admin") {
    throw new ApiError(400, "Only sub-admin accounts can be removed from this page");
  }

  user.isActive = false;
  user.refreshToken = undefined;
  await user.save();
  return res.status(200).json(new ApiResponse(200, formatDoc(user), "Sub-admin deactivated"));
});

const deleteSubAdmin = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (user.role !== "sub_admin") {
    throw new ApiError(400, "Only sub-admin accounts can be removed from this page");
  }

  // Temporary: hard delete commented out — soft deactivate instead
  // await User.findByIdAndDelete(req.params.id);
  // return res.status(200).json(new ApiResponse(200, { success: true }, "Sub-admin deleted"));
  user.isActive = false;
  user.refreshToken = undefined;
  await user.save();
  return res.status(200).json(new ApiResponse(200, { success: true }, "Sub-admin deleted"));
});

const setUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!["admin", "sub_admin", "customer"].includes(role)) {
    throw new ApiError(400, "Invalid role");
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  if (user._id.toString() === req.user._id.toString()) {
    throw new ApiError(400, "You cannot change your own role");
  }

  const updated = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
  return res.status(200).json(new ApiResponse(200, formatDoc(updated), "User role updated"));
});

export {
  getCurrentUser,
  updateProfile,
  listUsers,
  listSubAdmins,
  createSubAdmin,
  createCustomer,
  updateSubAdmin,
  deactivateSubAdmin,
  deleteSubAdmin,
  setUserRole,
};
