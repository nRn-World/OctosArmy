from __future__ import annotations

import json
from typing import Any

import requests

from octosync.config import Settings


def chat(settings: Settings, messages: list[dict[str, str]], *, temperature: float = 0.2) -> str:
    """
    Synchronous call to Ollama /api/chat (no streaming).
    Returns the assistant message content as a string.
    """
    url = f"{settings.ollama_base_url}/api/chat"
    payload: dict[str, Any] = {
        "model": settings.ollama_model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature},
    }
    resp = requests.post(url, json=payload, timeout=600)
    resp.raise_for_status()
    data = resp.json()
    msg = data.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, str):
        raise RuntimeError(f"Unexpected response from Ollama: {json.dumps(data)[:500]}")
    return content.strip()
