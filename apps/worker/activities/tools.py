"""Domain tools, run as one Temporal activity.

Tools reach the outside world (here: mocked), so they belong in an activity:
each call is retried on failure and recorded in the workflow's history.
"""

from __future__ import annotations

import asyncio
import hashlib
import random
import time
from typing import Any, Callable

from temporalio import activity
from temporalio.exceptions import ApplicationError

from agent.models import Model
from agent.context import TOOLS_BY_NAME


class ToolCall(Model):
    name: str
    args: dict[str, Any] = {}


@activity.defn
async def execute_tool(call: ToolCall) -> Any:
    spec = TOOLS_BY_NAME.get(call.name)
    impl = _TOOLS.get(call.name)
    if not spec or not impl:
        raise ApplicationError(f'Unknown tool "{call.name}"', type="UnknownTool", non_retryable=True)
    for param in spec["required"]:
        if call.args.get(param) in (None, ""):
            raise ApplicationError(f'Missing required argument "{param}"', type="BadToolInput", non_retryable=True)
    await asyncio.sleep(0.3 + random.random() * 0.5)  # a little latency so the run view feels real
    return impl(call.args)


# ---- mock implementations ---------------------------------------------------
# Fixed records make each demo branch reachable on purpose (see the input
# descriptions in the templates). Anything else gets stable hashed data.

ORDERS = {
    "ORD-1042": {"amount": 136.99, "ordered_days_ago": 12, "item": "Espresso machine"},
    "ORD-2001": {"amount": 42.5, "ordered_days_ago": 5, "item": "Hiking backpack"},
    "ORD-3007": {"amount": 64.0, "ordered_days_ago": 48, "item": "Standing desk mat"},
}
CUSTOMERS = {
    "sam@example.com": {"name": "Sam Rivera", "tier": "gold", "account_status": "active"},
    "riley@example.com": {"name": "Riley Chen", "tier": "bronze", "account_status": "at_risk"},
}
COMPANIES = {
    "northwind.example": {"employees": 1300, "industry": "Logistics"},
    "brightleaf.example": {"employees": 180, "industry": "Retail"},
    "tinyshop.example": {"employees": 6, "industry": "Retail"},
}
SERVICES = {
    "payments-api": {"status": "degraded", "error_rate_pct": 7.8, "p99_latency_ms": 2400},
    "search-api": {"status": "degraded", "error_rate_pct": 1.2, "p99_latency_ms": 900},
}
KNOWLEDGE_BASE = [
    {
        "keys": ["icp", "ideal", "customer profile", "fit", "lead", "score"],
        "title": "Ideal customer profile",
        "snippet": "Best fit: 200+ employees, runs business-critical background jobs or long-running processes, platform/infra team in place. Strong intent signals: reliability pain, lost work, retries, orchestration.",
    },
    {
        "keys": ["refund", "return", "approval"],
        "title": "Refund policy",
        "snippet": "Refunds up to $100 within 30 days are auto-approved. Larger or older refunds need a support manager. Always refund to the original payment method.",
    },
    {
        "keys": ["incident", "sev", "oncall", "on-call", "page"],
        "title": "Incident policy",
        "snippet": "SEV1: customer-facing outage or error rate > 5%. Page on-call; re-page every 2 minutes until acknowledged. SEV2: degraded, open a P2 ticket.",
    },
]

# Per-service call count so a re-check shows recovery. Demo-only worker memory.
_health_checks: dict[str, int] = {}


def _hash(s: str) -> int:
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


def _pick(options: list[Any], seed: str) -> Any:
    return options[_hash(seed) % len(options)]


def _new_id(prefix: str) -> str:
    return f"{prefix}-{random.randint(1000, 9999)}"


def _lookup_customer(a: dict[str, Any]) -> dict[str, Any]:
    email = str(a["email"])
    h = _hash(email)
    return {
        "email": email,
        "name": email.split("@")[0].replace(".", " ").title(),
        "tier": _pick(["gold", "silver", "bronze"], email),
        "lifetime_value_usd": 200 + h % 9000,
        "account_status": "at_risk" if h % 5 == 0 else "active",
        **CUSTOMERS.get(email.lower(), {}),
    }


def _lookup_company(a: dict[str, Any]) -> dict[str, Any]:
    domain = str(a["domain"])
    return {
        "domain": domain,
        "name": domain.split(".")[0].title(),
        "industry": _pick(["Fintech", "Logistics", "Healthcare", "Retail", "SaaS", "Media"], domain),
        "employees": _pick([45, 180, 420, 1300, 5200], domain + "e"),
        "region": _pick(["North America", "EMEA", "APAC"], domain + "r"),
        "tech_stack": ["Kubernetes", _pick(["Go", "Java", "TypeScript", "Python"], domain)],
        **COMPANIES.get(domain.lower(), {}),
    }


def _lookup_order(a: dict[str, Any]) -> dict[str, Any]:
    order_id = str(a["order_id"])
    fixed = ORDERS.get(order_id.upper(), {})
    return {
        "order_id": order_id,
        "amount": fixed.get("amount", round(20 + _hash(order_id) % 300 + 0.99, 2)),
        "currency": "USD",
        "items": [fixed.get("item", _pick(["Espresso machine", "Standing desk", "Hiking backpack"], order_id))],
        "ordered_days_ago": fixed.get("ordered_days_ago", 3 + _hash(order_id + "d") % 45),
        "status": "delivered",
    }


def _issue_refund(a: dict[str, Any]) -> dict[str, Any]:
    amount = a["amount"]
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount <= 0:
        raise ApplicationError("amount must be a positive number", type="BadToolInput", non_retryable=True)
    if amount > 5000:
        raise ApplicationError("Refunds over $5,000 must go through finance", type="PolicyViolation", non_retryable=True)
    return {"refund_id": _new_id("RF"), "order_id": a["order_id"], "amount": amount, "status": "succeeded"}


def _check_service_health(a: dict[str, Any]) -> dict[str, Any]:
    service = str(a["service"])
    _health_checks[service] = _health_checks.get(service, 0) + 1
    if _health_checks[service] % 2 == 0:
        return {"service": service, "status": "healthy", "error_rate_pct": 0.4, "p99_latency_ms": 210}
    default = {"status": "degraded", "error_rate_pct": 7.8, "p99_latency_ms": 2400}
    return {"service": service, **SERVICES.get(service.lower(), default)}


def _search_knowledge_base(a: dict[str, Any]) -> dict[str, Any]:
    q = str(a["query"]).lower()
    hits = [d for d in KNOWLEDGE_BASE if any(k in q for k in d["keys"])] or KNOWLEDGE_BASE[:1]
    return {"query": a["query"], "results": [{"title": d["title"], "snippet": d["snippet"]} for d in hits]}


_TOOLS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "lookup_customer": _lookup_customer,
    "lookup_company": _lookup_company,
    "create_crm_task": lambda a: {"task_id": _new_id("TASK"), "owner": a["owner"], "title": a["title"], "status": "open"},
    "lookup_order": _lookup_order,
    "issue_refund": _issue_refund,
    "send_email": lambda a: {"message_id": _new_id("MSG"), "to": a["to"], "subject": a["subject"], "delivered": True},
    "post_slack_message": lambda a: {"channel": a["channel"], "ts": f"{time.time():.6f}", "posted": True},
    "page_oncall": lambda a: {"incident_id": _new_id("INC"), "service": a["service"], "paged": _pick(["alex (primary)", "priya (primary)"], str(a["service"]))},
    "check_service_health": _check_service_health,
    "create_ticket": lambda a: {"ticket_id": _new_id("OPS"), "title": a["title"], "priority": a.get("priority", "P3"), "status": "open"},
    "search_knowledge_base": _search_knowledge_base,
}
