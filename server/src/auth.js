import { httpError } from "./store.js";

export class RequestAuthenticator {
  constructor(config = {}) {
    this.requireAuth = config.requireAuth === true;
    this.supabaseURL = normalizeBaseURL(config.supabaseURL);
    this.supabasePublishableKey = config.supabasePublishableKey ?? "";
  }

  async authenticate(req) {
    if (!this.requireAuth) {
      return {
        id: "local",
        email: null,
        displayName: "Local Profile",
        isLocal: true
      };
    }

    if (!this.supabaseURL || !this.supabasePublishableKey) {
      throw httpError(500, "Supabase Auth is required but not configured.");
    }

    const token = bearerToken(req.headers.authorization);
    if (!token) {
      throw httpError(401, "Authentication is required.");
    }

    const response = await fetch(`${this.supabaseURL}/auth/v1/user`, {
      headers: {
        apikey: this.supabasePublishableKey,
        authorization: `Bearer ${token}`
      }
    });

    if (response.status === 401 || response.status === 403) {
      throw httpError(401, "Authentication token is invalid or expired.");
    }
    if (!response.ok) {
      throw httpError(502, "Could not verify authentication token.");
    }

    const user = await response.json();
    const email = typeof user.email === "string" ? user.email.toLowerCase() : null;
    return {
      id: requiredString(user.id, "user.id"),
      email,
      displayName: displayNameForUser(user, email)
    };
  }
}

function bearerToken(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

function displayNameForUser(user, email) {
  const metadata = user.user_metadata && typeof user.user_metadata === "object"
    ? user.user_metadata
    : {};
  return optionalString(metadata.full_name)
    || optionalString(metadata.name)
    || email
    || "User";
}

function normalizeBaseURL(value) {
  return typeof value === "string" ? value.replace(/\/+$/u, "") : "";
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw httpError(400, `${name} is required.`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
