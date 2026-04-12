from __future__ import annotations

import argparse
import sys

from octosync.config import load_settings
from octosync.main_agent import run_order


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="OctoSync AI — main agent via Ollama (sandbox)."
    )
    p.add_argument("order", help="Task / instruction for the agent")
    p.add_argument(
        "--sandbox",
        dest="sandbox",
        default=None,
        help="Absolute path to sandbox directory (overrides SANDBOX_ROOT)",
    )
    p.add_argument(
        "--ollama-url",
        dest="ollama_url",
        default=None,
        help="Ollama base URL, default http://localhost:11434 or OLLAMA_BASE_URL",
    )
    p.add_argument(
        "--model",
        dest="model",
        default=None,
        help="Ollama model name, e.g. gemma2:9b (overrides OLLAMA_MODEL)",
    )
    args = p.parse_args(argv)

    try:
        settings = load_settings(
            sandbox_root=args.sandbox,
            ollama_base_url=args.ollama_url,
            ollama_model=args.model,
        )
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2

    result = run_order(settings, args.order)
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
