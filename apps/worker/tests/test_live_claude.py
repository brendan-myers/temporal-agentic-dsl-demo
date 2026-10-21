"""End to end with real Claude. Opt-in, since it calls the API (a few cents):

    RUN_LIVE_CLAUDE=1 uv run pytest tests/test_live_claude.py
"""

import json
import os
import uuid
from pathlib import Path

import pytest
from dotenv import load_dotenv
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from activities.llm import call_llm
from activities.tools import execute_tool
from agent.models import AgentWorkflowInput, HumanInputUpdate, LlmConfig
from workflows.agent_workflow import AgentWorkflow

from .test_workflow import waiting_for_human

load_dotenv(Path(__file__).resolve().parents[3] / ".env")
pytestmark = pytest.mark.skipif(
    not (os.environ.get("RUN_LIVE_CLAUDE") and os.environ.get("ANTHROPIC_API_KEY")),
    reason="set RUN_LIVE_CLAUDE=1 and ANTHROPIC_API_KEY to call the real API",
)


async def test_refund_triage_with_claude():
    # A copy of the builder's refund triage template.
    refund = json.loads((Path(__file__).parent / "fixtures" / "refund-triage.json").read_text())
    inputs = {k: f["default"] for k, f in refund["inputs"].items() if "default" in f}
    async with await WorkflowEnvironment.start_time_skipping(data_converter=pydantic_data_converter) as env:
        task_queue = str(uuid.uuid4())
        async with Worker(env.client, task_queue=task_queue, workflows=[AgentWorkflow], activities=[call_llm, execute_tool]):
            handle = await env.client.start_workflow(
                AgentWorkflow.run,
                AgentWorkflowInput(definition=refund, inputs=inputs, llm=LlmConfig(model=os.environ.get("ANTHROPIC_MODEL") or "claude-opus-5-5")),
                id=str(uuid.uuid4()),
                task_queue=task_queue,
            )
            state = await waiting_for_human(handle)
            assert state.pending_human.node_id == "approve"
            assert "136.99" in state.pending_human.prompt
            await handle.execute_update(AgentWorkflow.submit_human_input, HumanInputUpdate(node_id="approve", values={"approved": True}))
            result = await handle.result()
    assert result.steps == ["start", "lookup", "customer", "check", "approve", "refund", "reply", "end"]
    assert result.output["refunded"] is True
