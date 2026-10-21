"""The one activity that calls the model.

Temporal conventions (docs.temporal.io/ai): a single generic LLM activity,
client retries off so Temporal owns retries, and errors classified into
retryable vs non-retryable.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import anthropic
from temporalio import activity
from temporalio.exceptions import ApplicationError

from agent.models import LlmConfig, Model


class LlmRequest(Model):
    system: str
    tools: list[dict[str, Any]]
    messages: list[dict[str, Any]]
    llm: LlmConfig


class LlmTurn(Model):
    # Returned unchanged so thinking blocks round-trip intact on the next turn.
    content: list[dict[str, Any]]
    stop_reason: str
    model: str | None = None
    usage: dict[str, int] | None = None


_client: anthropic.AsyncAnthropic | None = None


def _anthropic() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        # Temporal owns retries, so the client doesn't retry. The timeout sits
        # just under the activity's start-to-close timeout.
        _client = anthropic.AsyncAnthropic(max_retries=0, timeout=280)
    return _client


@activity.defn
async def call_llm(request: LlmRequest) -> LlmTurn:
    try:
        response = await _anthropic().beta.messages.create(
            model=request.llm.model,
            max_tokens=16000,
            system=request.system,
            tools=request.tools,
            messages=request.messages,
            output_config={"effort": request.llm.effort or "medium"},
            # Cache the stable prefix: tools, system prompt and history so far.
            cache_control={"type": "ephemeral"},
            # If a safety classifier declines, the API retries on a fallback model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.RateLimitError as e:
        retry_after = e.response.headers.get("retry-after")
        raise ApplicationError(
            f"Rate limited: {e.message}",
            type="RateLimitError",
            next_retry_delay=timedelta(seconds=float(retry_after)) if retry_after else None,
        ) from e
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.NotFoundError, anthropic.BadRequestError) as e:
        # Bad key, no access, unknown model or invalid request: retrying won't help.
        raise ApplicationError(f"{type(e).__name__}: {e.message}", type=type(e).__name__, non_retryable=True) from e
    except anthropic.APIStatusError as e:
        retryable = e.status_code >= 500 or e.status_code in (408, 409)
        raise ApplicationError(f"Claude API error ({e.status_code}): {e.message}", type="APIStatusError", non_retryable=not retryable) from e
    except anthropic.APIConnectionError as e:  # includes timeouts
        raise ApplicationError(f"Connection error: {e}", type="APIConnectionError") from e

    usage = {
        "input": response.usage.input_tokens,
        "output": response.usage.output_tokens,
        "cache_read": response.usage.cache_read_input_tokens or 0,
        "cache_write": response.usage.cache_creation_input_tokens or 0,
    }
    activity.logger.info("Claude turn: model=%s stop=%s usage=%s", response.model, response.stop_reason, usage)
    return LlmTurn(
        content=[block.model_dump(mode="json", exclude_none=True) for block in response.content],
        stop_reason=response.stop_reason or "end_turn",
        model=response.model,
        usage=usage,
    )
