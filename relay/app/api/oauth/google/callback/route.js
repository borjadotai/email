import { relayEnv, requireRelayEnv } from "../../../../../lib/env.js";
import { errorResponse } from "../../../../../lib/http.js";
import { exchangeGoogleCode } from "../../../../../lib/googleOAuth.js";
import { openOAuthState, sealDeliveryPayload } from "../../../../../lib/oauthState.js";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    const config = relayEnv();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const sealedState = url.searchParams.get("state");
    if (!code || !sealedState) {
      throw Object.assign(new Error("Missing Google OAuth code or state."), { status: 400 });
    }
    const state = openOAuthState(sealedState, config.stateSecret);
    const publicURL = config.publicURL || url.origin;
    const tokens = await exchangeGoogleCode({
      clientId: requireRelayEnv(config, "googleClientId", "GOOGLE_OAUTH_CLIENT_ID is required."),
      clientSecret: requireRelayEnv(config, "googleClientSecret", "GOOGLE_OAUTH_CLIENT_SECRET is required."),
      redirectURI: `${publicURL}/api/oauth/google/callback`,
      code
    });
    return new Response(relayDeliveryPage({
      callbackURL: state.callbackURL,
      state: state.localState,
      deliveryToken: state.deliveryToken,
      payload: sealDeliveryPayload({ tokens }, state.deliveryToken)
    }), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function relayDeliveryPage({ callbackURL, state, deliveryToken, payload }) {
  return `<!doctype html>
<meta charset="utf-8">
<title>Carta Gmail connected</title>
<form method="post" action="${escapeHTML(callbackURL)}">
  <input type="hidden" name="state" value="${escapeHTML(state)}">
  <input type="hidden" name="deliveryToken" value="${escapeHTML(deliveryToken)}">
  <input type="hidden" name="payload" value="${escapeHTML(payload)}">
  <noscript><button type="submit">Return to Carta</button></noscript>
</form>
<p>Gmail connected. Returning to Carta...</p>
<script>document.forms[0].submit()</script>`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
