import { asyncHandler } from "../utils/asyncHandler.js";
import { sendOk } from "../utils/http.js";
import {
  formatAppConfig,
  getAppConfig,
  updatePreAuthorizedAmount,
} from "../utils/appConfig.js";

const getConfig = asyncHandler(async (_req, res) => {
  const config = await getAppConfig();
  return sendOk(res, formatAppConfig(config), "Config fetched");
});

const updateConfig = asyncHandler(async (req, res) => {
  const config = await updatePreAuthorizedAmount(req.body?.preAuthorizedAmount);
  return sendOk(res, formatAppConfig(config), "Config updated");
});

export { getConfig, updateConfig };
