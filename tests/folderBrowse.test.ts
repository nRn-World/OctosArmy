import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listDrives, listSubdirectories, parentOf } from "../folderBrowse.ts";

function makeTempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test("lists folders only, sorted, with absolute paths", () => {
  const root = makeTempDir("octos-browse-");
  try {
    fs.mkdirSync(path.join(root, "gamma"));
    fs.mkdirSync(path.join(root, "alpha"));
    fs.mkdirSync(path.join(root, "beta"));
    fs.writeFileSync(path.join(root, "loose.txt"), "x");
    fs.writeFileSync(path.join(root, ".env"), "y");

    const entries = listSubdirectories(root);

    assert.deepEqual(
      entries.map((e) => e.name),
      ["alpha", "beta", "gamma"],
      "files must not be offered as folders"
    );
    assert.deepEqual(
      entries.map((e) => e.path),
      ["alpha", "beta", "gamma"].map((name) => path.join(root, name)),
      "every entry must carry the full path, so the UI can open it without guessing"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("includes a link that points at a folder", (t) => {
  const root = makeTempDir("octos-browse-");
  const target = makeTempDir("octos-browsetarget-");
  try {
    const link = path.join(root, "linked");
    try {
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      t.skip(`cannot create links in this environment: ${(e as Error).message}`);
      return;
    }
    assert.deepEqual(listSubdirectories(root).map((e) => e.name), ["linked"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("a folder that cannot be read is reported, not silently empty", () => {
  const root = makeTempDir("octos-browse-");
  try {
    const missing = path.join(root, "does-not-exist");
    assert.throws(
      () => listSubdirectories(missing),
      /Kunde inte läsa .*does-not-exist/,
      "the picker has to say which folder failed instead of showing an empty list"
    );
    // A file is not a folder either.
    const file = path.join(root, "file.txt");
    fs.writeFileSync(file, "x");
    assert.throws(() => listSubdirectories(file), /Kunde inte läsa/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parentOf walks one level up and stops at a filesystem root", () => {
  const root = makeTempDir("octos-browse-");
  try {
    const nested = path.join(root, "one", "two");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(parentOf(nested), path.join(root, "one"));
    const driveRoot = path.parse(root).root;
    assert.equal(parentOf(driveRoot), null, "there is nothing above a drive root to browse");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listDrives offers at least one browsable root and no relative paths", () => {
  const drives = listDrives();
  assert.ok(drives.length >= 1, "a machine to browse on always has at least one root");
  for (const drive of drives) {
    assert.ok(path.isAbsolute(drive.path), `${drive.path} must be absolute`);
  }
});
