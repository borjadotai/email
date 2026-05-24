const sensitiveKeyPattern = /authorization|code_verifier|password|secret|(^|[_-])token($|[_-])|token$/iu;

export function operationalInfo(event, fields = {}) {
  writeOperationalLog("info", event, fields);
}

export function operationalWarn(event, fields = {}) {
  writeOperationalLog("warn", event, fields);
}

export function operationalError(event, fields = {}) {
  writeOperationalLog("error", event, fields);
}

export function writeOperationalLog(level, event, fields = {}) {
  const entry = operationalLogEntry(level, event, fields);
  const line = `email_operational ${JSON.stringify(entry)}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
  return entry;
}

export function operationalLogEntry(level, event, fields = {}) {
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitize(fields)
  };
}

export function errorContext(error) {
  const status = error?.status ?? error?.response?.status ?? error?.code;
  const reason = error?.reason ?? error?.errors?.[0]?.reason ?? error?.response?.data?.error;
  return sanitize({
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    status,
    reason,
    tokenRefreshFailure: isTokenRefreshFailure(error) || undefined
  });
}

export function isTokenRefreshFailure(error) {
  const values = [
    error?.code,
    error?.status,
    error?.reason,
    error?.message,
    error?.response?.data?.error,
    error?.response?.data?.error_description
  ].map(value => String(value ?? "").toLowerCase());
  return values.some(value =>
    value.includes("invalid_grant") ||
    value.includes("invalid refresh") ||
    value.includes("refresh token") ||
    value.includes("token has been expired") ||
    value.includes("token has been revoked")
  );
}

function sanitize(value, key = "") {
  if (sensitiveKeyPattern.test(key)) return "[redacted]";
  if (value instanceof Error) return errorContext(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([itemKey, itemValue]) => [itemKey, sanitize(itemValue, itemKey)]));
  }
  if (typeof value === "string") return value.slice(0, 500);
  return value;
}
