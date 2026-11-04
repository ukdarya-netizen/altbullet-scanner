const TOKEN_KEY = "authToken";
const ADMIN_TOKEN_KEY = "adminToken";
export const ACCESS_REVOKED_EVENT = "dashboard-access-revoked";

const PUBLIC_BROWSER_API_ROUTES = new Set([
  "POST /api/bootstrap-errors",
  "POST /api/auth/register",
  "POST /api/auth/login",
  "POST /api/auth/reset-confirm",
  "POST /api/admin/verify-pin",
]);

let installed = false;

function readAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function clearStoredSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Restricted storage already behaves like a logged-out session.
  }
}

function resolveRequest(input: RequestInfo | URL, init?: RequestInit) {
  const inputRequest = input instanceof Request ? input : null;
  const url = new URL(
    inputRequest?.url ?? String(input),
    window.location.origin,
  );
  const method = (init?.method ?? inputRequest?.method ?? "GET").toUpperCase();
  return { inputRequest, url, method };
}

function revokeDashboardAccess(): void {
  clearStoredSession();
  window.dispatchEvent(new Event(ACCESS_REVOKED_EVENT));
}

export function installAuthenticatedFetch(): void {
  if (installed) return;
  installed = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { inputRequest, url, method } = resolveRequest(input, init);
    const isApiRequest =
      url.origin === window.location.origin && url.pathname.startsWith("/api/");
    const isPublicRequest = PUBLIC_BROWSER_API_ROUTES.has(
      `${method} ${url.pathname}`,
    );
    const headers = new Headers(inputRequest?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));

    if (
      isApiRequest &&
      !isPublicRequest &&
      !headers.has("Authorization") &&
      !headers.has("X-Admin-Token")
    ) {
      const token = readAuthToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await nativeFetch(input, { ...init, headers });
    if (
      isApiRequest &&
      !isPublicRequest &&
      (response.status === 401 || response.status === 403)
    ) {
      revokeDashboardAccess();
    }
    return response;
  };
}
