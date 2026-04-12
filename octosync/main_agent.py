from __future__ import annotations

import json
import re
from typing import Any

from octosync.config import Settings
from octosync.ollama_client import chat
from octosync.tools import ToolRunner

SYSTEM_PROMPT = """You are OctoSync AI main agent. You control tools inside ONE sandbox directory only.
You must NEVER request paths outside the sandbox. You must answer with a SINGLE JSON object per turn (no markdown fences, no extra text).

Allowed intents:
- read_file: read one file. Fields: intent, path (relative to sandbox), rationale, risk_level.
- list_dir: list files under a subpath. Fields: intent, path (optional, default "."), rationale, risk_level.
- run_terminal: run an allowlisted command. Fields: intent, argv (array of strings, first is python|git only), rationale, risk_level.
- ask_user: ask one clarifying question. Fields: intent, question, rationale, risk_level.
- done: finish. Fields: intent, summary, rationale, risk_level.

risk_level is one of: low, medium, high.

Examples:
{"intent":"read_file","path":"README.md","rationale":"Need file contents.","risk_level":"low"}
{"intent":"run_terminal","argv":["python","--version"],"rationale":"Check Python.","risk_level":"low"}
{"intent":"done","summary":"Task complete.","rationale":"All steps done.","risk_level":"low"}

Rules:
- Prefer read_file or list_dir before running terminals.
- run_terminal allowlist only: python --version; python -m pytest ...; python -m compileall ...; git status|diff|log|rev-parse.
- Never put shell metacharacters in argv.
- If the user order is unsafe or escapes sandbox, respond with intent ask_user or done explaining refusal.
"""


_JSON_FENCE = re.compile(r"^```(?:json)?\s*", re.IGNORECASE)


def _strip_code_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = _JSON_FENCE.sub("", t)
        if t.endswith("```"):
            t = t[: t.rfind("```")].strip()
    return t.strip()


def parse_agent_json(text: str) -> dict[str, Any]:
    cleaned = _strip_code_fence(text)
    return json.loads(cleaned)


def _validate_envelope(obj: dict[str, Any]) -> None:
    intent = obj.get("intent")
    if intent not in (
        "read_file",
        "list_dir",
        "run_terminal",
        "done",
        "ask_user",
    ):
        raise ValueError(f"Unknown intent: {intent!r}")
    for key in ("rationale", "risk_level"):
        if key not in obj or not isinstance(obj[key], str):
            raise ValueError(f"Missing or invalid type for field: {key}")
    if obj["risk_level"] not in ("low", "medium", "high"):
        raise ValueError("risk_level must be one of: low, medium, high")
    if intent == "done" and not str(obj.get("summary", "")).strip():
        raise ValueError("done requires a non-empty summary")
    if intent == "ask_user" and not str(obj.get("question", "")).strip():
        raise ValueError("ask_user requires question")
    if intent == "read_file" and not str(obj.get("path", "")).strip():
        raise ValueError("read_file requires path")
    if intent == "run_terminal":
        argv = obj.get("argv")
        if not isinstance(argv, list) or not argv:
            raise ValueError("run_terminal requires argv as a non-empty list")


def run_order(settings: Settings, order: str, *, ask_fn: Any | None = None) -> str:
    """
    Run the agent loop against Ollama until intent done or max steps.
    ask_fn: optional callback(question: str) -> str; if None, stdin input() is used.
    """
    tools = ToolRunner(settings)
    messages: list[dict[str, str]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "order": order,
                    "sandbox_root": settings.sandbox_root,
                    "note": "Only use relative paths inside the sandbox.",
                },
                ensure_ascii=False,
            ),
        },
    ]

    last_summary = ""
    for step in range(settings.max_agent_steps):
        raw = chat(settings, messages)
        messages.append({"role": "assistant", "content": raw})

        try:
            obj = parse_agent_json(raw)
            _validate_envelope(obj)
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            messages.append(
                {
                    "role": "user",
                    "content": f"Invalid JSON or schema: {e}. Reply with ONE JSON object only.",
                }
            )
            continue

        intent = obj["intent"]

        if intent == "done":
            last_summary = str(obj.get("summary", ""))
            return last_summary

        if intent == "ask_user":
            q = str(obj.get("question", ""))
            if ask_fn is not None:
                ans = ask_fn(q)
            else:
                ans = input(f"{q}\n> ")
            messages.append(
                {
                    "role": "user",
                    "content": json.dumps({"answer": ans}, ensure_ascii=False),
                }
            )
            continue

        if intent == "read_file":
            path = str(obj.get("path", ""))
            try:
                content = tools.read_file(path)
                obs = {"ok": True, "path": path, "content": content[:8000]}
            except Exception as e:
                obs = {"ok": False, "path": path, "error": str(e)}
            messages.append(
                {"role": "user", "content": json.dumps(obs, ensure_ascii=False)}
            )
            continue

        if intent == "list_dir":
            path = str(obj.get("path", "."))
            try:
                listing = tools.list_dir(path)
                obs = {"ok": True, "path": path, "listing": listing[:8000]}
            except Exception as e:
                obs = {"ok": False, "path": path, "error": str(e)}
            messages.append(
                {"role": "user", "content": json.dumps(obs, ensure_ascii=False)}
            )
            continue

        if intent == "run_terminal":
            argv = obj.get("argv")
            if not isinstance(argv, list) or not all(isinstance(x, str) for x in argv):
                obs = {"ok": False, "error": "argv must be array of strings"}
            else:
                try:
                    code, out, err = tools.run_terminal(argv)
                    obs = {
                        "ok": code == 0,
                        "exit_code": code,
                        "stdout": out,
                        "stderr": err,
                    }
                except Exception as e:
                    obs = {"ok": False, "error": str(e)}
            messages.append(
                {"role": "user", "content": json.dumps(obs, ensure_ascii=False)}
            )
            continue

    return last_summary or "Max steps reached without intent done."
