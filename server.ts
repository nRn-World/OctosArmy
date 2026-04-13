import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { runOllamaAgentLoop } from "./ollamaAgent.ts";
import { spawnSync } from "child_process";
import os from "os";

dotenv.config();

// In CJS mode (bundled by esbuild), __dirname and __filename are already available.
// We use a safe check to satisfy both tsx (Esm) and build (Cjs).
const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const _filename = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);

// Use AppData for persistence in packaged mode to avoid permission issues
const appDataDir = path.join(os.homedir(), "AppData", "Roaming", "OctosArmy");
const configDir = path.join(appDataDir, "config");
const rootsFile = path.join(configDir, "roots.json");

if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

// Global state
let activeWorkspaceRoots: string[] = [path.join(appDataDir, "workspace")];

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
    try {
      const r = await fetch(`${base}/api/tags`);
      res.json({ ok: r.ok, base });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/agents/run-ollama", async (req, res) => {
    loadRoots(); // Sync with electron-main.js state
    const mission = req.body?.mission || req.body?.globalMission || "";
    if (!mission.trim()) return res.status(400).json({ error: "Mission missing" });

    try {
      const summary = await runOllamaAgentLoop({
        ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
        ollamaModel: (process.env.OLLAMA_MODEL || "gemma4:e4b").trim(),
        sandboxRoots: activeWorkspaceRoots,
        mission,
        maxSteps: 200,
        onLog: (log: any) => {
          agentLogs.push(log);
          if (agentLogs.length > 1000) agentLogs = agentLogs.slice(-1000);
        }
      } as any);
      res.json({ ok: true, summary });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
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

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Backend running on http://127.0.0.1:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
});
