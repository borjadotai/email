import { relayEnv, requireRelayEnv } from "../../../../../lib/env.js";
import { errorResponse, json, readJSON } from "../../../../../lib/http.js";
import { exchangeGoogleCode } from "../../../../../lib/googleOAuth.js";
import { assertAllowedCallbackURL } from "../../../../../lib/oauthState.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const config = relayEnv();
    const body = await readJSON(request);
    const redirectURI = assertAllowedCallbackURL(body.redirectURI, config.allowedCallbackHosts);
    const code = requiredString(body.code, "code");
    return json(await exchangeGoogleCode({
      clientId: requireRelayEnv(config, "googleClientId", "GOOGLE_OAUTH_CLIENT_ID is required."),
      clientSecret: requireRelayEnv(config, "googleClientSecret", "GOOGLE_OAUTH_CLIENT_SECRET is required."),
      redirectURI,
      code
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

function requiredString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw Object.assign(new Error(`${name} is required.`), { status: 400 });
  return text;
}
