const FAVICON_BASE_URL = "https://www.google.com/s2/favicons";
const COMMON_SECOND_LEVEL_DOMAINS = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

export function senderLogoURLForEmail(email, { size = 128 } = {}) {
  const domain = logoDomainForEmail(email);
  if (!domain) return null;

  const params = new URLSearchParams({
    domain,
    sz: String(size)
  });
  return `${FAVICON_BASE_URL}?${params}`;
}

export function logoDomainForEmail(value) {
  const email = extractEmailAddress(value);
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return null;

  const domain = email.slice(atIndex + 1).toLowerCase().replace(/\.$/, "");
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2 || labels.some(label => !isValidDomainLabel(label))) {
    return null;
  }

  const tld = labels.at(-1);
  const secondLevel = labels.at(-2);
  if (tld?.length === 2 && COMMON_SECOND_LEVEL_DOMAINS.has(secondLevel) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

function extractEmailAddress(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const match = trimmed.match(/<([^<>@\s]+@[^<>\s]+)>/);
  return (match?.[1] ?? trimmed).replace(/^mailto:/i, "").trim();
}

function isValidDomainLabel(label) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}
