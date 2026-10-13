import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { runOllamaAgentLoop, validateSandboxPath } from "./ollamaAgent.ts";
import {
  DEFAULT_OLLAMA_MODEL,
  gemmaModelsFromInstalled,
  isGemmaModel,
  resolveOllamaModel,
} from "./ollamaModels.ts";
import { homeDirectory, listDrives, listSubdirectories, parentOf } from "./folderBrowse.ts";
import os from "os";
import cron from "node-cron";

dotenv.config();

// In CJS mode (bundled by esbuild), __dirname and __filename are already available.
// We use a safe check to satisfy both tsx (Esm) and build (Cjs).
const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// Use AppData for persistence in packaged mode to avoid permission issues
const appDataDir = path.join(os.homedir(), "AppData", "Roaming", "OctosArmy");
const configDir = path.join(appDataDir, "config");
const rootsFile = path.join(configDir, "roots.json");
const scheduleFile = path.join(configDir, "schedule.json");
const ollamaFile = path.join(configDir, "ollama.json");
const sessionTokenFile = path.join(configDir, "session.token");

function ensureDir(p: string) {
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  } catch (e) {
    console.error(`Permission error creating ${p}:`, e);
  }
}

ensureDir(appDataDir);
ensureDir(configDir);

// --- Network surface -----------------------------------------------------------------
// The API can read, write and delete files in folders the user explicitly granted, so it
// must only ever answer requests that originate from this machine AND from a page we serve.
const PORT = Number(process.env.OCTOS_PORT || 3000);
const HOST = "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";

const LOOPBACK_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const SELF_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://[::1]:${PORT}`,
]);

// The Vite dev server (npm run vite) proxies /api to us and serves the UI on its own port.
// Only tolerated outside production builds.
if (!isProduction) {
  for (const p of ["5173", "5174", "4173"]) {
    LOOPBACK_HOSTS.add(`127.0.0.1:${p}`);
    LOOPBACK_HOSTS.add(`localhost:${p}`);
    SELF_ORIGINS.add(`http://127.0.0.1:${p}`);
    SELF_ORIGINS.add(`http://localhost:${p}`);
  }
}

// A fresh token every start. It is injected into the HTML we serve (same origin only),
// so a foreign website can never learn it. Local attackers are out of scope: a local
// process can already read these files directly.
const SESSION_TOKEN = crypto.randomBytes(32).toString("hex");
try {
  fs.writeFileSync(sessionTokenFile, SESSION_TOKEN, { mode: 0o600 });
} catch (e) {
  console.error("Could not persist session token (Vite dev mode will not get one):", e);
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- Sandbox path validation ---------------------------------------------------------
// Single source of truth: the same realpath-aware validator the agent tool loop uses,
// covered by tests/sandbox.test.ts. Duplicating this logic here is how the symlink escape
// happened in the first place.
function validatePath(targetPath: string): string {
  if (!targetPath) throw new Error("Path required");
  return validateSandboxPath(activeWorkspaceRoots, targetPath);
}

// --- Global state --------------------------------------------------------------------
let activeWorkspaceRoots: string[] = [path.join(appDataDir, "workspace")];
let scheduledCronExpr: string | null = null;
let scheduledMission: string | null = null;
let cronTask: ReturnType<typeof cron.schedule> | null = null;
let scheduledRunInProgress = false;
let currentRunAbort: AbortController | null = null;
let currentRunInProgress = false;
// Gemma 4 is the only model family this app runs; see ollamaModels.ts for the rules.
type AllowedOllamaModel = string;
const AGENT_IDS = ["scout", "brainstormer", "coder", "reviewer", "auditor", "security"] as const;
const MAX_WORKSPACE_ROOTS = 10;

/** The model a fresh install starts with: the environment's choice if it is a Gemma 4 one. */
function defaultOllamaModel(): AllowedOllamaModel {
  return resolveOllamaModel(process.env.OLLAMA_MODEL);
}

let selectedOllamaModel: AllowedOllamaModel = defaultOllamaModel();

function ollamaBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
}

/**
 * Ask Ollama which models are installed. Returns null (not an empty list) when it cannot be
 * reached, so the caller can tell "Ollama is down" from "nothing is pulled". The timeout keeps
 * a wedged Ollama from holding the request open.
 */
async function installedOllamaModels(): Promise<string[] | null> {
  try {
    const r = await fetch(`${ollamaBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data: any = await r.json();
    return Array.isArray(data?.models)
      ? data.models.map((m: any) => String(m?.name || "").trim()).filter(Boolean)
      : [];
  } catch (e: any) {
    console.error("Could not list Ollama models:", e?.message || e);
    return null;
  }
}

function loadRoots() {
  if (!fs.existsSync(rootsFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(rootsFile, "utf-8"));
    if (!Array.isArray(raw)) throw new Error("roots.json is not an array");
    const roots = raw.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
    if (roots.length) activeWorkspaceRoots = roots;
  } catch (e) {
    console.error("Could not read roots.json, keeping defaults:", e);
  }
}
loadRoots();

let agentLogs: any[] = [];
const MAX_LOG_ENTRIES = 1000;
const MAX_LOG_MESSAGE_CHARS = 4000;

function pushLog(entry: any) {
  agentLogs.push(entry);
  if (agentLogs.length > MAX_LOG_ENTRIES) agentLogs = agentLogs.slice(-MAX_LOG_ENTRIES);
}

function loadSchedule() {
  if (!fs.existsSync(scheduleFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(scheduleFile, "utf-8"));
    const cronExpr = typeof raw?.cronExpr === "string" ? raw.cronExpr.trim() : "";
    const mission = typeof raw?.mission === "string" ? raw.mission.trim() : "";
    scheduledCronExpr = cronExpr || null;
    scheduledMission = mission || null;
  } catch (e) {
    console.error("Could not read schedule.json:", e);
  }
}

function persistSchedule() {
  try {
    fs.writeFileSync(
      scheduleFile,
      JSON.stringify(
        {
          cronExpr: scheduledCronExpr,
          mission: scheduledMission,
        },
        null,
        2
      )
    );
  } catch (e) {
    console.error("Could not persist schedule.json:", e);
  }
}

function loadOllamaModel() {
  if (!fs.existsSync(ollamaFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(ollamaFile, "utf-8"));
    const model = typeof raw?.model === "string" ? raw.model.trim().toLowerCase() : "";
    // A model saved by an older version (Deepseek, Qwen) is ignored, not run.
    if (isGemmaModel(model)) {
      selectedOllamaModel = model as AllowedOllamaModel;
    }
  } catch (e) {
    console.error("Could not read ollama.json:", e);
  }
}

function persistOllamaModel() {
  try {
    fs.writeFileSync(ollamaFile, JSON.stringify({ model: selectedOllamaModel }, null, 2));
  } catch (e) {
    console.error("Could not persist ollama.json:", e);
  }
}

// --- Destructive-intent approval queue ------------------------------------------------
type PendingApproval = {
  id: string;
  intent: string;
  detail: string;
  riskLevel: string;
  /** Settles the waiting run and releases the slot. Idempotent. */
  settle: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

let pendingApproval: PendingApproval | null = null;
const APPROVAL_TIMEOUT_MS = 180_000;

/**
 * Ask the human before anything destructive or code-executing runs.
 * If the UI is not there to answer (scheduled runs, headless API use) the request is
 * denied — failing closed is the only safe default for unattended runs.
 */
function requestApproval(info: { intent: string; detail: string; riskLevel: string }): Promise<boolean> {
  if (pendingApproval) {
    // Never queue up destructive actions behind each other.
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const id = crypto.randomUUID();
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      const entry = pendingApproval;
      if (entry && entry.id === id) {
        clearTimeout(entry.timer);
        pendingApproval = null;
      }
      resolve(approved);
    };
    const timer = setTimeout(() => {
      pushLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Approval for "${info.detail}" timed out and was denied.`,
        type: "warning",
      });
      settle(false);
    }, APPROVAL_TIMEOUT_MS);
    pendingApproval = {
      id,
      intent: info.intent,
      detail: info.detail,
      riskLevel: info.riskLevel,
      settle,
      timer,
    };
  });
}

function setCronTask(expr: string | null) {
  if (cronTask) {
    try {
      cronTask.stop();
    } catch (e) {
      console.error("Could not stop previous cron task:", e);
    }
    cronTask = null;
  }

  if (!expr) return;
  if (!cron.validate(expr)) return;

  cronTask = cron.schedule(expr, async () => {
    if (currentRunInProgress) return;
    if (scheduledRunInProgress) return;
    if (!scheduledMission || !scheduledMission.trim()) return;

    scheduledRunInProgress = true;
    currentRunInProgress = true;
    currentRunAbort = new AbortController();
    try {
      loadRoots();
      const summary = await runOllamaAgentLoop({
        ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
        ollamaModel: selectedOllamaModel,
        sandboxRoots: activeWorkspaceRoots,
        mission: scheduledMission,
        maxSteps: 200,
        terminalTimeoutSec: 60,
        maxTerminalOutputChars: 50_000,
        abortSignal: currentRunAbort.signal,
        // No UI is attached to a scheduled run: destructive intents are denied.
        requestApproval: async () => false,
        onLog: (log: any) => pushLog(log),
      } as any);
      pushLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Scheduled run complete. Summary: ${String(summary).slice(0, 800)}`,
        type: "success",
      });
    } catch (e: any) {
      pushLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Scheduled run failed: ${e.message || String(e)}`,
        type: "error",
      });
    } finally {
      scheduledRunInProgress = false;
      currentRunInProgress = false;
      currentRunAbort = null;
    }
  });
}

// --- Workspace listing ---------------------------------------------------------------
const SLOW_DIRS = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", "__pycache__"]);
const MAX_LISTED_ENTRIES = 3000;
const MAX_LISTED_DEPTH = 6;

function listWorkspaceEntries(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number, prefix: string) => {
    if (results.length >= MAX_LISTED_ENTRIES || depth > MAX_LISTED_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.error(`Could not list ${dir}:`, e);
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_LISTED_ENTRIES) return;
      if (entry.isDirectory() && SLOW_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      results.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1, rel);
    }
  };
  walk(root, 0, "");
  return results;
}

// --- Server --------------------------------------------------------------------------
async function startServer() {
  const app = express();
  app.disable("x-powered-by");

  // Requests are only accepted from a loopback Host (defeats DNS rebinding, where a
  // foreign page resolves its own hostname to 127.0.0.1) and from an origin we serve.
  app.use((req, res, next) => {
    const host = String(req.headers.host || "").toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
      return res.status(403).json({ error: "Forbidden: unexpected Host header" });
    }
    const origin = req.headers.origin;
    if (origin && !SELF_ORIGINS.has(String(origin).toLowerCase())) {
      return res.status(403).json({ error: "Forbidden: cross-origin request rejected" });
    }
    next();
  });

  app.use(express.json({ limit: "256kb" }));

  // Liveness probe: must stay outside the token gate so the Electron shell (and any
  // supervisor) can wait for readiness before loading the UI.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Everything under /api needs the per-start session token, and every state-changing
  // call must be JSON (which browsers can only send after a preflight we never approve).
  app.use("/api", (req, res, next) => {
    const token = req.get("x-octos-token");
    if (!token || !constantTimeEquals(token, SESSION_TOKEN)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json")) {
      return res.status(415).json({ error: "Content-Type must be application/json" });
    }
    next();
  });

  // Initialize
  activeWorkspaceRoots.forEach(ensureDir);

  // --- API ---

  app.get("/api/workspace/roots", (_req, res) => {
    res.json({ roots: activeWorkspaceRoots });
  });

  app.post("/api/workspace/roots", (req, res) => {
    try {
      const { roots } = req.body;
      if (!Array.isArray(roots)) return res.status(400).json({ error: "Invalid roots" });

      const cleaned = roots
        .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
        .slice(0, MAX_WORKSPACE_ROOTS)
        .map((r) => {
          const resolved = path.resolve(r.trim().replace(/[\\/]+$/, ""));
          ensureDir(resolved);
          return resolved;
        });

      activeWorkspaceRoots = Array.from(new Set(cleaned));

      try {
        fs.writeFileSync(rootsFile, JSON.stringify(activeWorkspaceRoots, null, 2));
      } catch (e) {
        console.error("Could not persist roots.json:", e);
      }

      res.json({ roots: activeWorkspaceRoots });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/workspace", (_req, res) => {
    try {
      const allFiles = activeWorkspaceRoots.map((root) => {
        const resolved = path.resolve(root);
        const files = fs.existsSync(resolved) ? listWorkspaceEntries(resolved) : [];
        return { root: resolved, files };
      });
      res.json({ workspaces: allFiles });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/logs", (_req, res) => res.json(agentLogs));

  app.post("/api/logs", (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid log entry" });
      const message = typeof body.message === "string" ? body.message.slice(0, MAX_LOG_MESSAGE_CHARS) : "";
      pushLog({
        timestamp: typeof body.timestamp === "string" ? body.timestamp : new Date().toISOString(),
        agent: typeof body.agent === "string" ? body.agent.slice(0, 64) : "System",
        message,
        type: typeof body.type === "string" ? body.type : "info",
      });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/logs/clear", (_req, res) => {
    agentLogs = [];
    res.json({ success: true });
  });

  /**
   * Back to a clean slate: stop whatever is running, then forget the log, the schedule, the
   * granted folders and the model choice. Only what the app has been *told* is cleared —
   * not a single file on disk is touched, so the folders stay exactly as they were.
   */
  app.post("/api/reset", (_req, res) => {
    try {
      if (currentRunAbort) {
        try {
          currentRunAbort.abort();
        } catch (e) {
          console.error("Could not abort the run being reset:", e);
        }
      }
      // A run parked on an approval would otherwise hold the slot until it times out.
      if (pendingApproval) pendingApproval.settle(false);

      agentLogs = [];

      scheduledCronExpr = null;
      scheduledMission = null;
      persistSchedule();
      setCronTask(null);

      activeWorkspaceRoots = [];
      try {
        fs.writeFileSync(rootsFile, JSON.stringify(activeWorkspaceRoots, null, 2));
      } catch (e) {
        console.error("Could not persist roots.json while resetting:", e);
      }

      selectedOllamaModel = defaultOllamaModel();
      persistOllamaModel();

      pushLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message:
          "Programmet nollställt: logg, uppdrag, schema, mappbehörigheter och modellval är rensade. Inga filer på disken rördes.",
        type: "success",
      });

      return res.json({
        ok: true,
        roots: activeWorkspaceRoots,
        model: selectedOllamaModel,
        cronExpr: scheduledCronExpr,
        mission: scheduledMission,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- Approval of destructive agent intents ---

  app.get("/api/approvals/pending", (_req, res) => {
    res.json({
      pending: pendingApproval
        ? {
            id: pendingApproval.id,
            intent: pendingApproval.intent,
            detail: pendingApproval.detail,
            riskLevel: pendingApproval.riskLevel,
          }
        : null,
    });
  });

  app.post("/api/approvals/respond", (req, res) => {
    const { id, approved } = req.body || {};
    const entry = pendingApproval;
    if (!entry || String(id) !== entry.id) {
      return res.status(404).json({ error: "No matching pending approval" });
    }
    // Releases the slot immediately, so the next destructive intent can be asked about.
    entry.settle(approved === true);
    return res.json({ ok: true });
  });

  app.get("/api/ollama/health", async (_req, res) => {
    const base = ollamaBaseUrl();
    const model = selectedOllamaModel;
    const installed = await installedOllamaModels();
    if (installed === null) {
      return res.status(503).json({ ok: false, base, model, error: "Ollama svarade inte" });
    }
    const modelAvailable: boolean | null = installed.length ? installed.includes(model) : null;
    return res.json({ ok: true, base, model, modelAvailable, gemmaModels: gemmaModelsFromInstalled(installed) });
  });

  // The UI can only ever offer Gemma 4 models; `available` are the Gemma 4 ones that are
  // actually installed, so the list reflects what this machine can run right now.
  app.get("/api/ollama/model", async (_req, res) => {
    const installed = await installedOllamaModels();
    const available = installed === null ? [] : gemmaModelsFromInstalled(installed);
    if (!available.includes(selectedOllamaModel)) available.unshift(selectedOllamaModel);
    return res.json({
      ok: true,
      model: selectedOllamaModel,
      defaultModel: DEFAULT_OLLAMA_MODEL,
      available,
    });
  });

  app.post("/api/ollama/model", (req, res) => {
    const incoming = String(req.body?.model || "").trim().toLowerCase();
    if (!isGemmaModel(incoming)) {
      return res.status(400).json({
        ok: false,
        error: `Endast Gemma 4-modeller stöds. Använd ${DEFAULT_OLLAMA_MODEL}.`,
      });
    }
    selectedOllamaModel = incoming as AllowedOllamaModel;
    persistOllamaModel();
    return res.json({ ok: true, model: selectedOllamaModel });
  });

  app.post("/api/agents/run-ollama", async (req, res) => {
    loadRoots(); // Sync with electron-main.js state
    const mission = req.body?.mission || req.body?.globalMission || "";
    if (!mission.trim()) return res.status(400).json({ error: "Mission missing" });
    if (currentRunInProgress) return res.status(409).json({ ok: false, error: "A run is already in progress" });

    const requestedAgents = Array.isArray(req.body?.agents)
      ? req.body.agents.filter((a: unknown): a is string => typeof a === "string" && (AGENT_IDS as readonly string[]).includes(a))
      : [...AGENT_IDS];
    if (!requestedAgents.length) return res.status(400).json({ error: "No valid agents selected" });

    try {
      currentRunInProgress = true;
      currentRunAbort = new AbortController();

      // Tie the run to the client that asked for it. If that client goes away (tab
      // closed, request timed out) the run must not keep burning the CPU and blocking
      // every later run behind "A run is already in progress".
      const aborter = currentRunAbort;
      const onClientGone = () => {
        if (res.writableEnded) return;
        try {
          aborter.abort();
          // A run blocked on an approval would otherwise stay parked for the full
          // approval timeout even though nobody is left to answer it.
          if (pendingApproval) pendingApproval.settle(false);
        } catch (e) {
          console.error("Could not abort a run whose client disconnected:", e);
        }
      };
      res.on("close", onClientGone);

      const summary = await runOllamaAgentLoop({
        ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
        ollamaModel: selectedOllamaModel,
        sandboxRoots: activeWorkspaceRoots,
        mission,
        maxSteps: 200,
        terminalTimeoutSec: 60,
        maxTerminalOutputChars: 50_000,
        abortSignal: currentRunAbort.signal,
        agentSequence: requestedAgents,
        // The UI only calls this endpoint after the user accepted the up-front confirmation,
        // so that single approval covers every destructive step of the run. A client that
        // does not send the flag is still asked before each destructive action.
        autoApproveDestructive: req.body?.approvedDestructive === true,
        requestApproval,
        onLog: (log: any) => pushLog(log),
      } as any);
      res.json({ ok: true, summary });
    } catch (e: any) {
      if (e?.name === "AbortError") {
        res.status(499).json({ ok: false, error: "Aborted" });
      } else {
        res.status(500).json({ ok: false, error: e.message });
      }
    } finally {
      currentRunInProgress = false;
      currentRunAbort = null;
    }
  });

  app.post("/api/agents/abort", (_req, res) => {
    if (!currentRunAbort) return res.json({ ok: false, error: "No active run" });
    try {
      currentRunAbort.abort();
    } catch (e) {
      console.error("Could not abort the current run:", e);
    }
    if (pendingApproval) pendingApproval.settle(false);
    return res.json({ ok: true });
  });

  app.get("/api/agents/status", (_req, res) => {
    res.json({ running: currentRunInProgress, scheduledRunInProgress });
  });

  app.get("/api/files/read", (req, res) => {
    try {
      loadRoots();
      const filePath = String(req.query?.filePath || "");
      const abs = validatePath(filePath);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return res.status(404).json({ error: "File not found" });
      }
      const content = fs.readFileSync(abs, "utf-8");
      return res.json({ ok: true, content });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/files/write", (req, res) => {
    try {
      loadRoots();
      const filePath = String(req.body?.filePath || "");
      const content = String(req.body?.content ?? "");
      const abs = validatePath(filePath);
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, content, "utf-8");
      return res.json({ ok: true });
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/workspace/pick", (_req, res) => {
    return res.status(501).json({ error: "Folder picker is only available in the Electron app." });
  });

  // --- Folder browsing (so the picker also works in a browser tab) ----------------------
  // The native dialog exists only in the Electron shell. This endpoint lets the web UI walk
  // the disk instead of telling the user to type a path. It is behind the same token gate as
  // every other /api route, and it lists folder names only — nothing is read or written.
  app.get("/api/fs/dirs", (req, res) => {
    try {
      const requested = typeof req.query?.path === "string" ? req.query.path.trim() : "";
      if (!requested) {
        return res.json({
          ok: true,
          path: "",
          parent: null,
          home: homeDirectory(),
          dirs: listDrives(),
          atRoot: true,
        });
      }
      const dir = path.resolve(requested);
      return res.json({
        ok: true,
        path: dir,
        parent: parentOf(dir),
        home: homeDirectory(),
        dirs: listSubdirectories(dir),
        atRoot: false,
      });
    } catch (e: any) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/schedule", (_req, res) => {
    loadSchedule();
    return res.json({ ok: true, cronExpr: scheduledCronExpr, mission: scheduledMission });
  });

  app.post("/api/schedule", (req, res) => {
    const cronExpr = String(req.body?.cronExpr || "").trim();
    const mission = typeof req.body?.mission === "string" ? req.body.mission.trim() : "";

    if (!cronExpr) return res.status(400).json({ error: "cronExpr required" });
    if (!cron.validate(cronExpr)) return res.status(400).json({ error: "Invalid cron expression" });

    scheduledCronExpr = cronExpr;
    scheduledMission = mission || null;
    persistSchedule();
    setCronTask(scheduledCronExpr);
    return res.json({ ok: true, cronExpr: scheduledCronExpr, mission: scheduledMission });
  });

  // Serve static files. index.html gets the session token injected: it is only ever
  // readable by a page served from this origin.
  // server.cjs sits next to dist/ in the packaged app, but inside dist/ when the bundle is run
  // straight from the project (`node dist/server.cjs`). Defaulting to one of them made the UI
  // answer "UI dist files not found" while the files were right there.
  const distPath =
    process.env.DIST_PATH ||
    (fs.existsSync(path.join(_dirname, "dist", "index.html"))
      ? path.join(_dirname, "dist")
      : path.join(_dirname, "..", "dist"));
  app.use(express.static(distPath, { index: false }));

  const sendAppShell = (res: express.Response) => {
    const indexPath = path.join(distPath, "index.html");
    if (!fs.existsSync(indexPath)) {
      return res.status(404).send("UI dist files not found. Check DIST_PATH.");
    }
    let html = fs.readFileSync(indexPath, "utf-8");
    const injection = `<script>window.__OCTOS_TOKEN__=${JSON.stringify(SESSION_TOKEN)};</script>`;
    html = html.includes("</head>") ? html.replace("</head>", `${injection}</head>`) : injection + html;
    res.set("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "));
    res.type("html").send(html);
  };

  app.get("/", (_req, res) => sendAppShell(res));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
    return sendAppShell(res);
  });

  const server = app.listen(PORT, HOST);
  server.on("listening", () => {
    console.log(`Backend running on http://${HOST}:${PORT}`);
  });
  server.on("error", (err: any) => {
    if (err && err.code === "EADDRINUSE") {
      // Do NOT continue: the renderer would talk to whatever else owns this port.
      console.error(
        `FATAL: port ${PORT} is already in use by another process. ` +
          `Refusing to start, because the UI would otherwise talk to an unknown local server. ` +
          `Close the process using port ${PORT} (or set OCTOS_PORT) and restart.`
      );
      process.exit(1);
    }
    console.error("Backend listen error:", err);
    process.exit(1);
  });
}

loadSchedule();
setCronTask(scheduledCronExpr);
loadOllamaModel();

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
