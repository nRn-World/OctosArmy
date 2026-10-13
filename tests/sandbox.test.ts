import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isSandboxRoot,
  resolveWithRealAncestor,
  validateSandboxPath,
} from "../ollamaAgent.ts";

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync.native(dir);
}

test("allows a path inside the granted root", () => {
  const root = makeTempDir("octos-root-");
  const target = path.join(root, "notes", "todo.txt");
  assert.equal(validateSandboxPath([root], target), target);
});

test("allows a path that does not exist yet (files we are about to create)", () => {
  const root = makeTempDir("octos-root-");
  const target = path.join(root, "new", "sub", "file.txt");
  assert.equal(validateSandboxPath([root], target), target);
});

test("rejects traversal back out of the root", () => {
  const root = makeTempDir("octos-root-");
  assert.throws(
    () => validateSandboxPath([root], path.join(root, "..", "escaped.txt")),
    /outside allowed sandbox roots/i
  );
});

test("rejects an absolute path outside every root", () => {
  const root = makeTempDir("octos-root-");
  const outside = path.join(os.tmpdir(), "certainly-not-granted.txt");
  assert.throws(() => validateSandboxPath([root], outside), /outside allowed sandbox roots/i);
});

test("rejects a sibling directory that merely shares the root's prefix", () => {
  const root = makeTempDir("octos-root-");
  const sibling = `${root}-evil`;
  fs.mkdirSync(sibling, { recursive: true });
  try {
    assert.throws(() => validateSandboxPath([root], sibling), /outside allowed sandbox roots/i);
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("rejects a symlink inside the root that points outside of it", (t) => {
  const root = makeTempDir("octos-root-");
  const outside = makeTempDir("octos-outside-");
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "top secret");

  const link = path.join(root, "sneaky");
  try {
    // "junction" works on Windows without elevated privileges; elsewhere a plain dir link.
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    t.skip(`cannot create links in this environment: ${(e as Error).message}`);
    return;
  }

  assert.throws(
    () => validateSandboxPath([root], path.join(link, "secret.txt")),
    /outside allowed sandbox roots/i
  );
  fs.rmSync(outside, { recursive: true, force: true });
});

test("rejects a symlinked root that resolves elsewhere", (t) => {
  const realRoot = makeTempDir("octos-real-");
  const other = makeTempDir("octos-other-");
  const linkedRoot = path.join(makeTempDir("octos-link-"), "root");

  try {
    fs.symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    t.skip(`cannot create links in this environment: ${(e as Error).message}`);
    return;
  }

  // The granted root is a link to realRoot, so realRoot is fine but `other` is not.
  assert.ok(validateSandboxPath([linkedRoot], path.join(realRoot, "ok.txt")));
  assert.throws(
    () => validateSandboxPath([linkedRoot], path.join(other, "nope.txt")),
    /outside allowed sandbox roots/i
  );
  fs.rmSync(other, { recursive: true, force: true });
});

test("recognises the sandbox root itself", () => {
  const root = makeTempDir("octos-root-");
  assert.equal(isSandboxRoot([root], root), true);
  assert.equal(isSandboxRoot([root], path.join(root, "child")), false);
});

test("resolveWithRealAncestor resolves links and keeps the missing tail", (t) => {
  const root = makeTempDir("octos-root-");
  const link = path.join(makeTempDir("octos-linkparent-"), "alias");
  try {
    fs.symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    t.skip(`cannot create links in this environment: ${(e as Error).message}`);
    return;
  }
  assert.equal(resolveWithRealAncestor(path.join(link, "a", "b.txt")), path.join(root, "a", "b.txt"));
});
