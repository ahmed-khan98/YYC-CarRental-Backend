import { ApiError } from "../utils/ApiError.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const LONG_RUNNING_PATH =
  /\/upload(?:s|\/|$)|invoice-pdf|terms-pdf|signed-pdf|\/sessions\/|bill-entries/i;

export function isLongRunningRequest(req) {
  const url = String(req?.originalUrl || req?.url || "");
  return LONG_RUNNING_PATH.test(url);
}

function timeoutMiddleware(timeoutMs) {
  return (req, res, next) => {
    if (isLongRunningRequest(req)) {
      return next();
    }

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        next(new ApiError(408, "Request timeout"));
      }
    }, timeoutMs);

    const clear = () => clearTimeout(timer);
    res.on("finish", clear);
    res.on("close", clear);
    next();
  };
}

/** Factory: `app.use(requestTimeout())`. Also safe as `app.use(requestTimeout)`. */
export function requestTimeout(msOrReq, maybeRes, maybeNext) {
  const timeoutMs =
    typeof msOrReq === "number" && msOrReq > 0 ? msOrReq : DEFAULT_TIMEOUT_MS;
  const middleware = timeoutMiddleware(timeoutMs);

  if (msOrReq && typeof msOrReq === "object" && maybeRes && typeof maybeNext === "function") {
    return middleware(msOrReq, maybeRes, maybeNext);
  }
  return middleware;
}
