const DEFAULT_ENDPOINT = window.location.origin;
const TOKEN_KEY = "ELECTRON_MCP_TOKEN";
const ENDPOINT_KEY = "ELECTRON_MCP_ENDPOINT";

function normalizeEndpoint(endpoint: string) {
  return endpoint.replace(/\/+$/, "");
}

function buildUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getEndpoint()}${normalizedPath}`;
}

async function readResponsePayload(response: Response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (payload && typeof payload === "object") {
    const candidate =
      (payload as { error?: string }).error ||
      (payload as { message?: string }).message ||
      (payload as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text;

    if (candidate) return candidate;
  }
  return fallback;
}

export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const removeToken = () => localStorage.removeItem(TOKEN_KEY);

export const getEndpoint = () => normalizeEndpoint(localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT);
export const setEndpoint = (endpoint: string) => localStorage.setItem(ENDPOINT_KEY, normalizeEndpoint(endpoint));

export async function authorizedFetch(path: string, init: RequestInit = {}) {
  const token = getToken();
  const endpoint = getEndpoint();

  try {
    const response = await fetch(buildUrl(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });

    if (response.status === 401) {
      removeToken();
      throw new Error("Unauthorized");
    }

    return response;
  } catch (error) {
    if (error instanceof TypeError && error.message === "Failed to fetch") {
      throw new Error(`Cannot connect to ${endpoint}. Check network access, CORS, or the endpoint value.`);
    }
    throw error;
  }
}

export async function requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authorizedFetch(path, init);
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `${path} → ${response.status}`));
  }

  return payload as T;
}

export async function rpc(tool: string, args: Record<string, unknown> = {}) {
  return authorizedFetch(`/rpc/${tool}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
}

export async function rpcJson<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await rpc(tool, args);
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `rpc/${tool} → ${response.status}`));
  }

  if (
    payload &&
    typeof payload === "object" &&
    (payload as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text
  ) {
    return JSON.parse((payload as { result: { content: Array<{ text: string }> } }).result.content[0].text);
  }

  return payload as T;
}

export function getSnapshotUrl(winId: number, quality: number, scale: number) {
  return `${buildUrl("/ui/snapshot")}?win_id=${winId}&quality=${quality}&scale=${scale}&token=${encodeURIComponent(getToken())}`;
}
