import { resolveConfig } from "./config.js";
import { createServer } from "./http.js";
import { MailStore } from "./store.js";

const config = resolveConfig();
const store = new MailStore({
  databasePath: config.databasePath,
  seedDemo: config.seedDemo
});
const { server } = createServer({
  store,
  host: config.host,
  port: config.port,
  publicBaseURL: config.publicBaseURL
});

server.listen(config.port, config.host, () => {
  console.log(`Email server listening at http://${config.host}:${config.port}`);
  console.log(`SQLite database: ${config.databasePath}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

