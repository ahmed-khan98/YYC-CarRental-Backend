import "./loadEnv.js";
import connectDB from "./db/index.js";
import { app } from "./app.js";
import { ensureUploadsRoot, getUploadsRoot } from "./utils/localFileStore.js";
import { startEmailJobWorker } from "./utils/emailJobWorker.js";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err?.message || err);
});

connectDB()
  .then(async () => {
    await ensureUploadsRoot();
    app.listen(process.env.PORT || 5000, () => {
      console.log(`⚙️ Server is running at port :${process.env.PORT || 5000}`);
      console.log(`✓ Uploads: ${getUploadsRoot()}`);
      startEmailJobWorker();
    });
  })
  .catch((err) => {
    console.log("MONGO db connection failed !!! ", err);
  });
