"""Start a workflow from the command line and follow it in the terminal.

    uv run python start_workflow.py ../web/src/examples/refund-triage.json
    uv run python start_workflow.py ../web/src/examples/refund-triage.json -i order_id=ORD-2001

Any workflow JSON works, e.g. one saved with Export in the builder.

Needs the worker running (`uv run python worker.py`, or `pnpm worker` from the
repo root). Prints each step as the agent reports it, and asks you in the
terminal whenever the agent asks a person. The run also shows up in the web
UI, so you can answer there instead.
"""

import argparse
import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from temporalio.client import Client, WorkflowFailureError, WorkflowUpdateFailedError
from temporalio.contrib.pydantic import pydantic_data_converter

from agent.models import AgentWorkflowInput, FormField, HumanInputUpdate, HumanRequest, LlmConfig, RunState
from workflows.agent_workflow import AgentWorkflow

load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a workflow JSON on the agent workflow.")
    parser.add_argument("workflow", type=Path, help="Workflow JSON, e.g. ../web/src/examples/refund-triage.json or a file exported from the builder")
    parser.add_argument("-i", "--input", action="append", default=[], metavar="NAME=VALUE", help="Set a run input (repeatable)")
    return parser.parse_args()


def coerce(value: str, field_type: str | None) -> Any:
    """Turn typed text into the JSON value a field expects."""
    if field_type == "number":
        return float(value) if "." in value else int(value)
    if field_type == "boolean":
        return value.strip().lower() in ("y", "yes", "true", "1")
    return value


def run_inputs(definition: dict[str, Any], overrides: list[str]) -> dict[str, Any]:
    """The definition's default inputs, with -i overrides; asks for required ones that are still missing."""
    fields: dict[str, Any] = definition.get("inputs", {})
    inputs = {name: f["default"] for name, f in fields.items() if "default" in f}
    for item in overrides:
        name, _, value = item.partition("=")
        inputs[name] = coerce(value, fields.get(name, {}).get("type"))
    for name, f in fields.items():
        while f.get("required") and inputs.get(name) in (None, ""):
            inputs[name] = coerce(input(f"{name} ({f['type']}): "), f["type"])
    return inputs


def ask(request: HumanRequest) -> dict[str, Any]:
    """Show the agent's question and read each form field from the terminal."""
    who = f"[{request.assignee}] " if request.assignee else ""
    print(f"\n  ? {who}{request.prompt}")
    values: dict[str, Any] = {}
    for name, field in request.form.items():
        values.update(ask_field(name, field))
    return values


def ask_field(name: str, field: FormField) -> dict[str, Any]:
    hint = {"boolean": "y/n", "duration": "e.g. 30s, 10m, 2h"}.get(field.type, field.type)
    label = f"    {name}{'' if field.required else ' (optional)'} [{hint}]: "
    while True:
        text = input(label).strip()
        if not text and not field.required:
            return {}
        if text:
            try:
                return {name: coerce(text, field.type)}
            except ValueError:
                pass
        print(f"    please enter a {hint} value")


def short(value: Any, limit: int = 120) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def show(event: dict[str, Any]) -> None:
    """One line per event, in the same terms as the UI's timeline."""
    kind = event["kind"]
    if kind == "enter":
        print(f"\n→ {event['nodeId']}: {event['reason']}")
    elif kind == "thought":
        print(f"  {event['text']}")
    elif kind == "tool_call":
        print(f"  ⚙ {event['tool']}({short(event['input'])})")
    elif kind == "tool_result":
        mark = "✗" if event["isError"] else "✓"
        print(f"    {mark} {short(event['output'])}")
    elif kind == "human_response":
        print("    (timed out)" if event["timedOut"] else f"    answered: {short(event['values'])}")
    elif kind == "wait":
        print(f"  ⏱ waiting {event['duration']}")
    elif kind in ("rejected", "nudge", "error"):
        print(f"  ! {event.get('message') or event.get('text')}")


async def main() -> None:
    args = parse_args()
    definition = json.loads(args.workflow.read_text())
    inputs = run_inputs(definition, args.input)
    model = os.environ.get("ANTHROPIC_MODEL") or "claude-opus-5-5"

    client = await Client.connect(
        os.environ.get("TEMPORAL_ADDRESS") or "localhost:7233",
        namespace=os.environ.get("TEMPORAL_NAMESPACE") or "default",
        data_converter=pydantic_data_converter,
    )
    workflow_id = f"{definition.get('id', 'workflow')}-{uuid.uuid4().hex[:8]}"
    handle = await client.start_workflow(
        AgentWorkflow.run,
        AgentWorkflowInput(definition=definition, inputs=inputs, llm=LlmConfig(model=model, effort=os.environ.get("ANTHROPIC_EFFORT") or None)),
        id=workflow_id,
        task_queue=os.environ.get("TASK_QUEUE") or "agent-workflows",
        # So the run shows up in the web UI's run list.
        memo={"workflowName": definition.get("name", workflow_id), "model": model, "flowId": definition.get("id")},
    )
    print(f"Started {workflow_id} on {model} with inputs {json.dumps(inputs)}")
    print(f"Temporal UI: http://localhost:8233/namespaces/default/workflows/{workflow_id}")

    seen = 0
    answered: set[int] = set()
    while True:
        state: RunState = await handle.query(AgentWorkflow.get_state)
        for event in state.events[seen:]:
            show(event)
        seen = len(state.events)

        request = state.pending_human
        if request and request.requested_at not in answered:
            answered.add(request.requested_at)
            while True:
                try:
                    await handle.execute_update(AgentWorkflow.submit_human_input, HumanInputUpdate(node_id=request.node_id, values=ask(request)))
                    break
                except WorkflowUpdateFailedError as e:
                    reason = str(e.cause or e)
                    print(f"    not accepted: {reason}")
                    if "not waiting" in reason:  # timed out, or answered in the UI
                        break

        if state.status in ("completed", "failed"):
            break
        await asyncio.sleep(1)

    try:
        result = await handle.result()
        print(f"\nDone. Steps: {' → '.join(result.steps)}")
        print(json.dumps(result.output, indent=2))
    except WorkflowFailureError as e:
        print(f"\nFailed: {e.cause or e}")


if __name__ == "__main__":
    asyncio.run(main())
