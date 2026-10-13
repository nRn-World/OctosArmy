declare global {
  interface Window {
    /** Injected by the backend's own HTML (or by the Vite dev plugin). */
    __OCTOS_TOKEN__?: string;
  }
}

/**
 * Fetch wrapper for the local backend.
 *
 * The backend only answers requests carrying the session token it generated for this
 * start, so every API call has to go through here. A page from any other origin can never
 * read that token, which is what keeps the local API from being usable by random websites.
 */
let reloadedForStaleToken = false;

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const token = typeof window !== "undefined" ? window.__OCTOS_TOKEN__ : undefined;
  if (token && !headers.has("x-octos-token")) {
    headers.set("x-octos-token", token);
  }
  const res = await fetch(input, { ...init, headers });

  // 401 means this page holds a token from a previous backend start. Reloading picks up
  // the current one. Guarded to run once per page, so it can never turn into a reload loop.
  if (res.status === 401 && typeof window !== "undefined" && !reloadedForStaleToken) {
    reloadedForStaleToken = true;
    window.location.reload();
  }
  return res;
}

/** Parse fetch Response as JSON; clear errors if body is empty or HTML. */
export async function parseJsonResponse<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text || !text.trim()) {
    throw new Error(
      `Empty response (HTTP ${res.status}). Start the API: "npm run dev" (opens http://localhost:3000) or run "npx tsx server.ts" on port 3000 while the UI is on Vite. Set VITE_API_BASE_URL=http://localhost:3000 if the preview uses another origin.`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(
      `Expected JSON but got HTTP ${res.status}: ${preview}${text.length > 160 ? "…" : ""}`
    );
  }
}
