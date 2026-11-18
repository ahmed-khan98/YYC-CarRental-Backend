import { asyncHandler } from "../utils/asyncHandler.js";
import { sendOk } from "../utils/http.js";
import {
  formatAppConfig,
  formatPublicAppConfig,
  getAppConfig,
  updateAppConfig,
} from "../utils/appConfig.js";

const getConfig = asyncHandler(async (_req, res) => {
  const config = await getAppConfig();
  return sendOk(res, formatAppConfig(config), "Config fetched");
});

const getPublicConfig = asyncHandler(async (_req, res) => {
  const config = await getAppConfig();
  return sendOk(res, formatPublicAppConfig(config), "Config fetched");
});

const updateConfig = asyncHandler(async (req, res) => {
  const config = await updateAppConfig({
    preAuthorizedAmount: req.body?.preAuthorizedAmount,
    userBookingEnabled: req.body?.userBookingEnabled,
  });
  return sendOk(res, formatAppConfig(config), "Config updated");
});

export { getConfig, getPublicConfig, updateConfig };
