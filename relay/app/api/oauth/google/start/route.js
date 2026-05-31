import { relayEnv, requireRelayEnv } from "../../../../../lib/env.js";
import { errorResponse, json, readJSON } from "../../../../../lib/http.js";
import { assertAllowedCallbackURL, sealOAuthState } from "../../../../../lib/oauthState.js";
import { GMAIL_SCOPES, googleAuthorizationURL } from "../../../../../lib/googleOAuth.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const config = relayEnv();
    const body = await readJSON(request);
    const clientId = requireRelayEnv(config, "googleClientId", "GOOGLE_OAUTH_CLIENT_ID is required.");
    requireRelayEnv(config, "googleClientSecret", "GOOGLE_OAUTH_CLIENT_SECRET is required.");
    const localState = requiredString(body.state, "state");
    const deliveryToken = requiredString(body.deliveryToken, "deliveryToken");
    const publicURL = config.publicURL || new URL(request.url).origin;
    const callbackURL = assertAllowedCallbackURL(body.callbackURL, config.allowedCallbackHosts);
    const localCodeDelivery = body.deliveryMode === "local-code";
    const state = sealOAuthState({
      localState,
      deliveryToken,
      callbackURL,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000
    }, config.stateSecret);
    const redirectURI = localCodeDelivery ? callbackURL : `${publicURL}/api/oauth/google/callback`;
    return json({
      provider: "gmail",
      relay: true,
      deliveryMode: localCodeDelivery ? "local-code" : "relay-callback",
      authorizationURL: googleAuthorizationURL({
        clientId,
        redirectURI,
        state: localCodeDelivery ? localState : state,
        scopes: Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : GMAIL_SCOPES
      }),
      redirectURI
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function requiredString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw Object.assign(new Error(`${name} is required.`), { status: 400 });
  return text;
}
