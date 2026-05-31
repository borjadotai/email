import { createMailRuntime } from "./runtime.js";

const runtime = createMailRuntime();
runtime.start();

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  runtime.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
