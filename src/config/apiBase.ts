/**
 * Build absolute URL for Express API calls.
 *
 * - Same origin (e.g. npm run dev → http://localhost:3000): use relative "/api/...".
 * - UI on Vite default ports (5173, 5174, 4173): assume API on same host:3000.
 * - Override anytime: VITE_API_BASE_URL=http://localhost:3000
 */
export function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;

  const explicit = (import.meta.env.VITE_API_BASE_URL as string | undefined)
    ?.trim()
    .replace(/\/$/, "");
  if (explicit) {
    return `${explicit}${normalized}`;
  }

  if (typeof window !== "undefined") {
    const port = window.location.port;
    const vitePorts = new Set(["5173", "5174", "4173"]);
    if (vitePorts.has(port) || window.location.protocol === "file:") {
      return `http://127.0.0.1:3000${normalized}`;
    }
  }

  return normalized;
}
