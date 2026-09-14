import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { formatDoc, formatDocs } from "../utils/formatDoc.js";
import { patchText } from "../utils/patchPayload.js";
import { aggregatePaginate, paginatedPayload, wantsPagination } from "../utils/paginate.js";

const getCurrentUser = asyncHandler(async (req, res) => {
  return res.status(200).json(new ApiResponse(200, formatDoc(req.user), "Current user fetched"));
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name, phone, licenseUrl } = req.body;
  const patch = {};
  if (name !== undefined) patch.name = patchText(name);
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
  const subAdmins = await User.find({ role: "sub_admin" }).sort({ createdAt: -1 });
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
    createdBy: req.user._id,
  });

  return res.status(201).json(new ApiResponse(201, formatDoc(subAdmin), "Sub-admin created"));
});

const createCustomer = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  if (!name?.trim() || !email?.trim() || !password) {
    throw new ApiError(400, "Name, email, and password are required");
  }
  if (password.length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters");
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    throw new ApiError(400, "Email already registered");
  }

  const customer = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    password,
    phone: phone?.trim() || undefined,
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

  const { name, email, password } = req.body;
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) throw new ApiError(400, "Name is required");
    user.name = trimmed;
  }
  if (email !== undefined) {
    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail) throw new ApiError(400, "Email is required");
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

  await user.save();
  return res.status(200).json(new ApiResponse(200, formatDoc(user), "Sub-admin updated"));
});

const deleteSubAdmin = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (user.role !== "sub_admin") {
    throw new ApiError(400, "Only sub-admin accounts can be removed from this page");
  }

  await User.findByIdAndDelete(req.params.id);
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
  deleteSubAdmin,
  setUserRole,
};
