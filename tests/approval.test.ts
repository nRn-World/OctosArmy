import assert from "node:assert/strict";
import test from "node:test";

import { requiresApproval } from "../ollamaAgent.ts";

test("destructive intents always need approval, whatever the model claims", () => {
  for (const intent of ["delete_path", "empty_dir", "move_path", "bulk_move", "run_terminal"]) {
    assert.equal(requiresApproval(intent, "low"), true, `${intent} must be gated even at risk_level=low`);
    assert.equal(requiresApproval(intent, "medium"), true, `${intent} must be gated at risk_level=medium`);
    assert.equal(requiresApproval(intent, "high"), true, `${intent} must be gated at risk_level=high`);
  }
});

test("read-only intents run without approval at low risk", () => {
  for (const intent of ["read_file", "list_dir", "search_files", "copy_path", "bulk_copy", "done", "ask_user"]) {
    assert.equal(requiresApproval(intent, "low"), false, `${intent} should not need approval at low risk`);
  }
});

test("anything the model rates high risk needs approval", () => {
  assert.equal(requiresApproval("read_file", "high"), true);
  assert.equal(requiresApproval("copy_path", "high"), true);
});
