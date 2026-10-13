import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OLLAMA_MODEL,
  gemmaModelsFromInstalled,
  isGemmaModel,
  normalizeOllamaModel,
  resolveOllamaModel,
} from "../ollamaModels.ts";

test("only the Gemma 4 family is accepted", () => {
  for (const name of ["gemma4:e4b", "gemma4", "gemma4:12b", "GEMMA4:E4B", " gemma4:e4b "]) {
    assert.equal(isGemmaModel(name), true, `${name} must be accepted`);
  }
  for (const name of ["deepseek-r1:14b", "qwen2.5-coder:32b", "gemma2:9b", "gemma3n:e4b"]) {
    assert.equal(isGemmaModel(name), false, `${name} must be refused`);
  }
});

test("a lookalike or malformed name is not a Gemma 4 model", () => {
  for (const name of ["gemma4x:e4b", "gemma40:e4b", "notgemma4:e4b", "gemma4:", "gemma4:/../x", ""]) {
    assert.equal(isGemmaModel(name as unknown), false, `${JSON.stringify(name)} must be refused`);
  }
  for (const name of [undefined, null, 42, { model: "gemma4:e4b" }, ["gemma4:e4b"]]) {
    assert.equal(isGemmaModel(name as unknown), false, `${JSON.stringify(name)} must be refused`);
  }
});

test("a refused model falls back to the default instead of running", () => {
  assert.equal(resolveOllamaModel("deepseek-r1:14b"), DEFAULT_OLLAMA_MODEL);
  assert.equal(resolveOllamaModel(""), DEFAULT_OLLAMA_MODEL);
  assert.equal(resolveOllamaModel(undefined), DEFAULT_OLLAMA_MODEL);
  assert.equal(resolveOllamaModel("GEMMA4:12B"), "gemma4:12b");
  assert.equal(normalizeOllamaModel("  Gemma4:E4b "), "gemma4:e4b");
});

test("the installed list is filtered to Gemma 4 and starts with the default", () => {
  const installed = ["qwen2.5-coder:32b", "gemma4:12b", "deepseek-r1:14b", "gemma4:e4b", "gemma4:e4b"];
  assert.deepEqual(gemmaModelsFromInstalled(installed), ["gemma4:e4b", "gemma4:12b"]);
  assert.deepEqual(gemmaModelsFromInstalled(["deepseek-r1:14b"]), []);
  assert.deepEqual(gemmaModelsFromInstalled(undefined), []);
});
