const DEFAULT_ENDPOINT = window.location.origin;
const TOKEN_KEY = "ELECTRON_MCP_TOKEN";
const ENDPOINT_KEY = "ELECTRON_MCP_ENDPOINT";

export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const removeToken = () => localStorage.removeItem(TOKEN_KEY);

export const getEndpoint = () => (localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT).replace(/\/+$/, '');
export const setEndpoint = (endpoint: string) => localStorage.setItem(ENDPOINT_KEY, endpoint.replace(/\/+$/, ''));

export async function rpc(tool: string, args: Record<string, any> = {}) {
  const token = getToken();
  const endpoint = getEndpoint();
  try {
    const res = await fetch(`${endpoint}/rpc/${tool}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });

    if (res.status === 401) {
      removeToken();
      throw new Error("Unauthorized");
    }

    return res;
  } catch (err) {
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      throw new Error(`Cannot connect to ${endpoint}. Check CORS or network.`);
    }
    throw err;
  }
}

export async function rpcJson<T = any>(tool: string, args: Record<string, any> = {}): Promise<T> {
  const res = await rpc(tool, args);
  if (!res.ok) {
    throw new Error(`rpc/${tool} → ${res.status}`);
  }
  const data = await res.json();
  if (data.result?.content?.[0]?.text) {
    return JSON.parse(data.result.content[0].text);
  }
  return data as T;
}

export function getSnapshotUrl(winId: number, quality: number, scale: number) {
  const token = getToken();
  const endpoint = getEndpoint();
  return `${endpoint}/ui/snapshot?win_id=${winId}&quality=${quality}&scale=${scale}&token=${encodeURIComponent(token)}`;
}
