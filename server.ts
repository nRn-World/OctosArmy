// OctosArmy: Python CLI (`python -m octosarmy`) is optional; this server can run the Ollama loop natively.
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import cors from "cors";
import cron, { ScheduledTask } from "node-cron";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { runOllamaAgentLoop } from "./ollamaAgent.ts";
import { spawnSync } from "child_process";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WORKSPACE = path.join(process.cwd(), "workspace");
let activeWorkspaceRoots: string[] = [DEFAULT_WORKSPACE];

function ensureDir(p: string) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  let activeWorkspaceRoots: string[] = process.env.SANDBOX_ROOT 
    ? [path.resolve(process.env.SANDBOX_ROOT)] 
    : [];
  let agentLogs: any[] = [];

  activeWorkspaceRoots.forEach(ensureDir);

  const validatePath = (targetPath: string) => {
    const absolutePath = path.resolve(targetPath);
    const isInside = activeWorkspaceRoots.some(root => {
      const r = path.resolve(root).replace(/\\/g, "/").toLowerCase();
      const p = absolutePath.replace(/\\/g, "/").toLowerCase();
      return p === r || p.startsWith(r + "/");
    });

    if (!isInside) {
      throw new Error(`Security Violation: Path is outside allowed sandboxes.`);
    }
    return absolutePath;
  };

  // --- API Routes ---

  app.get("/api/workspace", (_req, res) => {
    try {
      const allFiles: { root: string, files: string[] }[] = activeWorkspaceRoots.map(root => {
        const resolved = path.resolve(root);
        const files = fs.existsSync(resolved) ? (fs.readdirSync(resolved, { recursive: true }) as string[]) : [];
        return { root: resolved, files };
      });
      res.json({ workspaces: allFiles });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/workspace/roots", (_req, res) => {
    res.json({ roots: activeWorkspaceRoots });
  });

  app.post("/api/workspace/roots", (req, res) => {
    const { roots } = req.body;
    if (!Array.isArray(roots)) return res.status(400).json({ error: "roots must be an array" });
    activeWorkspaceRoots = roots.slice(0, 6).map(r => {
      const resolved = path.resolve(r.trim());
      ensureDir(resolved);
      return resolved;
    });
    res.json({ roots: activeWorkspaceRoots });
  });

  app.post("/api/workspace/root", (req, res) => {
    try {
      const { root } = req.body || {};
      if (!root || typeof root !== "string") {
        return res.status(400).json({ error: "Field 'root' (string) is required." });
      }
      const resolved = path.resolve(root.trim());
      if (!fs.existsSync(resolved)) {
        return res.status(400).json({ error: "Path does not exist." });
      }
      if (!activeWorkspaceRoots.includes(resolved)) {
        activeWorkspaceRoots.push(resolved);
        if (activeWorkspaceRoots.length > 6) activeWorkspaceRoots.shift();
      }
      res.json({ roots: activeWorkspaceRoots });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/files/read", (req, res) => {
    const { filePath } = req.query;
    try {
      const safePath = validatePath(filePath as string);
      const content = fs.readFileSync(safePath, "utf-8");
      res.json({ content });
    } catch (error: any) {
      res.status(403).json({ error: error.message });
    }
  });

  app.post("/api/files/write", (req, res) => {
    const { filePath, content } = req.body;
    try {
      const safePath = validatePath(filePath);
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      fs.writeFileSync(safePath, content);
      res.json({ success: true });
    } catch (error: any) {
      res.status(403).json({ error: error.message });
    }
  });


  app.get("/api/logs", (_req, res) => {
    res.json(agentLogs);
  });

  app.post("/api/logs", (req, res) => {
    agentLogs.push(req.body);
    res.json({ success: true });
  });

  app.post("/api/logs/clear", (_req, res) => {
    agentLogs = [];
    res.json({ success: true });
  });

  app.get("/api/ollama/health", async (_req, res) => {
    const base = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
    try {
      const r = await fetch(`${base}/api/tags`);
      if (!r.ok) {
        return res.status(503).json({ ok: false, error: `HTTP ${r.status}` });
      }
      res.json({ ok: true, base });
    } catch (e: any) {
      res.status(503).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get("/api/browse/drives", (_req, res) => {
    if (process.platform !== "win32") return res.json({ drives: ["/"] });
    const drives = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter(d => {
      try {
        return fs.existsSync(`${d}:/`);
      } catch {
        return false;
      }
    }).map(d => `${d}:/`);
    res.json({ drives });
  });

  app.get("/api/browse/ls", (req, res) => {
    const p = String(req.query.path || process.cwd());
    try {
      if (!fs.existsSync(p)) return res.json({ dirs: [], parent: null });
      const entries = fs.readdirSync(p, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name).sort();
      const parent = path.dirname(p) !== p ? path.dirname(p) : null;
      res.json({ dirs, parent, current: p });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/workspace/pick", (req, res) => {
    // Windows only: Use PowerShell to show a folder picker
    if (process.platform !== "win32") {
      return res.status(501).json({ error: "Native picker only supported on Windows" });
    }
    
    try {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms;
        $f = New-Object System.Windows.Forms.FolderBrowserDialog;
        $f.Description = "Välj en mapp för OctosArmy";
        $f.ShowNewFolderButton = $true;
        
        # Force to front
        $w = New-Object System.Windows.Forms.NativeWindow;
        $w.AssignHandle([IntPtr]::Zero);
        
        if($f.ShowDialog($w) -eq 'OK') { $f.SelectedPath }
      `;
      const result = spawnSync("powershell", ["-NoProfile", "-Command", psScript], { encoding: "utf-8" });
      if (result.error) {
        console.error("PowerShell Error:", result.error);
        throw result.error;
      }
      const pickedPath = result.stdout.trim();
      console.log("Native Picker picked:", pickedPath);
      
      if (pickedPath) {
        res.json({ path: pickedPath });
      } else {
        res.json({ path: null });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/workspace/roots", (_req, res) => {
    res.json({ roots: activeWorkspaceRoots });
  });

  app.post("/api/workspace/roots", (req, res) => {
    const { roots } = req.body;
    if (!Array.isArray(roots)) return res.status(400).json({ error: "roots must be an array" });
    activeWorkspaceRoots = roots.slice(0, 6).map(r => {
      const resolved = path.resolve(r.trim());
      ensureDir(resolved);
      return resolved;
    });
    res.json({ roots: activeWorkspaceRoots });
  });

  app.get("/api/logs", (_req, res) => {
    res.json(agentLogs);
  });

  app.post("/api/logs", (req, res) => {
    agentLogs.push(req.body);
    // Keep last 1000 logs
    if (agentLogs.length > 1000) agentLogs = agentLogs.slice(-1000);
    res.json({ ok: true });
  });

  app.post("/api/agents/run-ollama", async (req, res) => {
    const mission =
      typeof req.body?.mission === "string"
        ? req.body.mission
        : typeof req.body?.globalMission === "string"
          ? req.body.globalMission
          : "";
    if (!mission.trim()) {
      return res.status(400).json({ error: "mission (or globalMission) is required." });
    }

    const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(
      /\/$/,
      ""
    );
    const ollamaModel = (process.env.OLLAMA_MODEL || "gemma3:4b").trim();
    const maxSteps = parseInt(process.env.OCTOSARMY_MAX_STEPS || "200", 10);
    const terminalTimeoutSec = parseInt(process.env.OCTOSARMY_TERMINAL_TIMEOUT || "120", 10);
    const maxTerminalOutputChars = parseInt(
      process.env.OCTOSARMY_MAX_TERMINAL_OUTPUT || "50000",
      10
    );

    const trace: any[] = [];
    const onLog = (log: (typeof trace)[0]) => {
      trace.push(log);
      agentLogs.push(log);
      if (agentLogs.length > 1000) agentLogs = agentLogs.slice(-1000);
    };

    try {
      const summary = await runOllamaAgentLoop({
        ollamaBaseUrl,
        ollamaModel,
        sandboxRoots: activeWorkspaceRoots,
        mission,
        maxSteps,
        terminalTimeoutSec,
        maxTerminalOutputChars,
        onLog,
      });
      res.json({ ok: true, summary, trace });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message || String(e), trace });
    }
  });

  let activeSchedule: string | null = null;
  let scheduledTask: ScheduledTask | null = null;

  app.post("/api/schedule", (req, res) => {
    const { cronExpr } = req.body;
    if (scheduledTask) scheduledTask.stop();

    activeSchedule = cronExpr;
    scheduledTask = cron.schedule(cronExpr, () => {
      console.log("Scheduled job running...");
      agentLogs.push({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: "Scheduled job triggered.",
        type: "info",
      });
    });

    res.json({ success: true, schedule: activeSchedule });
  });

  // Unmatched /api → JSON (avoids empty/HTML responses if Vite swallowed a request)
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({
        error: `Unknown API: ${req.method} ${req.originalUrl}`,
      });
    }
    next();
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`OctosArmy Server running on http://localhost:${PORT}`);
    console.log(`Allowed Sandboxes (${activeWorkspaceRoots.length}/6):`);
    activeWorkspaceRoots.forEach((r, i) => console.log(`  [${i+1}] ${r}`));
    console.log(`Ollama: ${process.env.OLLAMA_BASE_URL || "http://localhost:11434"} model=${process.env.OLLAMA_MODEL || "gemma4:e4b"}`);
  });
}

startServer();
