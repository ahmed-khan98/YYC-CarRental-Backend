import "../src/loadEnv.js";
import connectDB from "../src/db/index.js";
import { app } from "../src/app.js";
import { ensureUploadsRoot } from "../src/utils/localFileStore.js";

await connectDB();
await ensureUploadsRoot();

const server = app.listen(0, async () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/v1/cars`;
  console.log("listening", port);
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log("STATUS", res.status);
    console.log(text.slice(0, 2000));
  } catch (err) {
    console.error("FETCH ERROR", err);
  } finally {
    server.close();
    process.exit(0);
  }
});
