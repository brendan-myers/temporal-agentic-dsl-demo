"""Runs the Temporal worker for the generic agent workflow."""

import asyncio
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from activities.llm import call_llm
from activities.tools import execute_tool
from workflows.agent_workflow import AgentWorkflow

# One .env for the whole repo (API key, Temporal address, task queue).
load_dotenv(Path(__file__).resolve().parents[2] / ".env")


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    address = os.environ.get("TEMPORAL_ADDRESS") or "localhost:7233"
    task_queue = os.environ.get("TASK_QUEUE") or "agent-workflows"

    client = await Client.connect(
        address,
        namespace=os.environ.get("TEMPORAL_NAMESPACE") or "default",
        data_converter=pydantic_data_converter,
    )
    worker = Worker(
        client,
        task_queue=task_queue,
        workflows=[AgentWorkflow],
        activities=[call_llm, execute_tool],
    )
    logging.info("Worker polling %r on %s", task_queue, address)
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
