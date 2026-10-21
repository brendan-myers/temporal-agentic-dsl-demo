"""What the agent is given: a fixed system prompt, its tools, and a first
message carrying the workflow JSON and run inputs verbatim.

The prompt and tools are plain files next to this module, so they're easy to
read and edit on their own (the builder imports them for its preview):

- system-prompt.md   the system prompt, the same for every workflow
- agent-tools.json   the generic tools this workflow handles itself
- tool-catalog.json  the domain tools, run by the execute_tool activity
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent

SYSTEM_PROMPT: str = (HERE / "system-prompt.md").read_text().rstrip("\n")
AGENT_TOOLS: list[dict[str, Any]] = json.loads((HERE / "agent-tools.json").read_text())
TOOL_CATALOG: list[dict[str, Any]] = json.loads((HERE / "tool-catalog.json").read_text())
TOOLS_BY_NAME: dict[str, dict[str, Any]] = {t["name"]: t for t in TOOL_CATALOG}

# The generic tools, which the workflow handles itself.
REPORT_STEP, ASK_HUMAN, WAIT, FINISH = "report_step", "ask_human", "wait", "finish"
if {t["name"] for t in AGENT_TOOLS} != {REPORT_STEP, ASK_HUMAN, WAIT, FINISH}:
    raise RuntimeError(f"{HERE / 'agent-tools.json'} must define exactly report_step, ask_human, wait and finish")


def build_tool_defs() -> list[dict[str, Any]]:
    """The agent's tools: the generic ones plus every tool in the catalog."""
    domain = [
        {
            "name": t["name"],
            "description": t["description"],
            "input_schema": {"type": "object", "properties": t["params"], "required": t["required"], "additionalProperties": False},
        }
        for t in TOOL_CATALOG
    ]
    return AGENT_TOOLS + domain


def first_message(definition: dict[str, Any], inputs: dict[str, Any]) -> str:
    """The workflow JSON and run inputs, verbatim."""
    return (
        f"Workflow definition:\n\n```json\n{json.dumps(definition, indent=2, ensure_ascii=False)}\n```\n\n"
        f"Run inputs:\n\n```json\n{json.dumps(inputs, indent=2, ensure_ascii=False)}\n```\n\n"
        "Execute the workflow now."
    )
