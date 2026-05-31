import { relayEnv, requireRelayEnv } from "../../../../lib/env.js";
import { sendAPNSNotification } from "../../../../lib/apns.js";
import { errorResponse, json, readJSON, requireBearer } from "../../../../lib/http.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const config = relayEnv();
    const apiToken = requireRelayEnv(config, "apiToken", "CARTA_RELAY_TOKEN is required.");
    requireBearer(request, apiToken);
    const body = await readJSON(request);
    const notifications = Array.isArray(body.notifications) ? body.notifications : [];
    let sent = 0;
    const failures = [];
    for (const notification of notifications) {
      try {
        await sendAPNSNotification({ config: config.apns, ...notification });
        sent += 1;
      } catch (error) {
        failures.push({ token: notification.token, error: error.message, reason: error.reason ?? null });
      }
    }
    return json({ sent, failed: failures.length, failures });
  } catch (error) {
    return errorResponse(error);
  }
}
