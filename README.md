# Agent Workflow Builder

A demo of a visual (WYSIWYG) workflow builder whose output is a JSON DSL, executed by **one generic Temporal workflow** (in Python) that runs a basic agent. The workflow never parses the JSON: it hands the JSON and the run inputs to the model as context, and in an agentic loop the model decides what to do next. A fixed system prompt explains how to read this kind of JSON; Temporal makes every model call, tool call, human wait and timer durable.

```
Builder (React Flow) ──► workflow JSON + run inputs ──► API ──► agentWorkflow (Temporal)
                                                                 ├─ call_llm activity (one model turn)
                                                                 ├─ execute_tool activity (mock tools)
                                                                 └─ in workflow code:
                                                                    ask_human (Update) · wait (timer) · report_step · finish
```

## Quick start

Prerequisites: Node 22+, pnpm 10, [uv](https://docs.astral.sh/uv/) (it installs Python 3.13 for the worker), and the [Temporal CLI](https://docs.temporal.io/cli).

```bash
pnpm install
```

```bash
pnpm temporal
```

In a second terminal:

```bash
pnpm dev
```

Then open http://localhost:5173. `pnpm dev` starts the Python worker (`pnpm worker` on its own), the API (on :3001) and the web app. The Temporal UI is at http://localhost:8233.

`pnpm temporal` runs the dev server in memory, so runs are lost when it stops. To keep them, add `--db-filename .temporal.db`.

Runs need an Anthropic API key: copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY`, and restart `pnpm dev`. The default model is `claude-opus-5-5` at effort `medium`; set `ANTHROPIC_MODEL` and `ANTHROPIC_EFFORT` to change them. Without a key you can still build and save flows, but runs are disabled. A run costs a few cents.

## Demo script

1. **Build:** the *Refund request triage* template loads on first open. Drag steps from the palette, connect handles, and edit steps in the inspector. The **JSON** tab shows the DSL live, and the **Agent context** tab shows exactly what the model receives: the fixed system prompt, then a first message with this JSON and the run inputs.
2. **Save:** press **Save** to store the flow on the server under its ID. Each save that changes something bumps the version, and the toolbar shows whether the canvas has unsaved changes. Saved flows appear under **Open…**. A flow with errors can be saved as a draft but can't be run.
3. **Run:** press **Test run** to try what's on the canvas, saved or not. To run saved flows the way an operator would, use the **Execute** page (below).
4. **Watch:** the run view highlights the active step and the path taken so far. The agent reports each step it starts, and the timeline shows its notes, tool calls and results.
5. **Human in the loop:** when the run reaches *Manager approval*, a form appears. Answer Yes or No to send a Temporal Update; the workflow validates it before accepting. The run can wait days here without holding any resources.
6. **Durability:** kill the worker (`Ctrl+C`) mid-run and restart it. The run picks up where it left off.

The other templates are *Inbound lead qualification* (agent step with tools, three-way decision) and *Incident response* (a timeout path that loops back to re-page on-call, plus a durable timer).

Each branch can be reached with the mock data. The run inputs' descriptions say which value leads where:

| Template | Input | Branch |
|---|---|---|
| Refund triage | `order_id` `ORD-1042` (default) | needs approval, then approved or rejected depending on your answer |
| Refund triage | `order_id` `ORD-2001` | auto-approve |
| Refund triage | `customer_email` `riley@example.com` | needs approval (account at risk) |
| Lead qualification | `company_domain` `northwind.example` / `brightleaf.example` / `tinyshop.example` | hot / nurture / disqualify |
| Incident response | `service` `payments-api` / `search-api` | SEV1 / SEV2 |

## Execute page

**Execute** (`#/execute`) is for running saved flows without the builder:

- **Flows** (left): every saved flow, with its version. Flows with errors are greyed out.
- **Launcher** (middle): the selected flow's inputs form and **Run**. Below it are the flow's recent runs with their live status, such as "Waiting for input" or the current step. Click a run to open its full run view.
- **Approvals** (right): every run of any flow that's waiting for a person, oldest first, with its form inline. Answering sends the same validated Update as the run view.

The **Execute** tab in the top bar shows a count when approvals are waiting, so they're visible from any page.

The API saves flows to `apps/server/data/flows.json`; set `FLOWS_FILE` to use another path. On first start it's seeded with the three templates. Runs started from Execute use the saved copy, so later edits in the builder only take effect once saved.

## The DSL

```jsonc
{
  "id": "refund-triage", "version": 1, "name": "…", "description": "…",
  "inputs": { "order_id": { "type": "string", "required": true } },  // run parameters
  "tools": ["lookup_order", "issue_refund"],                          // derived by the builder
  "start": "start",
  "nodes": [ { "id": "start", "type": "start" }, … ],
  "edges": [ { "id": "e1", "from": "start", "to": "lookup", "label": "…", "on": "timeout" } ]
}
```

The system prompt tells the agent what each step type means:

| Step | Fields | What the agent does |
|---|---|---|
| `start` | none | Begins here |
| `agent` | `instructions`, `tools[]`, `saveAs?` | Follows the instructions with only the listed tools |
| `tool` | `tool`, `args` (templated map or `"agent"`), `instructions?`, `saveAs?` | Calls that tool once, with the given or chosen arguments |
| `decision` | `instructions`; edges carry `label` and an optional `when` rule | Takes one edge: the first edge whose rule is true, else the one without a rule; with no rules, judges from the instructions |
| `human` | `prompt`, `form`, `assignee?`, `timeout?`, `saveAs?` | Calls `ask_human` and waits; follows the edge matching the answer, or the `on: "timeout"` edge |
| `wait` | `duration`: fixed (`30s`, `10m`, `24h`, `2d`) or a reference like `{{ack.settle_for}}` | Calls `wait` with that duration |
| `end` | `output` (field map), `instructions?` | Calls `finish` with the output fields |

**Decision rules.** A rule is a small expression over the inputs and saved results, for example `order.amount > 100 || customer.account_status == "at_risk"`. It supports `== != > >= < <=`, `&& || !` (or `and or not`), strings, numbers and `true`/`false`. The builder checks that rules parse; the agent evaluates them.

**Durations from people or inputs.** Fields in human forms and run inputs can have type `duration`. The form shows a number with a unit, and the value must look like `15m` or the submission is rejected. To let a person set a timer, give their step a "Save answer as" name (for example `ack`), add a duration field (`settle_for`), and set the wait's duration to `{{ack.settle_for}}`. The wait editor lists the fields you can pick from. The agent passes the person's answer to `wait`; the workflow only accepts a valid duration. The *Incident response* template shows this: the on-call engineer chooses how long to let the fix settle.

Every step also accepts `label`, `maxVisits` (a loop cap for the agent) and `ui` (canvas position). Templates such as `{{inputs.order_id}}` or `{{order.amount}}` refer to run inputs and to results saved under a `saveAs` name; the agent fills them in.

## How execution works

The worker is the heart of the demo: a small, self-contained Python project laid out the way Temporal's [AI guidance](https://docs.temporal.io/ai) and cookbook recommend. Everything the agent is given lives here as plain files, and the UI imports them, not the other way round.

```
apps/worker
├── workflows/agent_workflow.py   the agent loop (never parses the workflow JSON)
├── activities/llm.py             call_llm: one generic activity for Claude (client retries off)
├── activities/tools.py           execute_tool: one activity for all domain tools (mocked)
├── agent/system-prompt.md        the system prompt, the same for every workflow
├── agent/agent-tools.json        report_step, ask_human, wait, finish (Claude tool format)
├── agent/tool-catalog.json       the domain tools; the builder lists these
├── agent/context.py              loads those files and builds the first message
├── agent/models.py               workflow input, run state and Update models
├── agent/forms.py                form and duration checks for ask_human and wait
├── worker.py                     connects with the Pydantic data converter and runs the worker
├── start_workflow.py             runs a workflow JSON from the command line; answer human steps in the terminal
└── tests/                        workflow tests with a scripted model, plus an opt-in live Claude test
```

To run a workflow without the UI, start the worker, then from `apps/worker`:

```bash
uv run python start_workflow.py ../web/src/examples/refund-triage.json
```

Any workflow JSON works: the templates in `apps/web/src/examples/`, or a file saved with **Export** in the builder. It uses the workflow's default inputs; override them with `-i`, for example `-i order_id=ORD-2001`. It prints each step as the agent reports it, and when the agent asks a person, it asks you in the terminal. The run also appears in the web UI, so you can answer there instead.

`AgentWorkflow` (registered as `agentWorkflow`) takes `{definition, inputs, llm}`. `definition` is untyped JSON. The loop:

1. The first message is the definition JSON and the run inputs, verbatim. The system prompt is the same for every workflow (`system-prompt.md`), so it's cached across runs and workflows.
2. Each model turn is one `call_llm` activity. The full assistant content, including thinking blocks, goes back unchanged on the next turn.
3. The workflow runs whatever tools the model asks for, in order:
   - **Domain tools** (from `tool-catalog.json`) run as the `execute_tool` activity. A failure comes back to the model as an error result.
   - **`ask_human`** shows a form the model supplies and waits on a validated `submitHumanInput` Update, with the model's timeout.
   - **`wait`** is a durable timer for the duration the model gives.
   - **`report_step`** records the step the model says it's starting. The UI uses this to highlight progress; nothing checks it against the graph.
   - **`finish`** ends the run with the model's output.
4. If the model stops without calling `finish`, it's nudged to continue (up to 3 times). Runs are capped at 60 model turns.
5. A `getState` query exposes the run state, which the UI polls.

What follows the Temporal conventions:
- **Model calls are an activity** (`call_llm`), with the Anthropic client's own retries turned off (`max_retries=0`) so Temporal owns retries. Errors are classified: auth, permission, not-found and bad-request errors are non-retryable; rate limits retry after the `retry-after` delay; 5xx and connection errors retry with backoff.
- **Tools that reach the outside world are an activity** (`execute_tool`). **Tools that only affect the run itself** (`ask_human`, `wait`, `report_step`, `finish`) are workflow code.
- **Human input is a validated Update**, waited on with `workflow.wait_condition` and a timeout. Waits are durable timers.
- **Pydantic models** with the `pydantic_data_converter`. They use camelCase aliases, so the TypeScript API and UI read and send the same JSON.
- **Workflow and activity code in separate modules.** The workflow imports activities and models through `workflow.unsafe.imports_passed_through()`.
- **Timeouts:** 5 minutes per model call (reasoning models need time) and 60 seconds per tool call.

## Project layout

```
apps/worker       Python: the Temporal worker and the agent's prompt and tools (see How execution works)
packages/dsl      TypeScript for the UI and API: schema (zod), validator, shared run types. Imports the worker's
                  tool catalog and agent tools; no build step (the API and builder run it from source)
apps/server       Fastify API: saved flows, start runs (saved or draft), list runs, approvals inbox, get state, submit human input
apps/web          Vite + React + @xyflow/react builder and run viewer; the template workflows (src/examples/*.json)
```

## Tests

```bash
pnpm test
```

This runs:
- **TypeScript DSL tests:** validation, templates, rules, and the agent-context preview.
- **Python tests** (`cd apps/worker && uv run pytest`), which need no running server or API key. They run on Temporal's time-skipping test server, with a scripted model that checks what the workflow sends and replies with tool calls:
  - JSON that isn't our DSL at all reaches the model verbatim, and tool errors go back to the model.
  - An `ask_human` times out, then gets an answer that fails validation, then one whose value sets the length of a `wait`.
  - A model that stops without calling `finish` is nudged to continue.
  - The shared prompt and tools load, and the system prompt has nothing workflow-specific in it.

One more test runs refund triage end to end against real Claude, including the approval. It's opt-in because it calls the API:

```bash
cd apps/worker && RUN_LIVE_CLAUDE=1 uv run pytest tests/test_live_claude.py
```

## Limits and next steps

- **Mock tools only.** They live in `apps/worker/activities/tools.py`. Real integrations would go behind the same `execute_tool` activity.
- **No parallel branches or sub-workflows.** Natural extensions would be fan-out steps (child workflows) and a sub-workflow step that starts another definition.
- **No continue-as-new yet.** Each model turn sends the whole conversation to the activity, so very long runs would eventually hit Temporal's history size limits.
- **The agent is trusted to follow the graph.** Nothing in the workflow stops the model from skipping a step or picking the wrong edge; the system prompt and the step reports are the only guide. A stricter version could add checks back as an optional layer.
- **All catalog tools are available to every run.** The JSON says which tools each step may use, and the prompt tells the model to stick to them; the workflow doesn't restrict them.
- **No auth or multi-user editing.** Saved flows live in one JSON file, and the last save wins. Runs are stored only in Temporal. The builder also keeps your current canvas in `localStorage`.
