import { logger } from "./logger.js";

export function runInBackground(label, task) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((err) => {
        logger.error(`${label} failed:`, err?.message || err);
      });
  });
}
