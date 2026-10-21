import json

from agent.context import AGENT_TOOLS, SYSTEM_PROMPT, TOOL_CATALOG, build_tool_defs, first_message


def test_shared_context_loads():
    assert SYSTEM_PROMPT.startswith("You are a workflow agent.")
    assert [t["name"] for t in AGENT_TOOLS] == ["report_step", "ask_human", "wait", "finish"]
    assert len(build_tool_defs()) == len(AGENT_TOOLS) + len(TOOL_CATALOG)


def test_system_prompt_is_generic_and_json_is_verbatim():
    definition = {"id": "returns-desk", "name": "Returns desk", "nodes": [{"id": "start", "type": "start", "label": "Café"}], "edges": []}
    assert "Returns desk" not in SYSTEM_PROMPT
    message = first_message(definition, {"order_id": "ORD-1"})
    assert json.dumps(definition, indent=2, ensure_ascii=False) in message
    assert '"order_id": "ORD-1"' in message
