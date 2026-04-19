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

/** Ollama-only: always use local engine */
export function useOllamaEngine(): boolean {
  return true;
}

/** Runs the JSON tool loop on the server (Ollama + sandbox). */
export async function runOllamaServerPipeline(
  onLog: (log: AgentLog) => void,
  mission: string,
  signal?: AbortSignal
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
    signal,
  });
  let data: any;
  try {
    data = await parseJsonResponse(res);
  } catch (e: any) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    onLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: e.message || String(e),
      type: "error",
    });
    return { summary: "" };
  }
  if (!res.ok) {
    if (res.status === 499 || String(data?.error || "").toLowerCase() === "aborted") {
      throw new DOMException("Aborted", "AbortError");
    }
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
