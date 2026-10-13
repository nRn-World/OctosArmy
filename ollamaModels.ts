/**
 * OctosArmy runs Gemma 4 and nothing else.
 *
 * The model selector used to offer Deepseek and Qwen as well, which meant a user could pick a
 * 32B reasoning model that produced 1-2 tokens per second on this hardware and made every
 * mission look broken. Only the Gemma 4 family is accepted now; anything else is refused by
 * the API and falls back to the default model instead of being silently run.
 *
 * The rules live here, in one place, so the UI, the API and the tests cannot drift apart.
 */

/** Every accepted model name is this family, optionally followed by a tag (`gemma4:e4b`). */
export const GEMMA_FAMILY = "gemma4";

/** The model the app runs after a reset or on a fresh install. */
export const DEFAULT_OLLAMA_MODEL = "gemma4:e4b";

/** Ollama names are lowercase and may carry one tag: `gemma4:e4b`, `gemma4:latest`. */
const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$/;

/** Trim and lowercase an incoming name so comparisons are exact and case-insensitive. */
export function normalizeOllamaModel(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** True only for a well-formed Gemma 4 name: `gemma4`, `gemma4:e4b`, `gemma4:12b-qat`. */
export function isGemmaModel(raw: unknown): boolean {
  const name = normalizeOllamaModel(raw);
  if (!MODEL_NAME_PATTERN.test(name)) return false;
  return name === GEMMA_FAMILY || name.startsWith(`${GEMMA_FAMILY}:`);
}

/**
 * The model to actually run: the requested Gemma 4 model, or the default when the request is
 * empty, malformed, or a model from another family. Never returns an unsupported model.
 */
export function resolveOllamaModel(raw: unknown): string {
  return isGemmaModel(raw) ? normalizeOllamaModel(raw) : DEFAULT_OLLAMA_MODEL;
}

/**
 * The Gemma 4 models actually installed in Ollama, deduped and sorted, default first.
 * `names` is whatever `/api/tags` reported; anything else in there is dropped.
 */
export function gemmaModelsFromInstalled(names: unknown): string[] {
  const list = Array.isArray(names) ? names : [];
  const gemma = list
    .map((name) => normalizeOllamaModel(name))
    .filter((name) => isGemmaModel(name));
  const unique = Array.from(new Set(gemma)).sort();
  return unique.sort((a, b) => {
    if (a === DEFAULT_OLLAMA_MODEL) return -1;
    if (b === DEFAULT_OLLAMA_MODEL) return 1;
    return a.localeCompare(b);
  });
}
