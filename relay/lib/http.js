export function json(data, status = 200) {
  return Response.json(data, { status });
}

export function errorResponse(error) {
  const status = Number(error?.status || 500);
  return json({ error: error?.message || "Relay request failed." }, status);
}

export function requireBearer(request, token) {
  if (!token) return;
  const header = request.headers.get("authorization") || "";
  if (header !== `Bearer ${token}`) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
}

export async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}
