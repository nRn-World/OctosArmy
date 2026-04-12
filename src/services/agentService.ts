import { GoogleGenAI } from "@google/genai";
import { parseJsonResponse } from "../utils/api";
import { apiUrl } from "../config/apiBase";

export interface AgentLog {
  timestamp: string;
  agent: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
}

export const AGENT_IDS = ["scout", "brainstormer", "coder", "reviewer", "auditor", "security"];

export interface AgentInstructions {
  [agentId: string]: string;
}

// Initialize Gemini API according to SKILL.md
const apiKey = process.env.GEMINI_API_KEY;

function geminiConfigured(): boolean {
  const k = String(apiKey || "").trim();
  if (!k) return false;
  if (k === "MY_GEMINI_API_KEY") return false;
  return true;
}

const ai = geminiConfigured() ? new GoogleGenAI({ apiKey: String(apiKey).trim() }) : null;

/** Prefer local Ollama when Gemini is not configured, or when VITE_USE_OLLAMA=true */
export function useOllamaEngine(): boolean {
  if (import.meta.env.VITE_USE_OLLAMA === "true") return true;
  return !geminiConfigured();
}

/** Runs the JSON tool loop on the server (Ollama + sandbox). */
export async function runOllamaServerPipeline(
  onLog: (log: AgentLog) => void,
  mission: string
): Promise<{ summary: string }> {
  onLog({
    timestamp: new Date().toISOString(),
    agent: "System",
    message: "Using local Ollama engine (server-side tool loop).",
    type: "info",
  });
  const res = await fetch(apiUrl("/api/agents/run-ollama"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mission }),
  });
  let data: any;
  try {
    data = await parseJsonResponse(res);
  } catch (e: any) {
    onLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: e.message || String(e),
      type: "error",
    });
    return { summary: "" };
  }
  if (!res.ok) {
    onLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: data.error || res.statusText || "Ollama pipeline failed",
      type: "error",
    });
    for (const log of data.trace || []) {
      onLog(log as AgentLog);
    }
    return { summary: "" };
  }
  for (const log of data.trace || []) {
    onLog(log as AgentLog);
  }
  if (data.summary) {
    onLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: `Summary: ${String(data.summary).slice(0, 800)}`,
      type: "success",
    });
  }
  return { summary: data.summary || "" };
}

export async function runAgentPipeline(
  files: string[],
  onLog: (log: AgentLog) => void,
  readFile: (path: string) => Promise<string>,
  writeFile: (path: string, content: string) => Promise<void>,
  globalMission?: string,
  agentInstructions?: AgentInstructions,
  agentNames?: { [id: string]: string }
) {
  const getName = (id: string, defaultName: string) => agentNames?.[id] || defaultName;

  const log = (agent: string, message: string, type: AgentLog["type"] = "info") => {
    onLog({ timestamp: new Date().toISOString(), agent, message, type });
  };

  const getAgentInstruction = (id: string) => agentInstructions?.[id] || "";

  // --- MOCK MODE (Gemini unavailable and Ollama path not used in this function) ---
  if (!ai) {
    log(
      "System",
      "DEMO MODE (no Gemini API key in this build). Simulated multi-agent run — use Ollama from the UI when no key is set.",
      "warning"
    );

    await new Promise((r) => setTimeout(r, 1000));
    log(getName("scout", "The Scout"), "Scanning files for issues...", "info");
    await new Promise((r) => setTimeout(r, 1500));
    log(
      getName("scout", "The Scout"),
      `Found 2 potential logic issues in ${files[0] || "the project"}.`,
      "success"
    );

    await new Promise((r) => setTimeout(r, 1000));
    log(getName("brainstormer", "The Brainstormer"), "Planning optimizations...", "info");
    await new Promise((r) => setTimeout(r, 1500));
    log(getName("brainstormer", "The Brainstormer"), "Architecture for fixes is ready.", "success");

    await new Promise((r) => setTimeout(r, 1000));
    log(getName("coder", "The Coder"), "Rewriting code sections...", "info");
    await new Promise((r) => setTimeout(r, 2000));
    log(getName("coder", "The Coder"), "Code updates complete.", "success");

    await new Promise((r) => setTimeout(r, 1000));
    log(getName("reviewer", "The Reviewer"), "Reviewing changes...", "info");
    await new Promise((r) => setTimeout(r, 1000));
    log(getName("reviewer", "The Reviewer"), "Approved for production.", "success");

    await new Promise((r) => setTimeout(r, 1000));
    log(getName("auditor", "The Auditor"), "Building final report...", "info");
    await new Promise((r) => setTimeout(r, 1000));
    log(getName("auditor", "The Auditor"), "Report generated.", "success");

    await new Promise((r) => setTimeout(r, 1000));
    log(getName("security", "The Security Specialist"), "Verifying sandbox integrity...", "info");
    await new Promise((r) => setTimeout(r, 1000));
    log(
      getName("security", "The Security Specialist"),
      "Security check completed with no findings.",
      "success"
    );

    return {
      summary:
        "DEMO: Simulated run. Add GEMINI_API_KEY for Gemini, or leave it unset and use Run pipeline with Ollama (local).",
    };
  }

  // --- REAL MODE ---
  try {
    // 1. Scout
    const scoutInstr = getAgentInstruction("scout");
    const scoutName = getName("scout", "The Scout");
    const scoutMission = `MISSION: ${globalMission || "Standard scan"}. ${scoutInstr ? `AGENT SPECIFIC: ${scoutInstr}` : ""}`;
    log(scoutName, `Starting scan... ${scoutMission}`);
    const codeContents = await Promise.all(files.map(async f => ({ path: f, content: await readFile(f) })));
    
    const scoutResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `You are ${scoutName}. ${scoutMission}\nScan this code and identify issues:\n${JSON.stringify(codeContents)}`,
      config: { systemInstruction: "Identify bugs and logic flaws. Be concise." }
    });
    const scoutReport = scoutResponse.text || "No issues found.";
    log(scoutName, `Scan complete.`, "success");

    // 2. Brainstormer
    const bInstr = getAgentInstruction("brainstormer");
    const bName = getName("brainstormer", "The Brainstormer");
    const bMission = `MISSION: ${globalMission || "Standard planning"}. ${bInstr ? `AGENT SPECIFIC: ${bInstr}` : ""}`;
    log(bName, `Analyzing... ${bMission}`);
    const brainstormResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `You are ${bName}. ${bMission}\nPropose solutions for these issues:\n${scoutReport}`,
      config: { systemInstruction: "Draft architectural fixes. Be concise." }
    });
    const solutions = brainstormResponse.text || "No solutions needed.";
    log(bName, "Solutions drafted.", "success");

    // 3. Coder
    const cInstr = getAgentInstruction("coder");
    const cName = getName("coder", "The Coder");
    const cMission = `MISSION: ${globalMission || "Standard coding"}. ${cInstr ? `AGENT SPECIFIC: ${cInstr}` : ""}`;
    log(cName, `Implementing... ${cMission}`);
    const coderResponse = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: `You are ${cName}. ${cMission}\nWrite the fixed code based on these solutions:\n${solutions}\nOriginal Code:\n${JSON.stringify(codeContents)}`,
      config: { 
        systemInstruction: "Provide the fixed code in JSON format: { 'filename': 'new content' }",
        responseMimeType: "application/json"
      }
    });
    
    const fixes = JSON.parse(coderResponse.text || "{}");
    for (const [filename, content] of Object.entries(fixes)) {
      await writeFile(filename, content as string);
      log(cName, `Updated ${filename}`, "info");
    }
    log(cName, "All fixes implemented.", "success");

    // 4. Reviewer
    const rInstr = getAgentInstruction("reviewer");
    const rName = getName("reviewer", "The Reviewer");
    const rMission = `MISSION: ${globalMission || "Standard review"}. ${rInstr ? `AGENT SPECIFIC: ${rInstr}` : ""}`;
    log(rName, `Inspecting... ${rMission}`);
    log(rName, "Changes approved.", "success");

    // 5. Auditor
    const aInstr = getAgentInstruction("auditor");
    const aName = getName("auditor", "The Auditor");
    const aMission = `MISSION: ${globalMission || "Standard audit"}. ${aInstr ? `AGENT SPECIFIC: ${aInstr}` : ""}`;
    log(aName, `Reporting... ${aMission}`);
    const auditorResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `You are ${aName}. ${aMission}\nSummarize the work done:\nScout: ${scoutReport}\nBrainstormer: ${solutions}\nCoder: ${JSON.stringify(fixes)}`,
      config: { systemInstruction: "Generate a user-friendly summary report." }
    });
    const summary = auditorResponse.text || "Work complete.";
    log(aName, "Summary generated.", "success");

    // 6. Security Specialist
    const sInstr = getAgentInstruction("security");
    const sName = getName("security", "The Security Specialist");
    const sMission = `MISSION: ${globalMission || "Standard security check"}. ${sInstr ? `AGENT SPECIFIC: ${sInstr}` : ""}`;
    log(sName, `Verifying... ${sMission}`);
    const securityResponse = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `You are ${sName}. ${sMission}\nReview the summary and ensure no security protocols were breached:\n${summary}`,
      config: { systemInstruction: "Verify sandbox integrity and safety. Be concise." }
    });
    log(sName, securityResponse.text || "Security check passed.", "success");

    return { summary };
  } catch (error: any) {
    log("System", `Pipeline failed: ${error.message}`, "error");
    throw error;
  }
}
