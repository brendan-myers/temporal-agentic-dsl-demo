import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Client, Connection, WorkflowNotFoundError, WorkflowUpdateFailedError } from '@temporalio/client';
import {
  QUERY_STATE,
  UPDATE_HUMAN_INPUT,
  WORKFLOW_TYPE,
  validateDefinition,
  validateFields,
  type AgentWorkflowInput,
  type HumanInputUpdate,
  type InboxItem,
  type LlmConfig,
  type RunState,
  type RunSummary,
  type WorkflowDefinition,
} from '@demo/dsl';
import { FlowStore, InvalidFlow } from './flow-store';

config({ path: path.resolve(__dirname, '../../../.env') });

const TASK_QUEUE = process.env.TASK_QUEUE || 'agent-workflows';
const NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';
const hasCredentials = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const effort = (process.env.ANTHROPIC_EFFORT as LlmConfig['effort']) || 'medium';

async function main() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS || 'localhost:7233' });
  const client = new Client({ connection, namespace: NAMESPACE });
  const app = Fastify({ logger: { level: 'warn' } });
  await app.register(cors, { origin: true });

  const flows = new FlowStore(process.env.FLOWS_FILE || path.resolve(__dirname, '../data/flows.json'));
  await flows.load();

  // ---- saved flows ---------------------------------------------------------

  app.get('/api/flows', async () => ({ flows: flows.list() }));

  app.get<{ Params: { id: string } }>('/api/flows/:id', async (req, reply) => {
    const flow = flows.get(req.params.id);
    return flow ?? reply.code(404).send({ error: 'Flow not found' });
  });

  app.put<{ Params: { id: string }; Body: { definition: WorkflowDefinition } }>('/api/flows/:id', async (req, reply) => {
    if (req.body?.definition?.id !== req.params.id) return reply.code(400).send({ error: 'The definition id must match the URL' });
    try {
      return await flows.save(req.body.definition);
    } catch (err) {
      if (err instanceof InvalidFlow) return reply.code(400).send({ error: err.message, issues: err.issues.map((message) => ({ level: 'error', message })) });
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/flows/:id', async (req, reply) => {
    return (await flows.remove(req.params.id)) ? { deleted: true } : reply.code(404).send({ error: 'Flow not found' });
  });

  app.get('/api/config', async () => ({
    claudeAvailable: hasCredentials,
    model,
    temporalUi: process.env.TEMPORAL_UI_URL || 'http://localhost:8233',
    namespace: NAMESPACE,
  }));

  // ---- runs ----------------------------------------------------------------

  // Start from a saved flow ({ flowId }) or from an unsaved draft ({ definition }, the builder's Run button).
  app.post<{ Body: { flowId?: string; definition?: unknown; inputs?: Record<string, unknown> } }>('/api/runs', async (req, reply) => {
    let raw = req.body?.definition;
    if (req.body?.flowId) {
      const saved = flows.get(req.body.flowId);
      if (!saved) return reply.code(404).send({ error: `No saved flow "${req.body.flowId}"` });
      raw = saved.definition;
    }
    const { ok, issues, definition } = validateDefinition(raw);
    if (!ok || !definition) return reply.code(400).send({ error: 'This flow has errors. Fix them in the builder first.', issues });

    const inputs = req.body.inputs ?? {};
    const inputErrors = validateFields(definition.inputs, inputs);
    if (inputErrors.length) return reply.code(400).send({ error: 'Invalid inputs', issues: inputErrors.map((message) => ({ level: 'error', message })) });

    if (!hasCredentials) {
      return reply.code(400).send({ error: 'Runs need ANTHROPIC_API_KEY in .env (restart the worker and API after adding it).' });
    }

    const workflowId = `${definition.id}-${randomUUID().slice(0, 8)}`;
    const args: AgentWorkflowInput = { definition, inputs, llm: { model, effort } };
    await client.workflow.start(WORKFLOW_TYPE, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [args],
      memo: { workflowName: definition.name, model, flowId: definition.id, flowVersion: definition.version, saved: !!req.body.flowId },
    });
    return { runId: workflowId };
  });

  /** Recent runs, newest first. Open runs are queried for their live state (waiting for input, current step). */
  async function listRuns({ flowId, openOnly = false, limit = 25 }: { flowId?: string; openOnly?: boolean; limit?: number }) {
    let query = `WorkflowType = '${WORKFLOW_TYPE}' AND TaskQueue = '${TASK_QUEUE}'`;
    if (openOnly) query += ` AND ExecutionStatus = 'Running'`;
    const runs: (RunSummary & { state?: RunState })[] = [];
    for await (const wf of client.workflow.list({ query })) {
      const id = (wf.memo?.flowId as string) ?? undefined;
      if (flowId && id !== flowId) continue;
      runs.push({
        runId: wf.workflowId,
        flowId: id,
        name: (wf.memo?.workflowName as string) ?? wf.workflowId,
        model: wf.memo?.model as string | undefined,
        status: wf.status.name,
        startTime: wf.startTime.toISOString(),
        closeTime: wf.closeTime?.toISOString(),
      });
      if (runs.length >= limit) break;
    }
    await Promise.all(
      runs
        .filter((r) => r.status === 'RUNNING')
        .map(async (r) => {
          try {
            r.state = await client.workflow.getHandle(r.runId).query<RunState>(QUERY_STATE);
            r.runStatus = r.state.status;
            r.currentNode = r.state.currentNode;
          } catch {
            /* no worker yet; the listing still shows the run */
          }
        }),
    );
    return runs;
  }

  app.get<{ Querystring: { flowId?: string; limit?: string } }>('/api/runs', async (req) => {
    const runs = await listRuns({ flowId: req.query.flowId, limit: Math.min(Number(req.query.limit ?? 25), 100) });
    return { runs: runs.map(({ state: _state, ...r }) => r) };
  });

  /** Every run waiting for a person, across all flows. */
  app.get('/api/inbox', async () => {
    const open = await listRuns({ openOnly: true, limit: 100 });
    const items: InboxItem[] = [];
    for (const r of open) {
      const req = r.state?.pendingHuman;
      if (!req) continue;
      const def = (await runInput(r.runId))?.definition;
      items.push({
        runId: r.runId,
        flowId: r.flowId ?? def?.id ?? '',
        flowName: r.name,
        nodeLabel: def?.nodes.find((n) => n.id === req.nodeId)?.label ?? req.nodeId,
        request: req,
      });
    }
    items.sort((a, b) => a.request.requestedAt - b.request.requestedAt);
    return { items };
  });

  // The definition is the workflow's own input, so the UI can draw the graph for any run.
  const inputCache = new Map<string, AgentWorkflowInput | null>();
  async function runInput(id: string) {
    if (!inputCache.has(id)) {
      const history = await client.workflow.getHandle(id).fetchHistory();
      const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
      inputCache.set(id, payload?.data ? (JSON.parse(Buffer.from(payload.data).toString()) as AgentWorkflowInput) : null);
    }
    return inputCache.get(id)!;
  }

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const handle = client.workflow.getHandle(req.params.id);
    try {
      const [desc, state] = await Promise.all([handle.describe(), handle.query<RunState>(QUERY_STATE)]);
      const input = await runInput(req.params.id);
      return { runId: req.params.id, temporalStatus: desc.status.name, state, definition: input?.definition, inputs: input?.inputs };
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return reply.code(404).send({ error: 'Run not found' });
      // Queries need a worker on the run's task queue.
      return reply.code(503).send({ error: `Couldn't read this run's state. Is the worker running? (${(err as Error).message})` });
    }
  });

  app.post<{ Params: { id: string }; Body: HumanInputUpdate }>('/api/runs/:id/human-input', async (req, reply) => {
    const handle = client.workflow.getHandle(req.params.id);
    try {
      return await handle.executeUpdate(UPDATE_HUMAN_INPUT, { args: [req.body] });
    } catch (err) {
      if (err instanceof WorkflowUpdateFailedError) return reply.code(400).send({ error: err.cause?.message ?? err.message });
      throw err;
    }
  });

  const port = Number(process.env.API_PORT || 3001);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`API on http://localhost:${port} (${hasCredentials ? `agent: ${model}` : 'no ANTHROPIC_API_KEY: runs are disabled'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
