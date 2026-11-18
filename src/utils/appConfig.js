import { AppConfig } from "../models/appConfig.model.js";
import { ApiError } from "./ApiError.js";

function schemaDefault(path) {
  const field = AppConfig.schema.path(path);
  const value = field?.defaultValue;
  return typeof value === "function" ? value() : value;
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function parseUserBookingEnabled(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  throw new ApiError(400, "userBookingEnabled must be true or false");
}

export function normalizePreAuthorizedAmount(value) {
  const amount = money(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, "Pre-authorized amount must be greater than 0");
  }
  return amount;
}

export async function getAppConfig() {
  const config = await AppConfig.findOneAndUpdate(
    { singleton: "default" },
    { $setOnInsert: { singleton: "default" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const $set = {};
  if (!(money(config.preAuthorizedAmount) > 0)) {
    $set.preAuthorizedAmount = schemaDefault("preAuthorizedAmount");
  }
  if (typeof config.userBookingEnabled !== "boolean") {
    $set.userBookingEnabled = schemaDefault("userBookingEnabled");
  }
  if (!Object.keys($set).length) return config;

  return AppConfig.findOneAndUpdate(
    { singleton: "default" },
    { $set },
    { new: true },
  );
}

export async function getPreAuthorizedAmount() {
  const config = await getAppConfig();
  return money(config.preAuthorizedAmount);
}

export async function updatePreAuthorizedAmount(value) {
  return updateAppConfig({ preAuthorizedAmount: value });
}

export async function isUserBookingEnabled() {
  const config = await getAppConfig();
  return config.userBookingEnabled === true;
}

export async function updateAppConfig(patch = {}) {
  const $set = {};
  if (patch.preAuthorizedAmount !== undefined) {
    $set.preAuthorizedAmount = normalizePreAuthorizedAmount(patch.preAuthorizedAmount);
  }
  if (patch.userBookingEnabled !== undefined) {
    $set.userBookingEnabled = parseUserBookingEnabled(patch.userBookingEnabled);
  }
  if (!Object.keys($set).length) {
    throw new ApiError(400, "No config fields to update");
  }
  return AppConfig.findOneAndUpdate(
    { singleton: "default" },
    { $set },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export function formatAppConfig(config) {
  return {
    preAuthorizedAmount: money(config.preAuthorizedAmount),
    userBookingEnabled: config.userBookingEnabled === true,
  };
}

export function formatPublicAppConfig(config) {
  return {
    userBookingEnabled: config.userBookingEnabled === true,
  };
}
