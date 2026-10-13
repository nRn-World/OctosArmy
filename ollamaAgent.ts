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

/**
 * Resolve the real location of a path, following symlinks/junctions.
 * The path itself may not exist yet (files we are about to create), so we resolve the
 * nearest existing ancestor and re-attach the missing tail.
 */
export function resolveWithRealAncestor(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function normalizeForCompare(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  // Windows/macOS filesystems are case-insensitive, so fold case there. On a
  // case-sensitive filesystem a mismatch fails closed, which is the safe direction.
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

function isPathInsideRoot(workspaceRoot: string, absolutePath: string): boolean {
  const r = normalizeForCompare(workspaceRoot);
  const p = normalizeForCompare(absolutePath);
  return p === r || p.startsWith(r + "/");
}

/** Roots resolved to their real path, so symlinked roots compare correctly too. */
export function realRoots(workspaceRoots: string[]): string[] {
  return workspaceRoots.map((root) => resolveWithRealAncestor(root));
}

export function validateSandboxPath(workspaceRoots: string[], targetPath: string): string {
  const roots = realRoots(workspaceRoots);
  const absolutePath = resolveWithRealAncestor(targetPath);

  if (roots.some((root) => isPathInsideRoot(root, absolutePath))) return absolutePath;

  // If not, try resolving it relative to each root to see if it lands inside
  for (const root of roots) {
    const trial = resolveWithRealAncestor(path.resolve(root, targetPath));
    if (isPathInsideRoot(root, trial)) return trial;
  }

  // The message has to name the offending path and the folders that ARE allowed, and say
  // plainly that no permission can be granted mid-run. Without that, a model whose path is
  // refused starts guessing, or asks the user for a folder it can never get.
  throw new Error(
    `Security Violation: Path is outside allowed sandbox roots. ` +
      `Fordrad sökväg: "${targetPath}". Tillåtna rötter: ${roots.map((r) => `"${r}"`).join(", ")}. ` +
      `Utför åtgärden inom dessa mappar i stället — behörigheter kan inte ändras under en körning.`
  );
}

/** True when the path IS one of the sandbox roots themselves. */
export function isSandboxRoot(workspaceRoots: string[], absolutePath: string): boolean {
  const p = normalizeForCompare(absolutePath);
  return realRoots(workspaceRoots).some((root) => normalizeForCompare(root) === p);
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
    env: {
      ...process.env,
      // Reduces how much third-party code pytest can pull in by itself. Note that a
      // conftest.py in cwd is still imported by design — which is exactly why
      // run_terminal always goes through the human approval gate.
      PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  const stdout = (r.stdout || "").slice(0, maxOut);
  const stderr = (r.stderr || "").slice(0, maxOut);
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { code: 124, stdout, stderr: stderr + "\n[timeout]" };
  }
  return { code: r.status ?? 1, stdout, stderr };
}

/**
 * Accept extensions written with or without the leading dot, plus "*" for everything.
 * path.extname() always returns ".png", so a model that answers ["png"] used to match
 * nothing — and the old code still reported the move as successful.
 */
function normalizeExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e === "*" || e.startsWith(".") ? e : `.${e}`));
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

function intFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Hard ceiling for one model call, so a wedged Ollama can never hang the UI forever. */
const OLLAMA_CALL_TIMEOUT_MS = intFromEnv("OCTOSARMY_OLLAMA_TIMEOUT", 900) * 1000;
/** If the model stops emitting anything for this long, the call is considered dead. */
const OLLAMA_STALL_TIMEOUT_MS = intFromEnv("OCTOSARMY_OLLAMA_STALL", 90) * 1000;
/** Below this generation speed the model is impractically slow and we say so once. */
export const SLOW_MODEL_TOKENS_PER_SEC = 8;

export type ChatProgress = {
  agentId: string;
  tokens: number;
  elapsedMs: number;
  tokensPerSecond: number;
};

/**
 * One call to Ollama, streamed.
 *
 * Streaming is what makes progress visible: we can report how much the model has
 * produced and how fast, and we can tell a slow model apart from a dead connection.
 * A 14B reasoning model on a partly CPU-offloaded GPU generates a couple of tokens per
 * second, which used to look exactly like a freeze.
 */
async function ollamaChat(
  baseUrl: string,
  model: string,
  messages: { role: string; content: string }[],
  signal: AbortSignal | undefined,
  onProgress: (progress: ChatProgress) => void,
  agentId: string
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/chat`;
  const controller = new AbortController();
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let stopReason: "timeout" | "stalled" | null = null;

  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastActivityAt > OLLAMA_STALL_TIMEOUT_MS) {
      stopReason = "stalled";
      controller.abort();
    } else if (now - startedAt > OLLAMA_CALL_TIMEOUT_MS) {
      stopReason = "timeout";
      controller.abort();
    }
  }, 1000);

  const cleanup = () => {
    clearInterval(watchdog);
    signal?.removeEventListener("abort", onExternalAbort);
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        format: "json",
        options: { temperature: 0.1 },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Ollama HTTP ${resp.status}: ${t.slice(0, 500)}`);
    }

    // No stream support (or no body): fall back to parsing the whole response at once.
    if (!resp.body) {
      const data = (await resp.json()) as { message?: { content?: string } };
      const content = data.message?.content;
      if (typeof content !== "string") throw new Error("Unexpected Ollama response shape");
      return content.trim();
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let tokens = 0;
    let lastProgressAt = startedAt;

    const handleLine = (line: string) => {
      if (!line) return;
      let chunk: any;
      try {
        chunk = JSON.parse(line);
      } catch {
        return; // partial or keep-alive line
      }
      lastActivityAt = Date.now();
      if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
      const piece = chunk.message?.content;
      if (typeof piece === "string" && piece) {
        content += piece;
        tokens += 1; // Ollama emits roughly one token per chunk
      }
      if (typeof chunk.eval_count === "number" && chunk.eval_count > 0) {
        tokens = chunk.eval_count;
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs - (lastProgressAt - startedAt) < 4000) return;
      lastProgressAt = Date.now();
      const tokensPerSecond = elapsedMs > 0 ? tokens / (elapsedMs / 1000) : 0;
      onProgress({ agentId, tokens, elapsedMs, tokensPerSecond });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        handleLine(line);
      }
    }
    handleLine(buffer.trim());

    if (!content.trim()) throw new Error("Ollama returned an empty response");
    return content.trim();
  } catch (e: any) {
    if (stopReason === "timeout") {
      const seconds = Math.round(OLLAMA_CALL_TIMEOUT_MS / 1000);
      throw new Error(
        `Ollama svarade inte inom ${seconds} s och anropet avbröts. ` +
          `Det är vanligtvis en för långsam Gemma 4-modell: kontrollera hastigheten i loggen och välj en mindre ` +
          `variant i UPPDRAGSMÅL. (Tidsgränsen kan höjas med OCTOSARMY_OLLAMA_TIMEOUT.)`
      );
    }
    if (stopReason === "stalled") {
      const seconds = Math.round(OLLAMA_STALL_TIMEOUT_MS / 1000);
      throw new Error(
        `Ollama slutade svara i ${seconds} s och anropet avbröts. Kontrollera att Ollama körs och att modellen kan laddas.`
      );
    }
    throw e;
  } finally {
    cleanup();
  }
}

/**
 * List one directory. Throws on a refused path or an unreadable directory.
 *
 * It used to swallow those errors and return the text "Error: ..." as if it were a
 * directory listing, while the caller reported ok:true and logged "Listed …" as a success.
 * A model that was actually blocked was told everything worked, so it kept going — asking
 * for permissions and finally hitting the wall on a real action.
 */
function listFilesNonRecursive(workspaceRoots: string[], subDir: string): string {
  const base = validateSandboxPath(workspaceRoots, subDir);
  const entries = fs.readdirSync(base, { withFileTypes: true });
  const lines = entries.map(e => {
    const type = e.isDirectory() ? "[DIR]" : "[FILE]";
    return `${type} ${e.name}`;
  });
  return lines.length ? lines.sort().join("\n") : "(empty)";
}

const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", "__pycache__"]);
const SEARCH_MAX_RESULTS = 2000;
const SEARCH_MAX_DEPTH = 12;

export function searchFilesRecursive(workspaceRoots: string[], query: string): string[] {
  const results: string[] = [];
  const q = query.toLowerCase().trim();
  if (!q) return results;

  function walk(dir: string, root: string, depth: number) {
    // An unreadable directory must not abort the whole search.
    if (results.length >= SEARCH_MAX_RESULTS || depth > SEARCH_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= SEARCH_MAX_RESULTS) return;
      if (e.isDirectory() && SEARCH_SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (rel.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
        results.push(`${root}: ${rel}`);
      }
      if (e.isDirectory()) {
        walk(full, root, depth + 1);
      }
    }
  }

  workspaceRoots.forEach(root => {
    if (fs.existsSync(root)) walk(root, root, 0);
  });
  return results;
}

export type ApprovalRequest = {
  intent: string;
  detail: string;
  riskLevel: string;
};

export type RunOllamaOptions = {
  ollamaBaseUrl: string;
  ollamaModel: string;
  sandboxRoots: string[];
  mission: string;
  maxSteps: number;
  terminalTimeoutSec: number;
  maxTerminalOutputChars: number;
  onLog: (log: AgentLog) => void;
  abortSignal?: AbortSignal;
  /** Which agents take part, in order. Defaults to the full six-agent chain. */
  agentSequence?: string[];
  /**
   * Human approval before anything destructive or code-executing runs.
   * When omitted, those intents are refused (fails closed for unattended runs).
   */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  /**
   * The run was approved up front, so destructive intents proceed without stopping.
   * Every one of them is still logged, so there is always a record of what happened.
   * This is the "one approval, then the agents work undisturbed" mode the UI uses.
   */
  autoApproveDestructive?: boolean;
};

/** Intents that can destroy data or execute code always need a human in the loop. */
const APPROVAL_REQUIRED_INTENTS = new Set([
  "delete_path",
  "empty_dir",
  "move_path",
  "bulk_move",
  "run_terminal",
]);

/**
 * True when an intent must be approved by a human before it runs.
 * Destructive intents are gated regardless of which risk_level the model claims, so a
 * model that labels a delete as "low" cannot talk its way past the gate.
 */
export function requiresApproval(intent: string, riskLevel: string): boolean {
  return APPROVAL_REQUIRED_INTENTS.has(intent) || riskLevel === "high";
}

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
    abortSignal,
    requestApproval,
    autoApproveDestructive = false,
  } = opts;

  const log = (msg: string, type: AgentLog["type"] = "info", agentId: string = "System") => {
    onLog({ timestamp: new Date().toISOString(), agent: agentId, message: msg, type });
  };
  
  const ensureNotAborted = () => {
    if (abortSignal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  };

  // A denial is final for the rest of this run: the model otherwise happily re-asks the
  // same destructive action on the next step and nags the user forever.
  const deniedThisRun = new Set<string>();

  /**
   * Destructive and code-executing intents stop here until a human says yes.
   * Without an approval channel (scheduled runs) they are refused outright.
   */
  const gate = async (intent: string, detail: string, riskLevel: string, agentId: string): Promise<boolean> => {
    if (!requiresApproval(intent, riskLevel)) return true;

    if (autoApproveDestructive) {
      // The user approved the whole run before it started, so this line is a record of what
      // happened, not something that needs an answer. Logging it as a warning made a normal,
      // already-approved mission look like it was asking for permission on every step.
      log(`Utför ${intent}: ${detail} (täcks av körningens godkännande)`, "info", agentId);
      return true;
    }

    const key = `${intent}\u0000${detail}`;
    if (deniedThisRun.has(key)) {
      log(`Refused without asking again: ${intent} — ${detail} was already denied.`, "warning", agentId);
      return false;
    }
    if (!requestApproval) {
      log(`BLOCKED ${intent} (${detail}): no approval channel on this run.`, "warning", agentId);
      return false;
    }
    log(`Waiting for human approval: ${intent} — ${detail} (risk: ${riskLevel})`, "warning", agentId);
    const approved = await requestApproval({ intent, detail, riskLevel });
    ensureNotAborted();
    if (!approved) deniedThisRun.add(key);
    log(approved ? `Approved by user: ${intent} — ${detail}` : `Denied by user: ${intent} — ${detail}`, approved ? "success" : "warning", agentId);
    return approved;
  };

  const denied = (intent: string, detail: string) => ({
    ok: false,
    error:
      `Denied: ${intent} on ${detail} was not approved by the user. ` +
      `Do NOT retry this action; choose a different approach or finish with 'done'.`,
  });

  const requestedSequence = (opts.agentSequence || []).filter((a) => AGENT_PERSONAS[a]);
  const agentSequence = requestedSequence.length ? requestedSequence : ["scout", "brainstormer", "coder", "reviewer", "auditor", "security"];
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
        note:
          "You have full control over these directories AND ALL THEIR SUBDIRECTORIES. Please use absolute paths (e.g. C:/path/to/dir) when moving/copying between different roots to ensure it goes exactly where you want. " +
          "Anything outside allowed_sandboxes is refused automatically, and permissions cannot be extended while the mission runs — so never ask for another folder. " +
          "If a path is refused, use the folders in allowed_sandboxes instead, or finish with 'done' and explain what was missing.",
      }),
    },
  ];

  let lastSummary = "Mission incomplete.";
  // Warn about an impractically slow model once per run, not once per step.
  let warnedAboutSlowModel = false;

  for (let step = 0; step < maxSteps; step++) {
    ensureNotAborted();
    const currentAgentId = agentSequence[currentAgentIndex];
    const currentAgentName = currentAgentId.charAt(0).toUpperCase() + currentAgentId.slice(1);
    
    log(`Step ${step + 1}: calling Ollama (${currentAgentName})...`, "info", currentAgentId);
    let raw: string;
    try {
      raw = await ollamaChat(
        ollamaBaseUrl,
        ollamaModel,
        messages,
        abortSignal,
        (progress) => {
          const seconds = Math.round(progress.elapsedMs / 1000);
          if (progress.tokens === 0) {
            // The model is still reading the prompt. This is the phase that used to look
            // like a freeze, so say plainly what is happening and for how long.
            log(`bearbetar uppdraget (modellen läser prompten)… ${seconds} s`, "info", currentAgentId);
            return;
          }
          log(
            `arbetar… ${progress.tokens} tokens på ${seconds} s (${progress.tokensPerSecond.toFixed(1)} tok/s)`,
            "info",
            currentAgentId
          );
          if (!warnedAboutSlowModel && progress.tokens >= 40 && progress.tokensPerSecond < SLOW_MODEL_TOKENS_PER_SEC) {
            warnedAboutSlowModel = true;
            log(
              `VARNING: ${ollamaModel} genererar bara ${progress.tokensPerSecond.toFixed(1)} tok/s. ` +
                `Vid den hastigheten tar en körning med flera agenter timmar. ` +
                `Välj en mindre Gemma 4-modell i UPPDRAGSMÅL (t.ex. gemma4:e4b) för att slippa vänta.`,
              "warning",
              currentAgentId
            );
          }
        },
        currentAgentId
      );
    } catch (e: any) {
      if (e?.name === "AbortError" || abortSignal?.aborted) {
        throw e;
      }
      log(`Ollama error: ${e.message}`, "error", currentAgentId);
      throw e;
    }
    messages.push({ role: "assistant", content: raw });
    ensureNotAborted();

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
      // Nobody can answer mid-run (that is the whole point of the up-front approval), so the
      // answer must be unambiguous: no permission can be granted and here is what IS allowed.
      // A vague placeholder here is what made a model keep hunting for a folder it could
      // never get instead of finishing the mission inside the sandbox.
      messages.push({
        role: "user",
        content: JSON.stringify({
          answer:
            "Ingen människa kan svara under en pågående körning och behörigheter kan inte ändras. " +
            `De enda tillåtna mapparna är: ${sandboxRoots.map((r) => `"${r}"`).join(", ")}. ` +
            "Lös uppdraget inom dem med de verktyg du har, eller avsluta med 'done' och förklara i summary vad som inte gick.",
        }),
      });
      log(
        `Agenten ville fråga: ${q} — inget svar kan ges under körningen, så den hänvisades till de godkända mapparna.`,
        "info",
        currentAgentId
      );
      continue;
    }

    if (intent === "read_file") {
      ensureNotAborted();
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
      ensureNotAborted();
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
        log(`Listed ${rel}`, "success", currentAgentId);
      } catch (e: any) {
        messages.push({
          role: "user",
          content: JSON.stringify({ ok: false, path: rel, error: String(e.message || e) }),
        });
        log(`list_dir nekades: ${e.message}`, "error", currentAgentId);
      }
      continue;
    }

    if (intent === "search_files") {
      ensureNotAborted();
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
      ensureNotAborted();
      const rel = String(obj.path);
      try {
        const safe = validateSandboxPath(sandboxRoots, rel);
        if (isSandboxRoot(sandboxRoots, safe)) {
          throw new Error("Förbjudet: Du försöker tömma själva rot-mappen (sandboxen)! Välj en undermapp istället.");
        }
        if (!(await gate("empty_dir", rel, String(obj.risk_level), currentAgentId))) {
          messages.push({ role: "user", content: JSON.stringify({ ...denied("empty_dir", rel), path: rel }) });
          continue;
        }
        if (!fs.existsSync(safe)) throw new Error("Path does not exist");
        const entries = fs.readdirSync(safe);
        for (const entry of entries) {
          ensureNotAborted();
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
      ensureNotAborted();
      const rel = String(obj.path);
      try {
        const safe = validateSandboxPath(sandboxRoots, rel);
        if (isSandboxRoot(sandboxRoots, safe)) {
           throw new Error("Förbjudet: Du försöker radera själva rot-mappen (sandboxen)! Välj en undermapp istället.");
        }
        if (!(await gate("delete_path", rel, String(obj.risk_level), currentAgentId))) {
          messages.push({ role: "user", content: JSON.stringify({ ...denied("delete_path", rel), path: rel }) });
          continue;
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
      ensureNotAborted();
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
      ensureNotAborted();
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

        if (!(await gate("move_path", `${srcRel} -> ${dstRel}`, String(obj.risk_level), currentAgentId))) {
          messages.push({
            role: "user",
            content: JSON.stringify({ ...denied("move_path", `${srcRel} -> ${dstRel}`), source: srcRel, destination: dstRel }),
          });
          continue;
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
      ensureNotAborted();
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
      ensureNotAborted();
      const exts = normalizeExtensions(obj.extensions);
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
          ensureNotAborted();
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
        const copyNote =
          copiedCount === 0
            ? `Inga filer matchade ${JSON.stringify(exts)} i ${srcDirRel}. Kontrollera filändelserna (t.ex. [".png"]) och att filerna ligger direkt i mappen — bulk_copy tittar inte i undermappar.`
            : undefined;
        messages.push({
          role: "user",
          content: JSON.stringify({
            ok: true,
            source_dir: srcDirRel,
            destination_dir: dstRel,
            copied_items: copiedCount,
            ...(copyNote ? { warning: copyNote } : {}),
          }),
        });
        if (copyNote) {
          log(`Bulk copy kopierade 0 filer: ${copyNote}`, "warning", currentAgentId);
        } else {
          log(`Bulk copied ${copiedCount} items (files/dirs) to ${dstRel}`, "success");
        }
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
      ensureNotAborted();
      const exts = normalizeExtensions(obj.extensions);
      const dstRel = String(obj.destination_dir || obj.destination);
      const srcDirRel = String(obj.source_dir || obj.source || ".");
      try {
        const safeSrcDir = validateSandboxPath(sandboxRoots, srcDirRel);
        const safeDst = validateSandboxPath(sandboxRoots, dstRel);
        if (!fs.existsSync(safeDst)) {
          fs.mkdirSync(safeDst, { recursive: true });
        }

        if (!(await gate("bulk_move", `${srcDirRel} -> ${dstRel}`, String(obj.risk_level), currentAgentId))) {
          messages.push({ role: "user", content: JSON.stringify(denied("bulk_move", `${srcDirRel} -> ${dstRel}`)) });
          continue;
        }
        
        const files = fs.readdirSync(safeSrcDir, { withFileTypes: true });
        let movedCount = 0;
        const moveAll = exts.includes("*");
        
        for (const f of files) {
          ensureNotAborted();
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
        
        const moveNote =
          movedCount === 0
            ? `Inga filer matchade ${JSON.stringify(exts)} i ${srcDirRel}. Kontrollera filändelserna (t.ex. [".png"]) och att filerna ligger direkt i mappen — bulk_move tittar inte i undermappar.`
            : undefined;
        messages.push({
          role: "user",
          content: JSON.stringify({
            ok: true,
            moved_items: movedCount,
            destination: dstRel,
            ...(moveNote ? { warning: moveNote } : {}),
          }),
        });
        if (moveNote) {
          log(`Bulk move flyttade 0 filer: ${moveNote}`, "warning", currentAgentId);
        } else {
          log(`Bulk moved ${movedCount} items (files/dirs) to ${dstRel}`, "success");
        }
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
      ensureNotAborted();
      const argv = obj.argv as string[];
      const cwdRel = String(obj.cwd || ".");
      try {
        const safeCwd = validateSandboxPath(sandboxRoots, cwdRel);
        if (!(await gate("run_terminal", argv.join(" "), String(obj.risk_level), currentAgentId))) {
          messages.push({ role: "user", content: JSON.stringify(denied("run_terminal", argv.join(" "))) });
          continue;
        }
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
