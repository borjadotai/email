const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.send"
];

export function googleAuthorizationURL({ clientId, redirectURI, state, scopes = GMAIL_SCOPES }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectURI);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoogleCode({ clientId, clientSecret, redirectURI, code }) {
  return tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectURI,
    code,
    grant_type: "authorization_code"
  });
}

export async function refreshGoogleAccessToken({ clientId, clientSecret, refreshToken }) {
  const tokens = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  return {
    accessToken: tokens.access_token,
    expiryDate: Date.now() + Number(tokens.expires_in || 3300) * 1000
  };
}

async function tokenRequest(body) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error_description || payload?.error || `Google OAuth failed with HTTP ${response.status}`), {
      status: 502
    });
  }
  return payload;
}
