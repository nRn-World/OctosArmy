import fs from "fs";
import os from "os";
import path from "path";

/**
 * Folder browsing for the web UI.
 *
 * The native folder dialog only exists inside the Electron shell, so in a browser tab the UI
 * had nothing to offer but "type the path yourself" — which looked exactly like a dead
 * button. The backend already runs on the user's machine, so the UI asks it for the folder
 * tree instead and the picker works in both shells.
 *
 * This module only ever lists directory *names*; files are neither listed nor opened here.
 */

export type BrowseEntry = { name: string; path: string };

/** A folder with more subfolders than this is not useful to click through in a list. */
const MAX_BROWSE_ENTRIES = 1000;

function isDirectorySafe(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    // Unreadable or gone between readdir and stat: not something to offer.
    return false;
  }
}

/**
 * Filesystem roots to start from: the drives on Windows, "/" elsewhere.
 * Callers get an empty list only on a machine with no readable drive at all.
 */
export function listDrives(): BrowseEntry[] {
  if (process.platform !== "win32") {
    return [{ name: "/", path: path.parse(process.cwd()).root || "/" }];
  }
  const drives: BrowseEntry[] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (isDirectorySafe(root)) drives.push({ name: root, path: root });
  }
  return drives;
}

/** The folder above `dir`, or null when `dir` already is a filesystem root. */
export function parentOf(dir: string): string | null {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  return parent === resolved ? null : parent;
}

/**
 * Subfolders of `dir`, sorted by name. Symbolic links and junctions that point at a folder
 * are included, because that is how half of a real disk is organised.
 * Throws a readable error when the folder is missing or unreadable, so the UI can say which.
 */
export function listSubdirectories(dir: string): BrowseEntry[] {
  const resolved = path.resolve(dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (e: any) {
    throw new Error(`Kunde inte läsa ${resolved} (${e?.code || e?.message || "okänt fel"})`);
  }

  return entries
    .map((entry) => ({ entry, full: path.join(resolved, entry.name) }))
    .filter(({ entry, full }) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectorySafe(full)))
    .map(({ entry, full }) => ({ name: entry.name, path: full }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"))
    .slice(0, MAX_BROWSE_ENTRIES);
}

/** Where the picker opens when the user wants a familiar starting point. */
export function homeDirectory(): string {
  return os.homedir();
}
