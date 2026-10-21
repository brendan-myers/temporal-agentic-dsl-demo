"""Inputs, outputs and run state for the generic agent workflow.

The workflow definition itself is untyped JSON: the workflow passes it to the
model as-is and never interprets it. JSON keys are camelCase on the wire
(the TypeScript API and UI read them); Python fields are snake_case.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class Model(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
    )


class LlmConfig(Model):
    model: str
    effort: Literal["low", "medium", "high"] | None = None


class AgentWorkflowInput(Model):
    # The workflow JSON from the builder, passed to the model verbatim.
    definition: dict[str, Any]
    # Run parameters.
    inputs: dict[str, Any] = {}
    llm: LlmConfig
    max_turns: int | None = None


class AgentWorkflowResult(Model):
    output: Any
    steps: list[str]


# ---- run state (returned by the getState query) -----------------------------

RunStatus = Literal["running", "waiting_human", "waiting_timer", "completed", "failed"]


class FormField(Model):
    type: Literal["string", "text", "number", "boolean", "duration"]
    required: bool | None = None
    description: str | None = None


class HumanRequest(Model):
    node_id: str
    prompt: str
    message: str = ""
    form: dict[str, FormField]
    assignee: str | None = None
    requested_at: int
    timeout_at: int | None = None


class Timer(Model):
    node_id: str
    duration: str
    ends_at: int


class PathStep(Model):
    node_id: str
    edge_id: str | None = None
    entered_at: int


class RunState(Model):
    status: RunStatus = "running"
    definition_id: str
    definition_name: str
    llm: LlmConfig
    # The step the agent last reported. Informational only: nothing enforces it.
    current_node: str | None = None
    path: list[PathStep] = []
    variables: dict[str, Any] = {}
    pending_human: HumanRequest | None = None
    timer: Timer | None = None
    # Timeline entries, shaped like the UI's RunEvent union ({"kind": ..., "ts": ...}).
    events: list[dict[str, Any]] = []
    output: Any = None
    error: str | None = None
    turns: int = 0
    started_at: int
    finished_at: int | None = None


class HumanInputUpdate(Model):
    node_id: str
    values: dict[str, Any] = {}


class HumanInputAccepted(Model):
    accepted: bool = True
