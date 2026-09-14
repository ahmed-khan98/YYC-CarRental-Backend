import "./loadEnv.js";
import connectDB from "./db/index.js";
import { app } from "./app.js";
import { ensureUploadsRoot, getUploadsRoot } from "./utils/localFileStore.js";

process.on("unhandledRejection", (reason) => {
  console.error("CRITICAL UNHANDLED REJECTION:", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
  console.error("CRITICAL UNCAUGHT EXCEPTION:", err.message);
});

connectDB()
  .then(async () => {
    await ensureUploadsRoot();
    app.listen(process.env.PORT || 5000, () => {
      console.log(`⚙️ Server is running at port :${process.env.PORT || 5000}`);
      console.log(`✓ Uploads: ${getUploadsRoot()}`);
    });
  })
  .catch((err) => {
    console.log("MONGO db connection failed !!! ", err);
  });
