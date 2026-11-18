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
    const port = Number(process.env.PORT || 5000);
    const server = app.listen({ port, exclusive: true }, () => {
      const addr = server.address();
      logger.info(`Server is running at port :${addr?.port || port}`);
      logger.info(`Uploads: ${getUploadsRoot()}`);
      startEmailJobWorker();
    });
    server.on("error", (err) => {
      logger.error(`Failed to bind port ${port}:`, err.code || err.message);
      process.exit(1);
    });
  })
  .catch((err) => {
    logger.error("MONGO db connection failed !!! ", err);
  });
