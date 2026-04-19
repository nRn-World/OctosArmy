import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { runOllamaAgentLoop } from "./ollamaAgent.ts";
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

if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

// Global state
let activeWorkspaceRoots: string[] = [path.join(appDataDir, "workspace")];
let scheduledCronExpr: string | null = null;
let scheduledMission: string | null = null;
let cronTask: ReturnType<typeof cron.schedule> | null = null;
let scheduledRunInProgress = false;
let currentRunAbort: AbortController | null = null;
let currentRunInProgress = false;

function loadRoots() {
  if (fs.existsSync(rootsFile)) {
    try {
      activeWorkspaceRoots = JSON.parse(fs.readFileSync(rootsFile, "utf-8"));
    } catch (e) {}
  }
}
loadRoots();

let agentLogs: any[] = [];

function ensureDir(p: string) {
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  } catch (e) {
    console.error(`Permission error creating ${p}:`, e);
  }
}

function loadSchedule() {
  if (!fs.existsSync(scheduleFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(scheduleFile, "utf-8"));
    const cronExpr = typeof raw?.cronExpr === "string" ? raw.cronExpr.trim() : "";
    const mission = typeof raw?.mission === "string" ? raw.mission.trim() : "";
    scheduledCronExpr = cronExpr || null;
    scheduledMission = mission || null;
  } catch (e) {}
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
  } catch (e) {}
}

function setCronTask(expr: string | null) {
  if (cronTask) {
    try {
      cronTask.stop();
    } catch (e) {}
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
        ollamaModel: (process.env.OLLAMA_MODEL || "gemma4:e4b").trim(),
        sandboxRoots: activeWorkspaceRoots,
        mission: scheduledMission,
        maxSteps: 200,
        terminalTimeoutSec: 60,
        maxTerminalOutputChars: 50_000,
        abortSignal: currentRunAbort.signal,
        onLog: (log: any) => {
          agentLogs.push(log);
          if (agentLogs.length > 1000) agentLogs = agentLogs.slice(-1000);
        },
      } as any);
      agentLogs.push({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Scheduled run complete. Summary: ${String(summary).slice(0, 800)}`,
        type: "success",
      });
      if (agentLogs.length > 1000) agentLogs = agentLogs.slice(-1000);
    } catch (e: any) {
      agentLogs.push({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Scheduled run failed: ${e.message || String(e)}`,
        type: "error",
      });
      if (agentLogs.length > 1000) agentLogs = agentLogs.slice(-1000);
    } finally {
      scheduledRunInProgress = false;
      currentRunInProgress = false;
      currentRunAbort = null;
    }
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Initialize
  activeWorkspaceRoots.forEach(ensureDir);

  const validatePath = (targetPath: string) => {
    if (!targetPath) throw new Error("Path required");
    const absolutePath = path.resolve(targetPath);
    const isInside = activeWorkspaceRoots.some(root => {
      const r = path.resolve(root).replace(/\\/g, "/").toLowerCase();
      const p = absolutePath.replace(/\\/g, "/").toLowerCase();
      return p === r || p.startsWith(r + "/");
    });
    if (!isInside) throw new Error("Security Violation: Outside sandbox");
    return absolutePath;
  };

  // --- API ---

  app.get("/api/workspace/roots", (_req, res) => {
    res.json({ roots: activeWorkspaceRoots });
  });

  app.post("/api/workspace/roots", (req, res) => {
    try {
      const { roots } = req.body;
      if (!Array.isArray(roots)) return res.status(400).json({ error: "Invalid roots" });
      
      activeWorkspaceRoots = Array.from(new Set(roots.slice(0, 10).map(r => {
        const cleaned = r.trim().replace(/[\\/]+$/, "");
        const resolved = path.resolve(cleaned);
        ensureDir(resolved);
        return resolved;
      })));

      try {
        fs.writeFileSync(rootsFile, JSON.stringify(activeWorkspaceRoots, null, 2));
      } catch (e) {}
      
      res.json({ roots: activeWorkspaceRoots });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/workspace", (_req, res) => {
    try {
      const allFiles = activeWorkspaceRoots.map(root => {
        const resolved = path.resolve(root);
        const files = fs.existsSync(resolved) ? (fs.readdirSync(resolved, { recursive: true }) as string[]) : [];
        return { root: resolved, files: files.filter(f => typeof f === 'string') };
      });
      res.json({ workspaces: allFiles });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/logs", (_req, res) => res.json(agentLogs));

  app.post("/api/logs", (req, res) => {
    agentLogs.push(req.body);
    if (agentLogs.length > 1000) agentLogs = agentLogs.slice(-1000);
    res.json({ ok: true });
  });

  app.post("/api/logs/clear", (_req, res) => {
    agentLogs = [];
    res.json({ success: true });
  });

  app.get("/api/ollama/health", async (_req, res) => {
    const base = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = (process.env.OLLAMA_MODEL || "gemma4:e4b").trim();
    try {
      const r = await fetch(`${base}/api/tags`);
      let modelAvailable: boolean | null = null;
      try {
        const data = await r.clone().json();
        const names = Array.isArray((data as any)?.models)
          ? (data as any).models.map((m: any) => String(m?.name || "").trim()).filter(Boolean)
          : [];
        if (names.length) modelAvailable = names.includes(model);
      } catch (e) {}
      res.json({ ok: r.ok, base, model, modelAvailable });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/agents/run-ollama", async (req, res) => {
    loadRoots(); // Sync with electron-main.js state
    const mission = req.body?.mission || req.body?.globalMission || "";
    if (!mission.trim()) return res.status(400).json({ error: "Mission missing" });
    if (currentRunInProgress) return res.status(409).json({ ok: false, error: "A run is already in progress" });

    try {
      currentRunInProgress = true;
      currentRunAbort = new AbortController();
      const summary = await runOllamaAgentLoop({
        ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
        ollamaModel: (process.env.OLLAMA_MODEL || "gemma4:e4b").trim(),
        sandboxRoots: activeWorkspaceRoots,
        mission,
        maxSteps: 200,
        terminalTimeoutSec: 60,
        maxTerminalOutputChars: 50_000,
        abortSignal: currentRunAbort.signal,
        onLog: (log: any) => {
          agentLogs.push(log);
          if (agentLogs.length > 1000) agentLogs = agentLogs.slice(-1000);
        }
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
    } catch (e) {}
    return res.json({ ok: true });
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

  // Serve static files
  const distPath = process.env.DIST_PATH || path.join(_dirname, "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
    if (fs.existsSync(path.join(distPath, "index.html"))) {
      res.sendFile(path.join(distPath, "index.html"));
    } else {
      res.status(404).send("UI dist files not found. Check DIST_PATH.");
    }
  });

  const server = app.listen(PORT, "127.0.0.1");
  server.on("listening", () => {
    console.log(`Backend running on http://127.0.0.1:${PORT}`);
  });
  server.on("error", (err: any) => {
    if (err && err.code === "EADDRINUSE") {
      console.warn(`Backend port ${PORT} already in use. Assuming another OctosArmy backend is running.`);
      return;
    }
    console.error("Backend listen error:", err);
  });
}

loadSchedule();
setCronTask(scheduledCronExpr);

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
