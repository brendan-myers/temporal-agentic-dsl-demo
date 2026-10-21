"""Workflow tests on Temporal's time-skipping test server, with a scripted model.

The scripted model checks what the workflow sends it and replies with tool
calls, so these cover the workflow's plumbing without an API key.
"""

import asyncio
import json
import uuid
from datetime import timedelta
from typing import Any, Callable

import pytest
from temporalio import activity
from temporalio.client import WorkflowHandle, WorkflowUpdateFailedError
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from activities.llm import LlmRequest, LlmTurn
from activities.tools import execute_tool
from agent.models import AgentWorkflowInput, HumanInputUpdate, LlmConfig, RunState
from workflows.agent_workflow import AgentWorkflow

Reply = tuple[str, dict[str, Any]] | str  # a tool call (name, input), or plain text


def scripted_model(script: Callable[[list[Any]], Reply]):
    """A call_llm stand-in: `script` gets the latest tool results and returns the next reply."""

    @activity.defn(name="call_llm")
    async def call_llm(request: LlmRequest) -> LlmTurn:
        last = request.messages[-1]["content"]
        results = [json.loads(b["content"]) if not b.get("is_error") else b["content"] for b in last] if isinstance(last, list) else []
        reply = script(results)
        if isinstance(reply, str):
            return LlmTurn(content=[{"type": "text", "text": reply}], stop_reason="end_turn")
        name, args = reply
        return LlmTurn(content=[{"type": "tool_use", "id": str(uuid.uuid4()), "name": name, "input": args}], stop_reason="tool_use")

    return call_llm


async def run_with(model, definition: dict, inputs: dict, drive=None) -> tuple[RunState, Any]:
    """Run on a fresh time-skipping server; `drive` can interact with the run. Returns (state, result)."""
    async with await WorkflowEnvironment.start_time_skipping(data_converter=pydantic_data_converter) as env:
        task_queue = str(uuid.uuid4())
        async with Worker(env.client, task_queue=task_queue, workflows=[AgentWorkflow], activities=[model, execute_tool]):
            handle = await env.client.start_workflow(
                AgentWorkflow.run,
                AgentWorkflowInput(definition=definition, inputs=inputs, llm=LlmConfig(model="test")),
                id=str(uuid.uuid4()),
                task_queue=task_queue,
            )
            if drive:
                await drive(env, handle)
            result = await handle.result()
            return await handle.query(AgentWorkflow.get_state), result


async def waiting_for_human(handle: WorkflowHandle, nth: int = 1) -> RunState:
    for _ in range(200):
        state = await handle.query(AgentWorkflow.get_state)
        if state.pending_human and sum(e["kind"] == "human_request" for e in state.events) >= nth:
            return state
        await asyncio.sleep(0.05)
    raise AssertionError("run never asked for input")


async def test_any_json_is_just_context():
    """The workflow never interprets the definition: it reaches the model verbatim, and errors go back to it."""
    definition = {"name": "Not our DSL at all", "plan": ["refund something", "done"]}
    seen: list[list[Any]] = []
    first_messages: list[str] = []
    replies = iter(
        [
            ("report_step", {"step_id": "refund", "note": "Refunding"}),
            ("no_such_tool", {}),
            ("issue_refund", {"order_id": "ORD-1", "amount": -5}),
            ("finish", {"output": {"done": True}}),
        ]
    )

    @activity.defn(name="call_llm")
    async def model(request: LlmRequest) -> LlmTurn:
        first_messages.append(request.messages[0]["content"])
        last = request.messages[-1]["content"]
        seen.append([b["content"] for b in last] if isinstance(last, list) else [])
        name, args = next(replies)
        return LlmTurn(content=[{"type": "tool_use", "id": str(uuid.uuid4()), "name": name, "input": args}], stop_reason="tool_use")

    state, result = await run_with(model, definition, {"x": 1})
    assert json.dumps(definition, indent=2) in first_messages[0]
    assert '"x": 1' in first_messages[0]
    assert 'There is no tool "no_such_tool"' in seen[2][0]
    assert "amount must be a positive number" in seen[3][0]
    assert state.status == "completed" and result.output == {"done": True}
    assert result.steps == ["refund"]


async def test_timeout_and_answers_go_back_to_the_model():
    """ask_human times out, then gets an answer whose value sets the length of a wait."""
    steps = iter(["ask", "ask again", "wait", "finish"])
    received: list[Any] = []

    def script(results):
        received.append(results)
        step = next(steps)
        if step in ("ask", "ask again"):
            fields = {"ok": {"type": "boolean", "required": True}, "settle_for": {"type": "duration"}}
            return ("ask_human", {"step_id": "ack", "prompt": "Ack?", "fields": fields, "timeout": "2m"})
        if step == "wait":
            return ("wait", {"step_id": "settle", "duration": results[0]["response"]["settle_for"]})
        return ("finish", {"output": {}})

    async def drive(env, handle):
        await waiting_for_human(handle, nth=1)
        await env.sleep(timedelta(minutes=3))  # past the 2m timeout
        state = await waiting_for_human(handle, nth=2)
        assert state.pending_human.timeout_at - state.pending_human.requested_at == 120_000
        with pytest.raises(WorkflowUpdateFailedError) as rejected:
            await handle.execute_update(AgentWorkflow.submit_human_input, HumanInputUpdate(node_id="ack", values={"settle_for": "soon"}))
        assert '"ok" is required' in str(rejected.value.cause)
        await handle.execute_update(AgentWorkflow.submit_human_input, HumanInputUpdate(node_id="ack", values={"ok": True, "settle_for": "30m"}))

    state, _ = await run_with(scripted_model(script), {"name": "Ack then wait"}, {}, drive)
    assert received[1] == [{"timedOut": True}]
    assert received[2] == [{"response": {"ok": True, "settle_for": "30m"}}]
    assert next(e for e in state.events if e["kind"] == "wait")["duration"] == "30m"


async def test_nudges_a_model_that_stops_early():
    replies = iter(["I think we're done.", ("finish", {"output": {}})])
    state, _ = await run_with(scripted_model(lambda _: next(replies)), {"name": "x"}, {})
    assert [e["kind"] for e in state.events if e["kind"] in ("nudge", "finish")] == ["nudge", "finish"]
