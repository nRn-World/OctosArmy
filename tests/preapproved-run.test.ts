import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOllamaAgentLoop, type AgentLog } from "../ollamaAgent.ts";

/**
 * Stand-in for Ollama. It answers /api/chat with a fixed script of JSON tool calls, so the
 * agent loop can be driven without a real model.
 */
type ScriptedReply = unknown | ((messages: { role: string; content: string }[]) => unknown);

async function startFakeOllama(script: ScriptedReply[]) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let messages: { role: string; content: string }[] = [];
      try {
        messages = JSON.parse(body).messages || [];
      } catch (e) {}
      const entry = script[Math.min(calls, script.length - 1)];
      const reply = typeof entry === "function" ? (entry as (m: typeof messages) => unknown)(messages) : entry;
      calls += 1;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        JSON.stringify({
          model: "fake",
          message: { role: "assistant", content: JSON.stringify(reply) },
          done: true,
        }) + "\n"
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function makeSourceDir(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "octos-preapproved-")));
  fs.mkdirSync(path.join(root, "in"));
  fs.writeFileSync(path.join(root, "in", "a.png"), "a");
  fs.writeFileSync(path.join(root, "in", "b.png"), "b");
  fs.writeFileSync(path.join(root, "in", "notes.txt"), "t");
  return root;
}

/** The model writes the extension without a dot, exactly as it did in the real mission. */
function bulkMoveScript(root: string): unknown[] {
  return [
    {
      intent: "bulk_move",
      extensions: ["png"],
      source: path.join(root, "in"),
      destination: path.join(root, "out"),
      rationale: "flytta bilderna",
      risk_level: "medium",
    },
    { intent: "done", summary: "klart", rationale: "klart", risk_level: "low" },
  ];
}

type RunResult = { logs: AgentLog[]; approvalRequests: number; summary: string };

async function runOnce(root: string, fakeBaseUrl: string, autoApproveDestructive: boolean): Promise<RunResult> {
  const logs: AgentLog[] = [];
  let approvalRequests = 0;
  const summary = await runOllamaAgentLoop({
    ollamaBaseUrl: fakeBaseUrl,
    ollamaModel: "fake",
    sandboxRoots: [root],
    mission: "flytta png-filerna",
    maxSteps: 4,
    terminalTimeoutSec: 5,
    maxTerminalOutputChars: 1000,
    agentSequence: ["scout"],
    autoApproveDestructive,
    requestApproval: async () => {
      approvalRequests += 1;
      return false; // a denial must be the end of the action
    },
    onLog: (log) => logs.push(log),
  });
  return { logs, approvalRequests, summary };
}

test("a pre-approved run moves files without ever stopping to ask", async () => {
  const root = makeSourceDir();
  const fake = await startFakeOllama(bulkMoveScript(root));
  try {
    const { logs, approvalRequests } = await runOnce(root, fake.baseUrl, true);

    assert.equal(approvalRequests, 0, "the run was already approved and must not ask again");
    assert.deepEqual(fs.readdirSync(path.join(root, "in")).sort(), ["notes.txt"]);
    assert.deepEqual(fs.readdirSync(path.join(root, "out")).sort(), ["a.png", "b.png"]);

    // ["png"] without the leading dot used to match nothing while still reporting success.
    const moved = logs.find((l) => l.message.includes("Bulk moved 2 items"));
    assert.ok(moved, `expected a success log, got: ${logs.map((l) => l.message).join(" | ")}`);
    assert.equal(moved.type, "success");

    const covered = logs.find((l) => l.message.includes("täcks av körningens godkännande"));
    assert.ok(covered, "the destructive step must still be recorded in the log");
    assert.equal(covered.type, "info", "an already-approved step must not be logged as a warning");
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("without the up-front approval the same run still asks, and a denial blocks it", async () => {
  const root = makeSourceDir();
  const fake = await startFakeOllama(bulkMoveScript(root));
  try {
    const { logs, approvalRequests } = await runOnce(root, fake.baseUrl, false);

    assert.equal(approvalRequests, 1, "an unapproved run must ask exactly once for bulk_move");
    assert.deepEqual(fs.readdirSync(path.join(root, "in")).sort(), ["a.png", "b.png", "notes.txt"]);
    assert.equal(fs.existsSync(path.join(root, "out")) && fs.readdirSync(path.join(root, "out")).length, 0);

    assert.ok(
      logs.some((l) => l.message.includes("Waiting for human approval")),
      "the user must be told why the run is paused"
    );
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a refused list_dir is reported as refused, not as a successful listing", async () => {
  const root = makeSourceDir();
  const outside = path.dirname(root); // the parent of a granted root is not granted
  const fake = await startFakeOllama([
    { intent: "list_dir", path: outside, rationale: "titta utanför sandlådan", risk_level: "low" },
    { intent: "done", summary: "klart", rationale: "klart", risk_level: "low" },
  ]);
  try {
    const { logs } = await runOnce(root, fake.baseUrl, true);

    // The old behaviour logged "Listed <path>" as a success and hid the security error in
    // the listing field, which told the model its blocked call had worked.
    assert.ok(
      !logs.some((l) => l.message.startsWith("Listed ")),
      `a refused listing must not be reported as success: ${logs.map((l) => l.message).join(" | ")}`
    );
    const refused = logs.find((l) => l.message.includes("list_dir nekades"));
    assert.ok(refused, `expected a refusal log, got: ${logs.map((l) => l.message).join(" | ")}`);
    assert.equal(refused.type, "error");
    assert.ok(
      refused.message.includes(root),
      "the refusal must name the folders that actually are allowed"
    );
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an agent asking for more permission is answered with the allowed folders, not silence", async () => {
  const root = makeSourceDir();
  const fake = await startFakeOllama([
    {
      intent: "ask_user",
      question: "Får jag använda C:\\Users\\Admin\\Desktop\\TEST1 i stället?",
      rationale: "behöver en mapp utanför sandlådan",
      risk_level: "medium",
    },
    // Echo back whatever answer the loop gave the model, so the test can read it.
    (messages: { role: string; content: string }[]) => ({
      intent: "done",
      summary: String(messages[messages.length - 1]?.content || ""),
      rationale: "klart",
      risk_level: "low",
    }),
  ]);
  try {
    const { summary, approvalRequests } = await runOnce(root, fake.baseUrl, true);

    assert.equal(approvalRequests, 0, "asking a question must not turn into a blocking prompt");
    assert.ok(
      summary.includes("behörigheter kan inte ändras"),
      `the answer must state that permissions cannot change: ${summary}`
    );
    // The answer travels as JSON, so Windows separators arrive escaped (C:\\Users\...).
    const readable = summary.replace(/\\\\/g, "\\");
    assert.ok(readable.includes(root), `the answer must list the folders that are allowed: ${summary}`);
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a bulk_move that matches nothing says so instead of reporting success", async () => {
  const root = makeSourceDir();
  const fake = await startFakeOllama([
    {
      intent: "bulk_move",
      extensions: [".jpg"],
      source: path.join(root, "in"),
      destination: path.join(root, "out"),
      rationale: "flytta jpg",
      risk_level: "low",
    },
    { intent: "done", summary: "klart", rationale: "klart", risk_level: "low" },
  ]);
  try {
    const { logs } = await runOnce(root, fake.baseUrl, true);
    const warning = logs.find((l) => l.message.includes("Bulk move flyttade 0 filer"));
    assert.ok(warning, `expected a 0-file warning, got: ${logs.map((l) => l.message).join(" | ")}`);
    assert.equal(warning.type, "warning");
    assert.ok(!logs.some((l) => l.message.includes("Bulk moved")));
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
