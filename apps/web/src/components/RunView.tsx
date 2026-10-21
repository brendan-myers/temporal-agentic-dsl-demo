import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import type { HumanRequest, RunEvent, RunState, WorkflowDefinition } from '@demo/dsl';
import { api, type RunDetail, type ServerConfig } from '../api';
import { toFlow, type RunMark, type StepEdge, type StepNode } from '../flow';
import { FormFields } from './FormFields';
import { Icon } from './icons';
import { nodeTypes } from './StepNode';

const CLOSED = new Set(['COMPLETED', 'FAILED', 'TERMINATED', 'CANCELLED', 'TIMED_OUT']);

export function RunView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.getRun(runId);
        if (stop) return;
        setRun(r);
        setError(null);
        if (CLOSED.has(r.temporalStatus)) return;
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
      timer = setTimeout(poll, 1000);
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [runId]);

  if (!run) {
    return (
      <div className="center-msg">
        {error ? <div className="error-box">{error}</div> : <div className="muted">Loading run…</div>}
      </div>
    );
  }

  const { state, definition } = run;
  const nodeLabel = (id: string | null) => definition.nodes.find((n) => n.id === id)?.label ?? id ?? '';

  return (
    <div className="run-view">
      <div className="toolbar">
        <button className="btn" onClick={onBack}>
          ← Runs
        </button>
        <div className="toolbar-name">{state.definitionName}</div>
        <span className="mono muted small">{runId}</span>
        <div className="spacer" />
        <StatusPill state={state} temporalStatus={run.temporalStatus} />
        <span className="chip">{state.llm.model}</span>
        <span className="chip ghost">{state.turns} turns</span>
        {config && (
          <a className="btn" href={`${config.temporalUi}/namespaces/${config.namespace}/workflows/${encodeURIComponent(runId)}`} target="_blank" rel="noreferrer">
            Temporal UI <Icon name="external" size={12} />
          </a>
        )}
      </div>
      <div className="run-body">
        <div className="canvas">
          <ReactFlowProvider>
            <RunCanvas definition={definition} state={state} />
          </ReactFlowProvider>
        </div>
        <aside className="side run-side">
          {error && <div className="error-box">{error}</div>}
          {state.pendingHuman && <HumanTask runId={runId} req={state.pendingHuman} nodeLabel={nodeLabel(state.pendingHuman.nodeId)} />}
          {state.status === 'waiting_timer' && <TimerCard state={state} nodeLabel={nodeLabel(state.timer?.nodeId ?? state.currentNode)} />}
          {state.status === 'completed' && (
            <div className="card success">
              <div className="card-title">
                <Icon name="check" /> Output
              </div>
              <pre>{JSON.stringify(state.output, null, 2)}</pre>
            </div>
          )}
          {state.error && (
            <div className="card danger">
              <div className="card-title">
                <Icon name="alert" /> Failed
              </div>
              <div>{state.error}</div>
            </div>
          )}
          {Object.keys(state.variables).length > 0 && (
            <details className="card">
              <summary className="card-title">Variables ({Object.keys(state.variables).length})</summary>
              <pre>{JSON.stringify(state.variables, null, 2)}</pre>
            </details>
          )}
          <details className="card">
            <summary className="card-title">Run inputs</summary>
            <pre>{JSON.stringify(run.inputs, null, 2)}</pre>
          </details>
          <div className="timeline-title">Timeline</div>
          <Timeline events={state.events} nodeLabel={nodeLabel} />
        </aside>
      </div>
    </div>
  );
}

function StatusPill({ state, temporalStatus }: { state: RunState; temporalStatus: string }) {
  const label =
    state.status === 'waiting_human' ? 'Waiting for input' : state.status === 'waiting_timer' ? 'Timer' : temporalStatus === 'RUNNING' ? 'Running' : temporalStatus.toLowerCase();
  return <span className={`pill s-${state.status}`}>{label}</span>;
}

/**
 * Edges the run followed. The agent reports steps, not edges, so infer each
 * edge from consecutive steps; between two steps joined by both an outcome and
 * a timeout path, pick by whether that request timed out.
 */
function takenEdges(definition: WorkflowDefinition, state: RunState): string[] {
  const ids: string[] = [];
  state.path.forEach((step, i) => {
    if (step.edgeId) return void ids.push(step.edgeId);
    const prev = state.path[i - 1];
    if (!prev) return;
    const candidates = definition.edges.filter((e) => e.from === prev.nodeId && e.to === step.nodeId);
    const response = [...state.events]
      .reverse()
      .find((e) => e.kind === 'human_response' && e.nodeId === prev.nodeId && e.ts <= step.enteredAt);
    const timedOut = response?.kind === 'human_response' && response.timedOut;
    const edge = candidates.find((e) => (e.on === 'timeout') === timedOut) ?? candidates[0];
    if (edge) ids.push(edge.id);
  });
  return ids;
}

function RunCanvas({ definition, state }: { definition: WorkflowDefinition; state: RunState }) {
  const { nodes, edges } = useMemo(() => {
    const f = toFlow(definition);
    const visits = new Map<string, number>();
    for (const p of state.path) visits.set(p.nodeId, (visits.get(p.nodeId) ?? 0) + 1);
    const takenIds = takenEdges(definition, state);
    const taken = new Set(takenIds);
    const lastEdge = takenIds.at(-1);
    const finished = state.status === 'completed';
    const mark = (id: string): RunMark | undefined => {
      if (id === state.currentNode && !finished) {
        if (state.status === 'failed') return 'failed';
        return state.status === 'waiting_human' || state.status === 'waiting_timer' ? 'waiting' : 'active';
      }
      return visits.has(id) ? 'visited' : undefined;
    };
    const nodes: StepNode[] = f.nodes.map((n) => ({
      ...n,
      draggable: false,
      connectable: false,
      data: { ...n.data, run: mark(n.id), visits: visits.get(n.id) },
    }));
    const edges: StepEdge[] = f.edges.map((e) => ({
      ...e,
      className: [e.className, taken.has(e.id) && 'edge-taken'].filter(Boolean).join(' ') || undefined,
      animated: e.id === lastEdge && !finished,
    }));
    return { nodes, edges };
  }, [definition, state]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      defaultEdgeOptions={{ type: 'smoothstep' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function HumanTask({
  runId,
  req,
  nodeLabel,
  onSubmitted,
  context,
}: {
  runId: string;
  req: HumanRequest;
  nodeLabel: string;
  onSubmitted?: () => void;
  /** Extra line under the title, e.g. which flow and run this is for. */
  context?: React.ReactNode;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.submitHuman(runId, { nodeId: req.nodeId, values });
      onSubmitted?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const left = req.timeoutAt ? Math.max(0, req.timeoutAt - now) : null;
  return (
    <div className="card human">
      <div className="card-title">
        <Icon name="human" /> {nodeLabel}
        {req.assignee && <span className="chip">{req.assignee}</span>}
        {left !== null && <span className="chip ghost">⏱ {formatLeft(left)}</span>}
      </div>
      {context}
      <div className="human-prompt">{req.prompt}</div>
      {req.message && (
        <div className="human-message">
          <span className="muted small">From the agent</span>
          <div>{req.message}</div>
        </div>
      )}
      <FormFields fields={req.form} values={values} onChange={setValues} />
      {error && <div className="error-box">{error}</div>}
      <button className="btn primary" onClick={submit} disabled={busy}>
        {busy ? 'Sending…' : 'Submit'}
      </button>
      <div className="muted small">Sent as a Temporal Update; the workflow validates it before accepting.</div>
    </div>
  );
}

function TimerCard({ state, nodeLabel }: { state: RunState; nodeLabel: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const timer = state.timer;
  return (
    <div className="card info">
      <div className="card-title">
        <Icon name="wait" /> {nodeLabel}
        {timer && <span className="chip ghost">⏱ {formatLeft(Math.max(0, timer.endsAt - now))}</span>}
      </div>
      <div>Waiting {timer ? timer.duration : ''} on a durable Temporal timer. The worker can restart and the timer still fires.</div>
    </div>
  );
}

function formatLeft(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s left`;
  if (s < 7200) return `${Math.round(s / 60)}m left`;
  return `${Math.round(s / 3600)}h left`;
}

function Timeline({ events, nodeLabel }: { events: RunEvent[]; nodeLabel: (id: string | null) => string }) {
  const t0 = events[0]?.ts ?? 0;
  const items = [...events].reverse();
  return (
    <ol className="timeline">
      {items.map((e, i) => (
        <li key={events.length - i} className={`ev ev-${e.kind}`}>
          <span className="ev-time mono">+{((e.ts - t0) / 1000).toFixed(1)}s</span>
          <div className="ev-body">
            <EventBody e={e} nodeLabel={nodeLabel} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function EventBody({ e, nodeLabel }: { e: RunEvent; nodeLabel: (id: string | null) => string }) {
  switch (e.kind) {
    case 'thought':
      return <div className="ev-thought">{e.text}</div>;
    case 'enter':
      return (
        <div>
          <b>→ {nodeLabel(e.nodeId)}</b>
          {e.reason && <div className="muted small">{e.reason}</div>}
        </div>
      );
    case 'tool_call':
      return (
        <details>
          <summary>
            <span className="mono">{e.tool}</span> called
          </summary>
          <pre>{JSON.stringify(e.input, null, 2)}</pre>
        </details>
      );
    case 'tool_result':
      return (
        <details>
          <summary className={e.isError ? 'err' : ''}>
            <span className="mono">{e.tool}</span> {e.isError ? 'failed' : 'returned'}
          </summary>
          <pre>{typeof e.output === 'string' ? e.output : JSON.stringify(e.output, null, 2)}</pre>
        </details>
      );
    case 'rejected':
      return (
        <div className="err">
          Runtime rejected <span className="mono">{e.tool}</span>: {e.message}
        </div>
      );
    case 'human_request':
      return <div>Asked a person at “{nodeLabel(e.nodeId)}”</div>;
    case 'human_response':
      return e.timedOut ? (
        <div className="warn">Human request timed out</div>
      ) : (
        <details>
          <summary>Person answered</summary>
          <pre>{JSON.stringify(e.values, null, 2)}</pre>
        </details>
      );
    case 'wait':
      return <div>Timer started ({e.duration})</div>;
    case 'variable':
      return (
        <details>
          <summary>
            Saved <span className="mono">{e.name}</span>
          </summary>
          <pre>{JSON.stringify(e.value, null, 2)}</pre>
        </details>
      );
    case 'nudge':
      return <div className="warn">Runtime nudged the agent: {e.text}</div>;
    case 'finish':
      return <b>Finished</b>;
    case 'error':
      return <div className="err">{e.message}</div>;
  }
}
