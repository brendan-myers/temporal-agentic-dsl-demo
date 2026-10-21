import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
} from '@xyflow/react';
import {
  NODE_TYPES,
  WorkflowDefinitionSchema,
  canonicalJson,
  compileFirstMessage,
  validateDefinition,
  type NodeType,
  type WorkflowDefinition,
} from '@demo/dsl';
import { BLANK, edgeLabel, fromFlow, newStep, toFlow, uniqueId, type StepData, type StepEdge, type StepPatch, type StepNode, type WorkflowMeta } from '../flow';
import AGENT_SYSTEM_PROMPT from '@agent-context/system-prompt.md?raw';
import { api, type SavedFlowSummary } from '../api';
import { EXAMPLES } from '../examples';
import { Inspector } from './Inspector';
import { Icon, NODE_META } from './icons';
import { defaultsFor } from './FormFields';
import { RunDialog } from './RunDialog';
import { nodeTypes } from './StepNode';

// Bump when the bundled templates change shape, so stale saved copies don't hide new features.
const STORAGE_KEY = 'wysiwyg-dsl:definition:v2';

function loadSaved(): WorkflowDefinition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return EXAMPLES[0];
}

/** Comparable form of a definition: defaults applied, key order and version ignored. */
const stable = (d: WorkflowDefinition) => {
  const parsed = WorkflowDefinitionSchema.safeParse(d);
  return canonicalJson({ ...(parsed.success ? parsed.data : d), version: 0 });
};

interface BuilderProps {
  onRunStarted: (id: string) => void;
  /** Called after a save or delete so other views can refresh their flow lists. */
  onFlowsChanged?: () => void;
}

export function Builder(props: BuilderProps) {
  return (
    <ReactFlowProvider>
      <BuilderInner {...props} />
    </ReactFlowProvider>
  );
}

type SideTab = 'inspect' | 'json' | 'prompt';

function BuilderInner({ onRunStarted, onFlowsChanged }: BuilderProps) {
  const initial = useMemo(() => toFlow(loadSaved()), []);
  const [meta, setMeta] = useState<WorkflowMeta>(initial.meta);
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StepEdge>(initial.edges);
  const [tab, setTab] = useState<SideTab>('inspect');
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // Saved flows (server-side) and the saved copy of the flow being edited, if any.
  const [savedFlows, setSavedFlows] = useState<SavedFlowSummary[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState<{ id: string; json: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const definition = useMemo(() => fromFlow(meta, nodes, edges), [meta, nodes, edges]);
  const isSaved = savedFlows.some((f) => f.id === definition.id);
  const dirty = !savedSnapshot || savedSnapshot.id !== definition.id || savedSnapshot.json !== stable(definition);

  const refreshFlows = useCallback(() => {
    api
      .listFlows()
      .then((r) => setSavedFlows(r.flows))
      .catch(() => {});
  }, []);

  // On first load, find out whether what's on the canvas matches its saved copy.
  useEffect(() => {
    refreshFlows();
    api
      .getFlow(initial.meta.id)
      .then((f) => setSavedSnapshot({ id: f.definition.id, json: stable(f.definition) }))
      .catch(() => setSavedSnapshot(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => setConfirmDelete(false), [definition.id]);
  const validation = useMemo(() => validateDefinition(definition), [definition]);
  const errors = validation.issues.filter((i) => i.level === 'error');
  const warnings = validation.issues.filter((i) => i.level === 'warning');

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(definition));
    } catch {
      /* storage unavailable */
    }
  }, [definition]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // Decorate nodes with their worst issue so problems show on the canvas.
  const displayNodes = useMemo(() => {
    const worst = new Map<string, 'error' | 'warning'>();
    for (const i of validation.issues) {
      if (!i.nodeId) continue;
      if (i.level === 'error' || !worst.has(i.nodeId)) worst.set(i.nodeId, i.level);
    }
    return nodes.map((n) => (worst.get(n.id) === n.data.issue ? n : { ...n, data: { ...n.data, issue: worst.get(n.id) } }));
  }, [nodes, validation.issues]);

  const load = useCallback(
    (def: WorkflowDefinition) => {
      const f = toFlow(def);
      setMeta(f.meta);
      setNodes(f.nodes);
      setEdges(f.edges);
      setTab('inspect');
      requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
    },
    [setEdges, setNodes, fitView],
  );

  const addStep = useCallback(
    (type: NodeType, position?: { x: number; y: number }) => {
      if (type === 'start' && nodes.some((n) => n.data.step.type === 'start')) {
        setToast('A workflow has one Start step.');
        return;
      }
      const id = type === 'start' ? 'start' : uniqueId(type, nodes.map((n) => n.id));
      const pos = position ?? screenToFlowPosition({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 60 });
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { id, type: 'step', position: pos, data: { step: newStep(type) }, selected: true },
      ]);
      setTab('inspect');
    },
    [nodes, screenToFlowPosition, setNodes],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const id = uniqueId('e', edges.map((e) => e.id));
      const timeout = c.sourceHandle === 'timeout';
      setEdges((es) =>
        addEdge({ ...c, id, data: timeout ? { on: 'timeout' } : {}, label: timeout ? edgeLabel(undefined, 'timeout') : undefined, className: timeout ? 'edge-timeout' : undefined }, es),
      );
    },
    [edges, setEdges],
  );

  const updateStep = useCallback(
    (id: string, patch: StepPatch) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, step: { ...n.data.step, ...patch } as StepData } } : n))),
    [setNodes],
  );

  const renameNode = useCallback(
    (from: string, to: string) => {
      const clean = to.trim();
      if (!/^[\w-]+$/.test(clean) || nodes.some((n) => n.id === clean)) return false;
      setNodes((ns) => ns.map((n) => (n.id === from ? { ...n, id: clean } : n)));
      setEdges((es) => es.map((e) => ({ ...e, source: e.source === from ? clean : e.source, target: e.target === from ? clean : e.target })));
      return true;
    },
    [nodes, setEdges, setNodes],
  );

  const updateEdge = useCallback(
    (id: string, patch: { label?: string; on?: 'timeout'; when?: string }) =>
      setEdges((es) =>
        es.map((e) => {
          if (e.id !== id) return e;
          const data = { ...e.data, ...patch };
          return {
            ...e,
            data,
            label: edgeLabel(data.label, data.on),
            className: data.on === 'timeout' ? 'edge-timeout' : undefined,
            sourceHandle: data.on === 'timeout' ? 'timeout' : null,
          };
        }),
      ),
    [setEdges],
  );

  const selectedNode = nodes.find((n) => n.selected);
  const selectedEdge = selectedNode ? undefined : edges.find((e) => e.selected);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(definition, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${definition.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(`${what} copied`);
    } catch {
      setToast('Clipboard unavailable');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const { flow, changed } = await api.saveFlow(definition);
      setMeta((m) => ({ ...m, version: flow.definition.version }));
      setSavedSnapshot({ id: flow.definition.id, json: stable(flow.definition) });
      setToast(changed ? `Saved “${flow.definition.name}” (v${flow.definition.version})${flow.valid ? '' : ' with errors; fix them before it can run'}` : 'No changes to save');
      refreshFlows();
      onFlowsChanged?.();
    } catch (e) {
      setToast(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const openSaved = async (id: string) => {
    try {
      const f = await api.getFlow(id);
      load(f.definition);
      setSavedSnapshot({ id, json: stable(f.definition) });
    } catch (e) {
      setToast(`Couldn’t open: ${(e as Error).message}`);
    }
  };

  const deleteSaved = async () => {
    try {
      await api.deleteFlow(definition.id);
      setSavedSnapshot(null);
      setConfirmDelete(false);
      setToast(`Deleted saved flow “${definition.name}”. It’s still on the canvas.`);
      refreshFlows();
      onFlowsChanged?.();
    } catch (e) {
      setToast(`Delete failed: ${(e as Error).message}`);
    }
  };

  const importJson = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text());
      const res = validateDefinition(raw);
      if (!res.definition) throw new Error(res.issues[0]?.message ?? 'Not a workflow definition');
      load(res.definition);
      setToast(`Imported “${res.definition.name}”`);
    } catch (e) {
      setToast(`Import failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="builder">
      <div className="toolbar">
        <select
          className="template-select"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__blank') load(BLANK);
            else if (v.startsWith('saved:')) openSaved(v.slice(6));
            else {
              const ex = EXAMPLES.find((x) => x.id === v);
              if (ex) load(ex);
            }
          }}
        >
          <option value="" disabled>
            Open…
          </option>
          {savedFlows.length > 0 && (
            <optgroup label="Saved flows">
              {savedFlows.map((f) => (
                <option key={f.id} value={`saved:${f.id}`}>
                  {f.name} (v{f.version})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Templates">
            {EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.name}
              </option>
            ))}
            <option value="__blank">Blank workflow</option>
          </optgroup>
        </select>
        <div className="toolbar-name">{meta.name}</div>
        <span className={`save-state ${dirty ? 'dirty' : ''}`}>
          {!dirty ? `Saved · v${meta.version}` : isSaved ? 'Unsaved changes' : 'Not saved'}
        </span>
        <div className="spacer" />
        <button
          className={`badge ${errors.length ? 'bad' : warnings.length ? 'meh' : 'good'}`}
          onClick={() => {
            setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
            setEdges((es) => es.map((e) => ({ ...e, selected: false })));
            setTab('inspect');
          }}
          title="Show checks"
        >
          <Icon name={errors.length ? 'alert' : 'check'} size={12} />
          {errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : 'Valid'}
          {warnings.length > 0 && <span className="muted"> · {warnings.length} warning{warnings.length > 1 ? 's' : ''}</span>}
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} title="Import JSON">
          <Icon name="upload" /> Import
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
        <button className="btn" onClick={exportJson} title="Download JSON">
          <Icon name="download" /> Export
        </button>
        {isSaved &&
          (confirmDelete ? (
            <span className="confirm">
              Delete saved “{meta.name}”?
              <button className="btn small danger" onClick={deleteSaved}>
                Delete
              </button>
              <button className="btn small" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="btn" onClick={() => setConfirmDelete(true)} title="Delete the saved copy of this flow">
              <Icon name="trash" />
            </button>
          ))}
        <button className="btn" onClick={save} disabled={saving || !dirty} title={`Save as “${definition.id}” so it can be run from Execute`}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn primary" disabled={!validation.ok} onClick={() => setRunning(true)} title={validation.ok ? 'Test-run what’s on the canvas' : 'Fix errors first'}>
          <Icon name="play" /> Test run
        </button>
      </div>

      <div className="builder-body">
        <aside className="palette">
          <div className="palette-title">Steps</div>
          {NODE_TYPES.map((t) => (
            <button
              key={t}
              className={`palette-item t-${t}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-step-type', t);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => addStep(t)}
              title="Click or drag onto the canvas"
            >
              <span className="step-icon">
                <Icon name={t} size={13} />
              </span>
              <span>
                <span className="palette-name">{NODE_META[t].title}</span>
                <span className="palette-blurb">{NODE_META[t].blurb}</span>
              </span>
            </button>
          ))}
          <div className="palette-foot">
            Drag from a step’s bottom handle to another step to connect them. Delete with ⌫.
          </div>
        </aside>

        <div
          className="canvas"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            const t = e.dataTransfer.getData('application/x-step-type') as NodeType;
            if (t) addStep(t, screenToFlowPosition({ x: e.clientX - 100, y: e.clientY - 30 }));
          }}
        >
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onPaneClick={() => setTab('inspect')}
            onNodeClick={() => setTab('inspect')}
            onEdgeClick={() => setTab('inspect')}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            defaultEdgeOptions={{ type: 'smoothstep' }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="minimap" style={{ width: 140, height: 96 }} />
          </ReactFlow>
        </div>

        <aside className="side">
          <div className="tabs">
            <button className={tab === 'inspect' ? 'on' : ''} onClick={() => setTab('inspect')}>
              Inspect
            </button>
            <button className={tab === 'json' ? 'on' : ''} onClick={() => setTab('json')}>
              JSON
            </button>
            <button className={tab === 'prompt' ? 'on' : ''} onClick={() => setTab('prompt')}>
              Agent context
            </button>
          </div>
          <div className="side-body">
            {tab === 'inspect' && (
              <Inspector
                meta={meta}
                setMeta={setMeta}
                nodes={nodes}
                edges={edges}
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                issues={validation.issues}
                usedTools={definition.tools}
                updateStep={updateStep}
                renameNode={renameNode}
                deleteNode={(id) => {
                  setNodes((ns) => ns.filter((n) => n.id !== id));
                  setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
                }}
                updateEdge={updateEdge}
                deleteEdge={(id) => setEdges((es) => es.filter((e) => e.id !== id))}
              />
            )}
            {tab === 'json' && (
              <CodePane text={JSON.stringify(definition, null, 2)} onCopy={(t) => copy(t, 'JSON')} note="This is what the Temporal workflow receives, along with the run inputs." />
            )}
            {tab === 'prompt' && (
              <CodePane
                text={
                  validation.definition
                    ? `── System prompt (the same for every workflow) ──\n\n${AGENT_SYSTEM_PROMPT}\n\n── First message (this workflow, with its default inputs) ──\n\n${compileFirstMessage(validation.definition, defaultsFor(validation.definition.inputs))}`
                    : 'Fix the definition to see what the agent receives.'
                }
                onCopy={(t) => copy(t, 'Agent context')}
                note="Exactly what the model receives. The workflow JSON goes in as-is; the agent decides each step itself."
                wrap
              />
            )}
          </div>
        </aside>
      </div>

      {running && validation.definition && (
        <RunDialog
          definition={validation.definition}
          onClose={() => setRunning(false)}
          onStarted={(id) => {
            setRunning(false);
            onRunStarted(id);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function CodePane({ text, onCopy, note, wrap }: { text: string; onCopy: (t: string) => void; note: string; wrap?: boolean }) {
  return (
    <div className="code-pane">
      <div className="code-pane-head">
        <span className="muted small">{note}</span>
        <button className="btn small" onClick={() => onCopy(text)}>
          <Icon name="copy" /> Copy
        </button>
      </div>
      <pre className={wrap ? 'wrap' : ''}>{text}</pre>
    </div>
  );
}
