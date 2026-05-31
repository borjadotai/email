import { relayEnv, requireRelayEnv } from "../../../../../lib/env.js";
import { errorResponse, json, readJSON } from "../../../../../lib/http.js";
import { refreshGoogleAccessToken } from "../../../../../lib/googleOAuth.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const config = relayEnv();
    const body = await readJSON(request);
    if (!body.refreshToken) {
      throw Object.assign(new Error("refreshToken is required."), { status: 400 });
    }
    return json(await refreshGoogleAccessToken({
      clientId: requireRelayEnv(config, "googleClientId", "GOOGLE_OAUTH_CLIENT_ID is required."),
      clientSecret: requireRelayEnv(config, "googleClientSecret", "GOOGLE_OAUTH_CLIENT_SECRET is required."),
      refreshToken: body.refreshToken
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
