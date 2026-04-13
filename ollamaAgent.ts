/**
 * Server-side tool loop: Ollama chat + sandbox file ops + allowlisted terminal.
 */
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

export type AgentLog = {
  timestamp: string;
  agent: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
};

const SYSTEM_PROMPT_BASE = `Du är en del av OctosArmy Elite Team.
KRITISK REGEL: DITT NUVARANDE UPPDRAG ÄR HÖGSTA PRIORITET.
Titta alltid på 'Mission Objective' i historiken.
Du har FULLSTÄNDIG BEHÖRIGHET rekursivt inom tillåtna sandlådor.
Försök ALDRIG komma åt sökvägar som '/' eller 'C:/' om de inte uttryckligen finns i listan över tillåtna mappar.
Håll dig inom sökvägarna i 'allowed_sandboxes'.

Tillåtna instruktioner (intents):
- read_file: path, rationale, risk_level
- list_dir: path (valfritt), rationale, risk_level
- search_files: query, rationale, risk_level
- delete_path: path, rationale, risk_level
- empty_dir: path, rationale, risk_level. (Tömmer en mapp på ALLT innehåll)
- create_dir: path, rationale, risk_level
- move_path: source, destination, rationale, risk_level
- copy_path: source, destination, rationale, risk_level
- bulk_move: extensions (array), destination, source (valfritt), rationale, risk_level
- bulk_copy: extensions (array), destination, source (valfritt), rationale, risk_level
- run_terminal: argv (array, python|git), rationale, risk_level
- ask_user: question, rationale, risk_level
- done: summary, rationale, risk_level

Regler:
1. Stanna INOM tillåtna sandlådor.
2. För agenter med skrivbehörighet: Använd 'delete_path', 'bulk_move' etc.
3. Risknivå ska vara: low, medium eller high.
4. DU FÅR ALDRIG GISSA SÖKVÄGAR. Du måste vara 100% säker! Verifiera med list_dir/search_files om du är osäker. Systemet kräver PERFEKTION, inga gissningar!
VIKTIGT: Du MÅSTE svara med EXAKT ETT GILTIGT JSON-OBJEKT! Ingen markdown.
Använd denna struktur:
{
  "intent": "namn_på_intent",
  "rationale": "varför",
  "risk_level": "low",
  "path": "sökväg (om det behövs)",
  "summary": "sammanfattning (om intent är 'done')"
}
`;

const AGENT_PERSONAS: Record<string, string> = {
  scout: `PERSONA: Scouten (Agent 1).
UPPGIFT: Din uppgift är att skanna 'allowed_sandboxes' och bekräfta var filerna för uppdraget ligger. 
INSTRUKTION: När du har hittat målet, lämna över till Agent 2 (Brainstormern) genom att använda 'done'. Berätta exakt vad du hittade.`,

  brainstormer: `PERSONA: Brainstormern (Agent 2).
UPPGIFT: Skapa en plan för hur uppdraget ska utföras baserat på Scoutens rapport. 
INSTRUKTION: Skicka planen vidare till Agent 3 (Kodaren) med 'done'.`,

  coder: `PERSONA: Kodaren (Agent 3).
UPPGIFT: Genomför det praktiska arbetet (radera, flytta, skapa etc). 
INSTRUKTION: När du är klar, berätta vad du har gjort och lämna över till Agent 4 (Granskaren) med 'done'.`,

  reviewer: `PERSONA: Granskaren (Agent 4).
UPPGIFT: Du är kontrollanten. Analysera historiken. Har Agent 1 och Agent 3 gjort rätt?
DIN MAKT: Om arbetet är 100% korrekt, använd 'done' för att skicka till Agent 5 (Auditören). 
KRITISKT: Om något saknas eller är fel, använd 'done' men skriv i summary: "REJECTED: [varför]". Då tvingas Agent 1 att börja om med din lösning!`,

  auditor: `PERSONA: Auditören (Agent 5).
UPPGIFT: Berätta för användaren att allt är klart och sammanfatta resultatet snyggt.`,

  security: `PERSONA: Säkerhetsspecialisten (Agent 6).
UPPGIFT: Berätta i detalj vad alla agenter (1-2-3-4-5) har gjort. Du ska ge en slutrapport för uppdraget.`
};

function isPathInsideRoot(workspaceRoot: string, absolutePath: string): boolean {
  const r = path.resolve(workspaceRoot).replace(/\\/g, "/").toLowerCase();
  const p = path.resolve(absolutePath).replace(/\\/g, "/").toLowerCase();
  return p === r || p.startsWith(r + "/");
}

export function validateSandboxPath(workspaceRoots: string[], targetPath: string): string {
  const absolutePath = path.resolve(targetPath);
  
  // Check if absolutePath is inside any of the roots
  const isInside = workspaceRoots.some(root => {
    const r = path.resolve(root).replace(/\\/g, "/").toLowerCase();
    const p = absolutePath.replace(/\\/g, "/").toLowerCase();
    return p === r || p.startsWith(r + "/");
  });

  if (isInside) return absolutePath;

  // If not, try resolving it relative to each root to see if it lands inside
  for (const root of workspaceRoots) {
    const trial = path.resolve(root, targetPath);
    const r = path.resolve(root).replace(/\\/g, "/").toLowerCase();
    const p = trial.replace(/\\/g, "/").toLowerCase();
    if (p === r || p.startsWith(r + "/")) return trial;
  }

  throw new Error("Security Violation: Path is outside allowed sandbox roots.");
}

const FORBIDDEN = /[`;&|\n\r<>$]/;

function argvClean(argv: string[]): boolean {
  if (!argv.length) return false;
  for (const a of argv) {
    if (typeof a !== "string" || !a.trim()) return false;
    if (FORBIDDEN.test(a)) return false;
  }
  return true;
}

function allowlistedArgv(argv: string[]): boolean {
  if (!argv.length) return false;
  const head = argv[0].toLowerCase();
  if (head === "python" || head === "python3" || head === "py") {
    if (argv.length === 2 && argv[1] === "--version") return true;
    if (argv.length >= 3 && argv[1] === "-m") {
      const mod = argv[2];
      if (mod === "pytest" || mod === "compileall") {
        if (argv.includes("-c")) return false;
        return true;
      }
    }
    return false;
  }
  if (head === "git" && argv.length >= 2) {
    const sub = argv[1].toLowerCase();
    if (!["status", "diff", "log", "rev-parse"].includes(sub)) return false;
    const blocked = new Set(["fetch", "pull", "push", "remote", "clone"]);
    for (const a of argv) {
      if (blocked.has(a.toLowerCase())) return false;
    }
    return true;
  }
  return false;
}

function resolvePythonArgv(argv: string[]): string[] {
  const out = [...argv];
  const h = out[0]?.toLowerCase();
  if (h === "python" || h === "python3" || h === "py") {
    out[0] = process.env.OCTOSARMY_PYTHON || (process.platform === "win32" ? "py" : "python");
  }
  return out;
}

function runTerminalSafe(
  cwd: string,
  argv: string[],
  timeoutSec: number,
  maxOut: number
): { code: number; stdout: string; stderr: string } {
  if (!argvClean(argv)) {
    throw new Error("Terminal: disallowed characters in arguments or empty arguments.");
  }
  if (!allowlistedArgv(argv)) {
    throw new Error(
      "Terminal: command is not on the allowlist. Allowed: python --version; python -m pytest ...; python -m compileall ...; git status|diff|log|rev-parse."
    );
  }
  const resolvedCwd = path.resolve(cwd);

  let execArgv = [...argv];
  const head = execArgv[0]?.toLowerCase();
  if (head === "python" || head === "python3" || head === "py") {
    execArgv = resolvePythonArgv(execArgv);
  } else if (head === "git") {
    execArgv = ["git", ...execArgv.slice(1)];
  }

  const r = spawnSync(execArgv[0], execArgv.slice(1), {
    cwd: resolvedCwd,
    shell: false,
    encoding: "utf-8",
    maxBuffer: maxOut,
    timeout: timeoutSec * 1000,
  });
  const stdout = (r.stdout || "").slice(0, maxOut);
  const stderr = (r.stderr || "").slice(0, maxOut);
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { code: 124, stdout, stderr: stderr + "\n[timeout]" };
  }
  return { code: r.status ?? 1, stdout, stderr };
}

function parseAgentJson(text: string): Record<string, unknown> {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error("No JSON object found in response");
  }
  const jsonStr = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonStr) as Record<string, unknown>;
}

function validateEnvelope(obj: Record<string, unknown>): void {
  const intent = obj.intent as string;
  const allowed = ["read_file", "list_dir", "search_files", "delete_path", "empty_dir", "create_dir", "move_path", "copy_path", "bulk_move", "bulk_copy", "run_terminal", "done", "ask_user"];
  if (!allowed.includes(intent)) throw new Error(`Unknown intent: ${intent}`);
  if (typeof obj.rationale !== "string" || typeof obj.risk_level !== "string") {
    throw new Error("Missing rationale or risk_level");
  }
  if (!["low", "medium", "high"].includes(obj.risk_level as string)) {
    throw new Error("risk_level must be low, medium, or high");
  }
  if (intent === "done") {
    // If summary is missing, fallback to rationale to prevent infinite retry loops
    if (!obj.summary || !String(obj.summary).trim()) {
      obj.summary = obj.rationale || "Task completed successfully.";
    }
  }
  if (intent === "ask_user" && !String(obj.question || "").trim()) {
    throw new Error("ask_user requires question");
  }
  if (intent === "read_file" && !String(obj.path || "").trim()) {
    throw new Error("read_file requires path");
  }
  if (intent === "run_terminal") {
    const argv = obj.argv;
    if (!Array.isArray(argv) || !argv.length) {
      throw new Error("run_terminal requires argv as a non-empty array");
    }
  }
}

async function ollamaChat(
  baseUrl: string,
  model: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/chat`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: "json",
      options: { temperature: 0.1 },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Ollama HTTP ${resp.status}: ${t.slice(0, 500)}`);
  }
  const data = (await resp.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (typeof content !== "string") throw new Error("Unexpected Ollama response shape");
  return content.trim();
}

function listFilesNonRecursive(workspaceRoots: string[], subDir: string): string {
  try {
    const base = validateSandboxPath(workspaceRoots, subDir);
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const lines = entries.map(e => {
      const type = e.isDirectory() ? "[DIR]" : "[FILE]";
      return `${type} ${e.name}`;
    });
    return lines.length ? lines.sort().join("\n") : "(empty)";
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function searchFilesRecursive(workspaceRoots: string[], query: string): string[] {
  const results: string[] = [];
  const q = query.toLowerCase().trim();
  
  function walk(dir: string, root: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (rel.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
        results.push(`${root}: ${rel}`);
      }
      if (e.isDirectory()) {
        walk(full, root);
      }
    }
  }
  
  workspaceRoots.forEach(root => {
    if (fs.existsSync(root)) walk(root, root);
  });
  return results;
}

export type RunOllamaOptions = {
  ollamaBaseUrl: string;
  ollamaModel: string;
  sandboxRoots: string[];
  mission: string;
  maxSteps: number;
  terminalTimeoutSec: number;
  maxTerminalOutputChars: number;
  onLog: (log: AgentLog) => void;
};

export async function runOllamaAgentLoop(opts: RunOllamaOptions): Promise<string> {
  const {
    ollamaBaseUrl,
    ollamaModel,
    sandboxRoots,
    mission,
    maxSteps,
    terminalTimeoutSec,
    maxTerminalOutputChars,
    onLog,
  } = opts;

  const log = (msg: string, type: AgentLog["type"] = "info", agentId: string = "System") => {
    onLog({ timestamp: new Date().toISOString(), agent: agentId, message: msg, type });
  };

  const agentSequence = ["scout", "brainstormer", "coder", "reviewer", "auditor", "security"];
  let currentAgentIndex = 0;

  const messages: { role: string; content: string }[] = [
    {
      role: "system",
      content: `${SYSTEM_PROMPT_BASE}\n\nMISSION OBJECTIVE: ${mission}\n\nCURRENT AGENT CONFIGURATION:\n${AGENT_PERSONAS[agentSequence[currentAgentIndex]]}`,
    },
    {
      role: "user",
      content: JSON.stringify({
        order: mission,
        allowed_sandboxes: sandboxRoots,
        note: "You have full control over these directories AND ALL THEIR SUBDIRECTORIES. Please use absolute paths (e.g. C:/path/to/dir) when moving/copying between different roots to ensure it goes exactly where you want.",
      }),
    },
  ];

  let lastSummary = "Mission incomplete.";

  for (let step = 0; step < maxSteps; step++) {
    const currentAgentId = agentSequence[currentAgentIndex];
    const currentAgentName = currentAgentId.charAt(0).toUpperCase() + currentAgentId.slice(1);
    
    log(`Step ${step + 1}: calling Ollama (${currentAgentName})...`, "info", currentAgentId);
    let raw: string;
    try {
      raw = await ollamaChat(ollamaBaseUrl, ollamaModel, messages);
    } catch (e: any) {
      log(`Ollama error: ${e.message}`, "error", currentAgentId);
      throw e;
    }
    messages.push({ role: "assistant", content: raw });

    let obj: Record<string, unknown>;
    try {
      obj = parseAgentJson(raw);
      validateEnvelope(obj);
    } catch (e: any) {
      messages.push({
        role: "user",
        content: `Invalid JSON or schema: ${e.message}. Reply with ONE JSON object only.`,
      });
      log(`Schema retry: ${e.message}`, "warning", currentAgentId);
      continue;
    }

    const intent = obj.intent as string;
    log(`[${currentAgentName}] Intent: ${intent} (${obj.risk_level}) — ${obj.rationale}`, "info", currentAgentId);

    if (intent === "done") {
      const summary = String(obj.summary || "");
      
      // LOGIC: If Reviewer (Agent 4) rejects the work, send back to Scout (Agent 1)
      if (currentAgentId === "reviewer" && summary.toUpperCase().includes("REJECTED")) {
        log(`REVIEW REJECTED: ${summary}. Restarting from Scout (Agent 1)...`, "warning", currentAgentId);
        currentAgentIndex = 0; // Back to Scout
        messages[0].content = `${SYSTEM_PROMPT_BASE}\n\nMISSION OBJECTIVE: ${mission}\n\nCURRENT AGENT CONFIGURATION:\n${AGENT_PERSONAS[agentSequence[0]]}`;
        messages.push({
          role: "user",
          content: `CRITICAL FEEDBACK FROM REVIEWER: ${summary}\n\nPlease start again and solve the issue described above.`,
        });
        continue;
      }

      if (currentAgentIndex < agentSequence.length - 1) {
        currentAgentIndex++;
        const nextAgentId = agentSequence[currentAgentIndex];
        const nextAgentName = nextAgentId.charAt(0).toUpperCase() + nextAgentId.slice(1);
        
        log(`${currentAgentName} finished and handed over to ${nextAgentName}.`, "success", currentAgentId);
        
        messages[0].content = `${SYSTEM_PROMPT_BASE}\n\nMISSION OBJECTIVE: ${mission}\n\nCURRENT AGENT CONFIGURATION:\n${AGENT_PERSONAS[nextAgentId]}`;
        
        messages.push({
          role: "user",
          content: `ACTION: ${currentAgentName} is done with result: ${summary}. Now it's your turn, ${nextAgentName}. Use the shared history to continue the mission.`,
        });
        continue;
      } else {
        lastSummary = String(obj.summary);
        log(`Mission Complete: ${lastSummary}`, "success", currentAgentId);
        return lastSummary;
      }
    }

    if (intent === "ask_user") {
      const q = String(obj.question);
      messages.push({
        role: "user",
        content: JSON.stringify({
          answer:
            "[UI mode: no stdin — continue with best safe assumption inside sandbox, or done with explanation.]",
        }),
      });
      log(`Model asked: ${q} (auto-reply placeholder sent)`, "warning");
      continue;
    }

    if (intent === "read_file") {
      const rel = String(obj.path);
      try {
        const safe = validateSandboxPath(sandboxRoots, rel);
        if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
          throw new Error("Not a file");
        }
        const content = fs.readFileSync(safe, "utf-8");
        messages.push({
          role: "user",
          content: JSON.stringify({
            ok: true,
            path: rel,
            content: content.slice(0, 8000),
          }),
        });
        log(`Read ${rel} (${content.length} chars)`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, path: rel, error: String(e.message || e) }),
        });
        log(`read_file failed: ${e.message}`, "error");
      }
      continue;
    }

    if (intent === "list_dir") {
      const rel = String(obj.path ?? ".");
      try {
        const listing = listFilesNonRecursive(sandboxRoots, rel);
        messages.push({
          role: "user",
          content: JSON.stringify({
            ok: true,
            path: rel,
            listing: listing.slice(0, 8000),
          }),
        });
        log(`Listed ${rel}`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, path: rel, error: String(e.message || e) }),
        });
        log(`list_dir failed: ${e.message}`, "error");
      }
      continue;
    }

    if (intent === "search_files") {
      const q = String(obj.query);
      try {
        const results = searchFilesRecursive(sandboxRoots, q);
        messages.push({
          role: "user",
          content: JSON.stringify({
            ok: true,
            query: q,
            results: results.slice(0, 50), // Limit to top 50 matches for context
            total_matches: results.length
          }),
        });
        log(`Searched for "${q}": found ${results.length} matches`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, error: String(e.message || e) }),
        });
        log(`search_files failed: ${e.message}`, "error");
      }
      continue;
    }

    if (intent === "empty_dir") {
      const rel = String(obj.path);
      try {
        const safe = validateSandboxPath(sandboxRoots, rel);
        if (!fs.existsSync(safe)) throw new Error("Path does not exist");
        const entries = fs.readdirSync(safe);
        for (const entry of entries) {
          fs.rmSync(path.join(safe, entry), { recursive: true, force: true });
        }
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: true, path: rel, emptied: true }),
        });
        log(`Emptied directory ${rel}`, "success", currentAgentId);
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, path: rel, error: String(e.message || e) }),
        });
        log(`empty_dir failed: ${e.message}`, "error", currentAgentId);
      }
      continue;
    }

    if (intent === "delete_path") {
      const rel = String(obj.path);
      try {
        const safe = validateSandboxPath(sandboxRoots, rel);
        if (sandboxRoots.some(root => path.normalize(root) === safe)) {
           throw new Error("Förbjudet: Du försöker radera själva rot-mappen (sandboxen)! Om du ska tömma den, använd empty_dir istället.");
        }
        if (!fs.existsSync(safe)) {
          // Alternative fallback for tricky Windows trailing spaces if path is dir contents
          throw new Error("Path does not exist. (If it has trailing spaces, consider using empty_dir on the parent)");
        }
        const stat = fs.statSync(safe);
        if (stat.isDirectory()) {
          fs.rmSync(safe, { recursive: true, force: true });
        } else {
          fs.unlinkSync(safe);
        }
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: true, path: rel, deleted: true }),
        });
        log(`Deleted ${rel}`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, path: rel, error: String(e.message || e) }),
        });
        log(`delete_path failed: ${e.message}`, "error");
      }
      continue;
    }


    if (intent === "create_dir") {
      const rel = String(obj.path);
      try {
        const safe = validateSandboxPath(sandboxRoots, rel);
        if (fs.existsSync(safe)) {
          throw new Error("Path already exists");
        }
        fs.mkdirSync(safe, { recursive: true });
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: true, path: rel, created: true }),
        });
        log(`Created directory ${rel}`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, path: rel, error: String(e.message || e) }),
        });
        log(`create_dir failed: ${e.message}`, "error");
      }
      continue;
    }

    if (intent === "move_path") {
      const srcRel = String(obj.source).trim();
      let dstRel = String(obj.destination).trim();
      
      // Smart Rename: If dstRel is just a filename, keep it in the same folder as srcRel
      if (!dstRel.includes("/") && !dstRel.includes("\\")) {
        const srcDir = path.dirname(srcRel);
        if (srcDir && srcDir !== ".") {
          dstRel = srcDir + "/" + dstRel;
        }
      }
      try {
        const safeSrc = validateSandboxPath(sandboxRoots, srcRel);
        const safeDst = validateSandboxPath(sandboxRoots, dstRel);
        
        if (!fs.existsSync(safeSrc)) {
          throw new Error(`Source path does not exist: ${srcRel}`);
        }
        
        let finalSafeDst = safeDst;
        if (fs.statSync(safeSrc).isFile()) {
          const srcExt = path.extname(safeSrc);
          if (srcExt && !path.extname(finalSafeDst)) {
            finalSafeDst += srcExt; // Automatically preserve extension
          }
        }
        
        // Ensure destination parent exists
        const dstDir = path.dirname(finalSafeDst);
        if (!fs.existsSync(dstDir)) {
          fs.mkdirSync(dstDir, { recursive: true });
        }
        
        fs.renameSync(safeSrc, finalSafeDst);
        
        const finalRelDst = path.relative(sandboxRoots[0], finalSafeDst).replace(/\\/g, "/");
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: true, source: srcRel, destination: finalRelDst, moved: true }),
        });
        log(`Moved ${srcRel} to ${finalRelDst}`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, source: srcRel, destination: dstRel, error: String(e.message || e) }),
        });
        log(`move_path failed: ${e.message}`, "error");
      }
      continue;
    }

    if (intent === "copy_path") {
      const srcRel = String(obj.source).trim();
      let dstRel = String(obj.destination).trim();
      
      // Smart Rename logic for copy too
      if (!dstRel.includes("/") && !dstRel.includes("\\")) {
        const srcDir = path.dirname(srcRel);
        if (srcDir && srcDir !== ".") {
          dstRel = srcDir + "/" + dstRel;
        }
      }
      try {
        const safeSrc = validateSandboxPath(sandboxRoots, srcRel);
        const safeDst = validateSandboxPath(sandboxRoots, dstRel);
        
        if (!fs.existsSync(safeSrc)) {
          throw new Error(`Source path does not exist: ${srcRel}`);
        }
        
        // Ensure destination parent exists
        const dstDir = path.dirname(safeDst);
        if (!fs.existsSync(dstDir)) {
          fs.mkdirSync(dstDir, { recursive: true });
        }
        
        const stat = fs.statSync(safeSrc);
        if (stat.isDirectory()) {
          fs.cpSync(safeSrc, safeDst, { recursive: true });
        } else {
          fs.copyFileSync(safeSrc, safeDst);
        }
        
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: true, source: srcRel, destination: dstRel, copied: true }),
        });
        log(`Copied ${srcRel} to ${dstRel}`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, source: srcRel, destination: dstRel, error: String(e.message || e) }),
        });
        log(`copy_path failed: ${e.message}`, "error");
      }
      continue;
    }

    if (intent === "bulk_copy") {
      const exts = (obj.extensions as string[] || []).map(e => e.toLowerCase());
      const dstRel = String(obj.destination_dir || obj.destination);
      const srcDirRel = String(obj.source_dir || obj.source || ".");
      try {
        const safeSrcDir = validateSandboxPath(sandboxRoots, srcDirRel);
        const safeDst = validateSandboxPath(sandboxRoots, dstRel);
        if (!fs.existsSync(safeDst)) {
          fs.mkdirSync(safeDst, { recursive: true });
        }
        
        const files = fs.readdirSync(safeSrcDir, { withFileTypes: true });
        let copiedCount = 0;
        const copyAll = exts.includes("*");
        
        for (const f of files) {
          const src = path.join(safeSrcDir, f.name);
          const dst = path.join(safeDst, f.name);
          if (src === dst) continue;

          if (f.isFile()) {
            const ext = path.extname(f.name).toLowerCase();
            if (copyAll || exts.includes(ext)) {
              fs.copyFileSync(src, dst);
              copiedCount++;
            }
          } else if (f.isDirectory() && copyAll) {
            fs.cpSync(src, dst, { recursive: true });
            copiedCount++;
          }
        }
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: true, source_dir: srcDirRel, destination_dir: dstRel, copied_items: copiedCount }),
        });
        log(`Bulk copied ${copiedCount} items (files/dirs) to ${dstRel}`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, error: String(e.message || e) }),
        });
        log(`bulk_copy failed: ${e.message}`, "error");
      }
      continue;
    }

    if (intent === "bulk_move") {
      const exts = (obj.extensions as string[] || []).map(e => e.toLowerCase());
      const dstRel = String(obj.destination_dir || obj.destination);
      const srcDirRel = String(obj.source_dir || obj.source || ".");
      try {
        const safeSrcDir = validateSandboxPath(sandboxRoots, srcDirRel);
        const safeDst = validateSandboxPath(sandboxRoots, dstRel);
        if (!fs.existsSync(safeDst)) {
          fs.mkdirSync(safeDst, { recursive: true });
        }
        
        const files = fs.readdirSync(safeSrcDir, { withFileTypes: true });
        let movedCount = 0;
        const moveAll = exts.includes("*");
        
        for (const f of files) {
          const src = path.join(safeSrcDir, f.name);
          const dst = path.join(safeDst, f.name);
          if (src === dst) continue;

          if (f.isFile()) {
            const ext = path.extname(f.name).toLowerCase();
            if (moveAll || exts.includes(ext)) {
              fs.renameSync(src, dst);
              movedCount++;
            }
          } else if (f.isDirectory() && moveAll) {
            fs.cpSync(src, dst, { recursive: true });
            fs.rmSync(src, { recursive: true, force: true });
            movedCount++;
          }
        }
        
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: true, moved_items: movedCount, destination: dstRel }),
        });
        log(`Bulk moved ${movedCount} items (files/dirs) to ${dstRel}`, "success");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, error: String(e.message || e) }),
        });
        log(`bulk_move failed: ${e.message}`, "error");
      }
      continue;
    }

    if (intent === "run_terminal") {
      const argv = obj.argv as string[];
      const cwdRel = String(obj.cwd || ".");
      try {
        const safeCwd = validateSandboxPath(sandboxRoots, cwdRel);
        const { code, stdout, stderr } = runTerminalSafe(
          safeCwd,
          argv,
          terminalTimeoutSec,
          maxTerminalOutputChars
        );
        messages.push({
          role: "user",
          content: JSON.stringify({
            ok: code === 0,
            exit_code: code,
            stdout,
            stderr,
          }),
        });
        log(`Terminal exit ${code}`, code === 0 ? "success" : "warning");
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, error: String(e.message || e) }),
        });
        log(`run_terminal failed: ${e.message}`, "error");
      }
      continue;
    }
  }

  const msg = "Max steps reached without intent done.";
  log(msg, "warning");
  return lastSummary || msg;
}
