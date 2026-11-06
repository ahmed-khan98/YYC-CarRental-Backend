import "./loadEnv.js";
import connectDB from "./db/index.js";
import { app } from "./app.js";
import { ensureUploadsRoot, getUploadsRoot } from "./utils/localFileStore.js";
import { startEmailJobWorker } from "./utils/emailJobWorker.js";
import { logger } from "./utils/logger.js";

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err?.message || err);
});

connectDB()
  .then(async () => {
    await ensureUploadsRoot();
    app.listen(process.env.PORT || 5000, () => {
      logger.info(`Server is running at port :${process.env.PORT || 5000}`);
      logger.info(`Uploads: ${getUploadsRoot()}`);
      startEmailJobWorker();
    });
  })
  .catch((err) => {
    logger.error("MONGO db connection failed !!! ", err);
  });
