import { AppConfig } from "../models/appConfig.model.js";
import { ApiError } from "./ApiError.js";

export const DEFAULT_PRE_AUTHORIZED_AMOUNT = 800;

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function normalizePreAuthorizedAmount(value) {
  const amount = money(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, "Pre-authorized amount must be greater than 0");
  }
  return amount;
}

export async function getAppConfig() {
  return AppConfig.findOneAndUpdate(
    { singleton: "default" },
    { $setOnInsert: { preAuthorizedAmount: DEFAULT_PRE_AUTHORIZED_AMOUNT } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function getPreAuthorizedAmount() {
  const config = await getAppConfig();
  const amount = money(config.preAuthorizedAmount);
  return amount > 0 ? amount : DEFAULT_PRE_AUTHORIZED_AMOUNT;
}

export async function updatePreAuthorizedAmount(value) {
  const preAuthorizedAmount = normalizePreAuthorizedAmount(value);
  return AppConfig.findOneAndUpdate(
    { singleton: "default" },
    { $set: { preAuthorizedAmount } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export function formatAppConfig(config) {
  return {
    preAuthorizedAmount: money(config?.preAuthorizedAmount) || DEFAULT_PRE_AUTHORIZED_AMOUNT,
  };
}
