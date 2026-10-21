"""A basic, generic agent workflow.

Input: a workflow definition (JSON, never interpreted here) and run parameters.
Both go to the model verbatim. In a loop, the model decides what to do next;
the workflow just runs what it asks for:

- `call_llm` activity for each model turn, `execute_tool` activity for each tool
- `ask_human`: a durable wait on a validated Update, with an optional timeout
- `wait`: a durable timer
- `report_step`: records the step the agent says it's on (for the UI)
- `finish`: ends the run with the agent's output
"""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from typing import Any, NoReturn

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from pydantic import ValidationError

    from activities.llm import LlmRequest, LlmTurn, call_llm
    from activities.tools import ToolCall, execute_tool
    from agent.forms import DURATION_RE, duration_ms, validate_fields
    from agent.models import (
        AgentWorkflowInput,
        AgentWorkflowResult,
        FormField,
        HumanInputAccepted,
        HumanInputUpdate,
        HumanRequest,
        PathStep,
        RunState,
        Timer,
    )
    from agent.context import ASK_HUMAN, FINISH, REPORT_STEP, SYSTEM_PROMPT, TOOLS_BY_NAME, WAIT, build_tool_defs, first_message

DEFAULT_MAX_TURNS = 60
MAX_NUDGES = 3
LLM_RETRY = RetryPolicy(initial_interval=timedelta(seconds=2), maximum_attempts=5)
TOOL_RETRY = RetryPolicy(maximum_attempts=3)


class ToolInputError(Exception):
    """A tool call the workflow can't run as given; the message goes back to the agent."""


def _now_ms() -> int:
    return int(workflow.now().timestamp() * 1000)


@workflow.defn(name="agentWorkflow")
class AgentWorkflow:
    @workflow.init
    def __init__(self, input: AgentWorkflowInput) -> None:
        self.state = RunState(
            # Labels for the UI only.
            definition_id=str(input.definition.get("id", "")),
            definition_name=str(input.definition.get("name", "Workflow")),
            llm=input.llm,
            started_at=_now_ms(),
        )
        self.human_answer: dict[str, Any] | None = None

    @workflow.query(name="getState")
    def get_state(self) -> RunState:
        return self.state

    @workflow.update(name="submitHumanInput")
    def submit_human_input(self, update: HumanInputUpdate) -> HumanInputAccepted:
        self.human_answer = update.values
        return HumanInputAccepted()

    @submit_human_input.validator
    def validate_human_input(self, update: HumanInputUpdate) -> None:
        pending = self.state.pending_human
        if pending is None:
            raise ValueError("This run is not waiting for input")
        if update.node_id != pending.node_id:
            raise ValueError(f'Waiting on "{pending.node_id}", not "{update.node_id}"')
        errors = validate_fields(pending.form, update.values)
        if errors:
            raise ValueError("; ".join(errors))

    @workflow.run
    async def run(self, input: AgentWorkflowInput) -> AgentWorkflowResult:
        tools = build_tool_defs()
        messages: list[dict[str, Any]] = [{"role": "user", "content": first_message(input.definition, input.inputs)}]
        max_turns = input.max_turns or DEFAULT_MAX_TURNS
        nudges = 0

        while self.state.status != "completed":
            if self.state.turns >= max_turns:
                self._fail(f"Gave up after {max_turns} model turns.")
            self.state.turns += 1

            try:
                turn: LlmTurn = await workflow.execute_activity(
                    call_llm,
                    LlmRequest(system=SYSTEM_PROMPT, tools=tools, messages=messages, llm=input.llm),
                    start_to_close_timeout=timedelta(minutes=5),
                    retry_policy=LLM_RETRY,
                )
            except ActivityError as err:
                self._fail(f"Model call failed: {err.cause or err}")

            messages.append({"role": "assistant", "content": turn.content})
            for block in turn.content:
                if block["type"] == "text" and block["text"].strip():
                    self._emit("thought", text=block["text"].strip())
            if turn.stop_reason == "refusal":
                self._fail("The model declined to continue (refusal).")

            tool_uses = [b for b in turn.content if b["type"] == "tool_use"]
            if not tool_uses:
                nudges += 1
                if nudges > MAX_NUDGES:
                    self._fail("The agent stopped without calling finish.")
                text = "The workflow isn't finished. Continue with your next tool call, and call finish at the End step."
                self._emit("nudge", text=text)
                messages.append({"role": "user", "content": text})
                continue

            # In order: the model may report a step and act on it in the same turn.
            results = [await self._run_tool(tu["id"], tu["name"], tu.get("input") or {}) for tu in tool_uses]
            messages.append({"role": "user", "content": results})

        return AgentWorkflowResult(output=self.state.output, steps=[p.node_id for p in self.state.path])

    async def _run_tool(self, tool_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
        domain = name in TOOLS_BY_NAME
        if domain:
            self._emit("tool_call", id=tool_id, tool=name, input=args, nodeId=self.state.current_node)
        try:
            if name == REPORT_STEP:
                output = self._report_step(str(args.get("step_id", "")), str(args.get("note", "")))
            elif name == ASK_HUMAN:
                output = await self._ask_human(args)
            elif name == WAIT:
                output = await self._wait(str(args.get("step_id", "")), str(args.get("duration", "")))
            elif name == FINISH:
                output = self._finish(args.get("output"))
            elif domain:
                output = await self._domain_tool(name, args)
            else:
                raise ToolInputError(f'There is no tool "{name}".')
        except ToolInputError as e:
            if domain:
                self._emit("tool_result", id=tool_id, tool=name, output=str(e), isError=True)
            else:
                self._emit("rejected", tool=name, message=str(e))
            return {"type": "tool_result", "tool_use_id": tool_id, "content": str(e), "is_error": True}
        if domain:
            self._emit("tool_result", id=tool_id, tool=name, output=output, isError=False)
        return {"type": "tool_result", "tool_use_id": tool_id, "content": _json(output)}

    # ---- tools ---------------------------------------------------------------

    def _report_step(self, step_id: str, note: str) -> dict[str, Any]:
        self.state.current_node = step_id
        self.state.path.append(PathStep(node_id=step_id, entered_at=_now_ms()))
        self._emit("enter", nodeId=step_id, reason=note)
        return {"ok": True}

    async def _ask_human(self, args: dict[str, Any]) -> dict[str, Any]:
        try:
            fields = {k: FormField.model_validate(v) for k, v in (args.get("fields") or {}).items()}
        except ValidationError as e:
            raise ToolInputError(f"Invalid fields: {e.errors()[0]['msg']}") from e
        timeout = args.get("timeout") or None
        if timeout and not DURATION_RE.match(timeout):
            raise ToolInputError(f'Invalid timeout "{timeout}". Use a duration like 30m, 24h or 2d.')

        step_id = str(args.get("step_id", ""))
        now = _now_ms()
        self.state.pending_human = HumanRequest(
            node_id=step_id,
            prompt=str(args.get("prompt", "")),
            form=fields,
            assignee=args.get("assignee"),
            requested_at=now,
            timeout_at=now + duration_ms(timeout) if timeout else None,
        )
        self.state.status = "waiting_human"
        self.human_answer = None
        self._emit("human_request", nodeId=step_id, message="")

        answered = True
        try:
            limit = timedelta(milliseconds=duration_ms(timeout)) if timeout else None
            await workflow.wait_condition(lambda: self.human_answer is not None, timeout=limit)
        except asyncio.TimeoutError:
            answered = False

        self.state.pending_human = None
        self.state.status = "running"
        self._emit("human_response", nodeId=step_id, values=self.human_answer, timedOut=not answered)
        return {"response": self.human_answer} if answered else {"timedOut": True}

    async def _wait(self, step_id: str, duration: str) -> dict[str, Any]:
        if not DURATION_RE.match(duration):
            raise ToolInputError(f'Invalid duration "{duration}". Use a duration like 30s, 10m, 2h or 1d.')
        self.state.status = "waiting_timer"
        self.state.timer = Timer(node_id=step_id, duration=duration, ends_at=_now_ms() + duration_ms(duration))
        self._emit("wait", nodeId=step_id, duration=duration)
        await workflow.sleep(timedelta(milliseconds=duration_ms(duration)))
        self.state.status = "running"
        self.state.timer = None
        return {"waited": duration}

    def _finish(self, output: Any) -> dict[str, Any]:
        self.state.output = output
        self.state.status = "completed"
        self.state.finished_at = _now_ms()
        self._emit("finish", output=output)
        return {"finished": True}

    async def _domain_tool(self, name: str, args: dict[str, Any]) -> Any:
        try:
            return await workflow.execute_activity(
                execute_tool,
                ToolCall(name=name, args=args),
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=TOOL_RETRY,
            )
        except ActivityError as err:
            raise ToolInputError(f"Tool error: {err.cause or err}") from err

    # ---- helpers ---------------------------------------------------------------

    def _emit(self, kind: str, **fields: Any) -> None:
        self.state.events.append({"kind": kind, "ts": _now_ms(), **fields})

    def _fail(self, message: str) -> NoReturn:
        self.state.status = "failed"
        self.state.error = message
        self.state.finished_at = _now_ms()
        self._emit("error", message=message)
        raise ApplicationError(message, type="AgentWorkflowError", non_retryable=True)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
