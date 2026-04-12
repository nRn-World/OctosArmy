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
