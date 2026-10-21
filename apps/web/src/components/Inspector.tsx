import { useEffect, useState } from 'react';
import { DURATION_RE, SINGLE_TEMPLATE_RE, TOOL_CATALOG, TOOLS_BY_NAME, type Issue } from '@demo/dsl';
import type { StepEdge, StepNode, StepPatch, WorkflowMeta } from '../flow';
import { FieldMapEditor } from './FieldMapEditor';
import { Icon, NODE_META } from './icons';

interface Props {
  meta: WorkflowMeta;
  setMeta: (m: WorkflowMeta) => void;
  nodes: StepNode[];
  edges: StepEdge[];
  selectedNode?: StepNode;
  selectedEdge?: StepEdge;
  issues: Issue[];
  usedTools: string[];
  updateStep: (id: string, patch: StepPatch) => void;
  renameNode: (from: string, to: string) => boolean;
  deleteNode: (id: string) => void;
  updateEdge: (id: string, patch: { label?: string; on?: 'timeout'; when?: string }) => void;
  deleteEdge: (id: string) => void;
}

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <section className="insp-section">
      <div className="insp-label">{title}</div>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </section>
  );
}

/** Text input that commits on blur, so typing doesn't thrash the graph. */
function IdInput({ value, onCommit }: { value: string; onCommit: (v: string) => boolean }) {
  const [v, setV] = useState(value);
  const [bad, setBad] = useState(false);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={`mono ${bad ? 'invalid' : ''}`}
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        setBad(false);
      }}
      onBlur={() => {
        if (v === value) return;
        if (!onCommit(v)) setBad(true);
      }}
    />
  );
}

export function Inspector(props: Props) {
  const { selectedNode, selectedEdge } = props;
  if (selectedNode) return <NodeInspector {...props} node={selectedNode} />;
  if (selectedEdge) return <EdgeInspector {...props} edge={selectedEdge} />;
  return <WorkflowInspector {...props} />;
}

function TemplateHint({ meta, nodes }: { meta: WorkflowMeta; nodes: StepNode[] }) {
  const vars = [
    ...Object.keys(meta.inputs).map((k) => `inputs.${k}`),
    ...nodes.flatMap((n) => ('saveAs' in n.data.step && n.data.step.saveAs ? [n.data.step.saveAs] : [])),
  ];
  if (!vars.length) return null;
  return (
    <>
      Templates:{' '}
      {vars.map((v) => (
        <code key={v}>{`{{${v}}}`}</code>
      ))}
    </>
  );
}

function WorkflowInspector({ meta, setMeta, issues, usedTools }: Props) {
  return (
    <div className="insp">
      <div className="insp-title">
        <span>Workflow settings</span>
      </div>
      <Section title="Name">
        <input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
      </Section>
      <Section title="ID">
        <input className="mono" value={meta.id} onChange={(e) => setMeta({ ...meta, id: e.target.value.replace(/[^\w-]/g, '-') })} />
      </Section>
      <Section title="Description" hint="Included in the agent's system prompt as the workflow's purpose.">
        <textarea rows={3} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
      </Section>
      <Section title="Run inputs" hint="Parameters supplied when a run starts. Reference them as {{inputs.name}}.">
        <FieldMapEditor value={meta.inputs} onChange={(inputs) => setMeta({ ...meta, inputs })} withDefaults addLabel="Add input" />
      </Section>
      <Section title="Tools in use" hint="Derived from the steps. Only these are exposed to the agent.">
        <div className="chips">
          {usedTools.length ? usedTools.map((t) => <span key={t} className="chip">{t}</span>) : <span className="muted small">None yet</span>}
        </div>
      </Section>
      {issues.length > 0 && (
        <Section title="Checks">
          <ul className="issues">
            {issues.map((i, k) => (
              <li key={k} className={i.level}>
                <Icon name="alert" size={12} /> {i.message}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <div className="insp-empty-hint">Select a step or an edge to edit it. Drag from a step's bottom handle to connect it.</div>
    </div>
  );
}

function NodeInspector({ node, meta, nodes, edges, updateStep, renameNode, deleteNode, updateEdge, issues }: Props & { node: StepNode }) {
  const step = node.data.step;
  const set = (patch: StepPatch) => updateStep(node.id, patch);
  const out = edges.filter((e) => e.source === node.id);
  const nodeIssues = issues.filter((i) => i.nodeId === node.id);
  const title = (id: string) => nodes.find((n) => n.id === id)?.data.step.label ?? id;

  return (
    <div className="insp">
      <div className={`insp-title t-${step.type}`}>
        <span className="step-icon">
          <Icon name={step.type} size={13} />
        </span>
        <span>{NODE_META[step.type].title}</span>
        <button className="icon-btn danger" onClick={() => deleteNode(node.id)} title="Delete step">
          <Icon name="trash" />
        </button>
      </div>

      {nodeIssues.length > 0 && (
        <ul className="issues">
          {nodeIssues.map((i, k) => (
            <li key={k} className={i.level}>
              <Icon name="alert" size={12} /> {i.message}
            </li>
          ))}
        </ul>
      )}

      <Section title="Label">
        <input value={step.label ?? ''} onChange={(e) => set({ label: e.target.value })} />
      </Section>
      <Section title="Step ID" hint="Used by the agent and in edges. Renaming updates connected edges.">
        <IdInput value={node.id} onCommit={(v) => renameNode(node.id, v)} />
      </Section>

      {step.type === 'agent' && (
        <>
          <Section title="Instructions" hint={<TemplateHint meta={meta} nodes={nodes} />}>
            <textarea rows={6} value={step.instructions} onChange={(e) => set({ instructions: e.target.value })} />
          </Section>
          <Section title="Allowed tools">
            <ToolChecklist value={step.tools} onChange={(tools) => set({ tools })} />
          </Section>
          <Section title="Save result as" hint="Later steps can refer to this step's result by this name, e.g. {{score.score}}.">
            <input className="mono" placeholder="(optional)" value={step.saveAs ?? ''} onChange={(e) => set({ saveAs: e.target.value || undefined })} />
          </Section>
        </>
      )}

      {step.type === 'tool' && (
        <>
          <Section title="Tool" hint={TOOLS_BY_NAME[step.tool]?.description}>
            <select value={step.tool} onChange={(e) => set({ tool: e.target.value, args: 'agent' })}>
              {TOOL_CATALOG.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.category} · {t.title}
                </option>
              ))}
            </select>
          </Section>
          <Section title="Arguments" hint={step.args !== 'agent' && <TemplateHint meta={meta} nodes={nodes} />}>
            <div className="seg">
              <button className={step.args === 'agent' ? 'on' : ''} onClick={() => set({ args: 'agent' })}>
                Agent decides
              </button>
              <button
                className={step.args !== 'agent' ? 'on' : ''}
                onClick={() =>
                  step.args === 'agent' &&
                  set({ args: Object.fromEntries((TOOLS_BY_NAME[step.tool]?.required ?? []).map((p) => [p, ''])) })
                }
              >
                Set values
              </button>
            </div>
            {step.args !== 'agent' &&
              Object.entries(TOOLS_BY_NAME[step.tool]?.params ?? {}).map(([p, spec]) => {
                const args = step.args as Record<string, string>;
                return (
                  <div key={p} className="arg-row">
                    <label className="mono small">
                      {p}
                      {TOOLS_BY_NAME[step.tool].required.includes(p) && <span className="req">*</span>}
                    </label>
                    <input
                      className="mono"
                      placeholder={spec.description}
                      value={args[p] ?? ''}
                      onChange={(e) => {
                        const next = { ...args, [p]: e.target.value };
                        if (!e.target.value) delete next[p];
                        set({ args: next });
                      }}
                    />
                  </div>
                );
              })}
          </Section>
          <Section title="Notes for the agent">
            <textarea rows={2} value={step.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value || undefined })} />
          </Section>
          <Section title="Save result as" hint="Later steps can refer to the tool's result by this name.">
            <input className="mono" placeholder="(optional)" value={step.saveAs ?? ''} onChange={(e) => set({ saveAs: e.target.value || undefined })} />
          </Section>
        </>
      )}

      {step.type === 'decision' && (
        <>
          <Section title="Decision criteria" hint={<TemplateHint meta={meta} nodes={nodes} />}>
            <textarea rows={5} value={step.instructions} onChange={(e) => set({ instructions: e.target.value })} />
          </Section>
          <Section title="Options" hint={<RuleHint meta={meta} nodes={nodes} />}>
            {out.length === 0 && <div className="muted small">Connect this step to two or more steps.</div>}
            {out.map((e) => (
              <div key={e.id} className="option-row">
                <div className="arg-row">
                  <input value={e.data?.label ?? ''} placeholder="option label" onChange={(ev) => updateEdge(e.id, { label: ev.target.value })} />
                  <span className="muted small">→ {title(e.target)}</span>
                </div>
                <RuleInput value={e.data?.when ?? ''} onChange={(when) => updateEdge(e.id, { when })} issue={issues.find((i) => i.edgeId === e.id)?.message} />
              </div>
            ))}
          </Section>
        </>
      )}

      {step.type === 'human' && (
        <>
          <Section title="Prompt" hint={<TemplateHint meta={meta} nodes={nodes} />}>
            <textarea rows={4} value={step.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          </Section>
          <Section title="Assignee">
            <input placeholder="e.g. Support manager" value={step.assignee ?? ''} onChange={(e) => set({ assignee: e.target.value || undefined })} />
          </Section>
          <Section title="Timeout" hint="Like 30m, 24h or 2d. Leave empty to wait forever. Add a timeout path by marking an outgoing edge as timeout.">
            <input
              className={`mono ${step.timeout && !DURATION_RE.test(step.timeout) ? 'invalid' : ''}`}
              placeholder="(none)"
              value={step.timeout ?? ''}
              onChange={(e) => set({ timeout: e.target.value || undefined })}
            />
          </Section>
          <Section title="Form">
            <FieldMapEditor value={step.form} onChange={(form) => set({ form })} />
          </Section>
          <Section title="Outcomes" hint="Label each outcome so the agent can route on the answer.">
            {out.map((e) => (
              <div key={e.id} className="arg-row">
                <input
                  value={e.data?.on === 'timeout' ? '' : (e.data?.label ?? '')}
                  disabled={e.data?.on === 'timeout'}
                  placeholder={e.data?.on === 'timeout' ? 'timeout path' : 'outcome label'}
                  onChange={(ev) => updateEdge(e.id, { label: ev.target.value })}
                />
                <span className="muted small">→ {title(e.target)}</span>
              </div>
            ))}
          </Section>
          <Section title="Save answer as">
            <input className="mono" placeholder="(optional)" value={step.saveAs ?? ''} onChange={(e) => set({ saveAs: e.target.value || undefined })} />
          </Section>
        </>
      )}

      {step.type === 'wait' && (
        <Section
          title="Duration"
          hint="A fixed duration like 30s, 10m or 1h, or a value from the run: a human answer or run input of type duration (a number means seconds). Uses a durable Temporal timer."
        >
          <input
            className={`mono ${!DURATION_RE.test(step.duration) && !SINGLE_TEMPLATE_RE.test(step.duration) ? 'invalid' : ''}`}
            value={step.duration}
            onChange={(e) => set({ duration: e.target.value })}
          />
          <DurationSources meta={meta} nodes={nodes} current={step.duration} onPick={(duration) => set({ duration })} />
        </Section>
      )}

      {step.type === 'end' && (
        <>
          <Section title="Final instructions">
            <textarea rows={2} placeholder="(optional)" value={step.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value || undefined })} />
          </Section>
          <Section title="Output fields" hint="The fields the agent returns when it finishes.">
            <FieldMapEditor value={step.output} onChange={(output) => set({ output })} />
          </Section>
        </>
      )}

      {step.type !== 'start' && step.type !== 'end' && (
        <Section title="Max visits" hint="Tells the agent how many times it may enter this step (for loops).">
          <input
            type="number"
            min={1}
            value={step.maxVisits ?? ''}
            placeholder="5"
            onChange={(e) => set({ maxVisits: e.target.value ? Number(e.target.value) : undefined })}
          />
        </Section>
      )}
    </div>
  );
}

/** Duration-like fields this wait can take its length from. */
function DurationSources({ meta, nodes, current, onPick }: { meta: WorkflowMeta; nodes: StepNode[]; current: string; onPick: (v: string) => void }) {
  const refs = [
    ...Object.entries(meta.inputs).flatMap(([k, f]) => (f.type === 'duration' || f.type === 'number' ? [{ ref: `inputs.${k}`, from: 'run input' }] : [])),
    ...nodes.flatMap((n) => {
      const s = n.data.step;
      if (s.type !== 'human' || !s.saveAs) return [];
      return Object.entries(s.form).flatMap(([k, f]) =>
        f.type === 'duration' || f.type === 'number' ? [{ ref: `${s.saveAs}.${k}`, from: s.label ?? n.id }] : [],
      );
    }),
  ];
  if (!refs.length) {
    return <div className="hint">To let a person choose the length, add a field of type duration to a human step’s form and give that step a “Save answer as” name.</div>;
  }
  return (
    <div className="chips">
      {refs.map(({ ref, from }) => {
        const v = `{{${ref}}}`;
        return (
          <button key={ref} className={`chip pick ${current === v ? 'on' : ''}`} onClick={() => onPick(v)} title={`From ${from}`}>
            {v}
          </button>
        );
      })}
    </div>
  );
}

function ToolChecklist({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="tool-list">
      {TOOL_CATALOG.map((t) => (
        <label key={t.name} className="check tool-check">
          <input
            type="checkbox"
            checked={value.includes(t.name)}
            onChange={(e) => onChange(e.target.checked ? [...value, t.name] : value.filter((x) => x !== t.name))}
          />
          <span className="mono">{t.name}</span>
          {t.sideEffect && <span className="chip warn-chip" title="Changes something outside the workflow">writes</span>}
        </label>
      ))}
    </div>
  );
}

function RuleInput({ value, onChange, issue }: { value: string; onChange: (v: string) => void; issue?: string }) {
  return (
    <>
      <input
        className={`mono small rule-input ${issue && /Rule/.test(issue) ? 'invalid' : ''}`}
        value={value}
        placeholder="rule (optional), e.g. order.amount > 100"
        onChange={(e) => onChange(e.target.value)}
      />
      {issue && /Rule/.test(issue) && <div className="hint err">{issue}</div>}
    </>
  );
}

function RuleHint({ meta, nodes }: { meta: WorkflowMeta; nodes: StepNode[] }) {
  return (
    <>
      Each edge is an option the agent picks by its label. Add a rule to pin the choice down: the agent checks rules top to
      bottom, takes the first true one, and uses an option without a rule as the fallback. Without rules, the agent decides from
      the criteria. Rules use <code>== != &gt; &lt; &amp;&amp; ||</code> over saved values. <TemplateHint meta={meta} nodes={nodes} />
    </>
  );
}

function EdgeInspector({ edge, nodes, meta, issues, updateEdge, deleteEdge }: Props & { edge: StepEdge }) {
  const from = nodes.find((n) => n.id === edge.source);
  const to = nodes.find((n) => n.id === edge.target);
  const fromType = from?.data.step.type;
  return (
    <div className="insp">
      <div className="insp-title">
        <span>Edge</span>
        <button className="icon-btn danger" onClick={() => deleteEdge(edge.id)} title="Delete edge">
          <Icon name="trash" />
        </button>
      </div>
      <Section title="From → To">
        <div className="small">
          {from?.data.step.label ?? edge.source} → {to?.data.step.label ?? edge.target}
        </div>
      </Section>
      <Section title="Label" hint={fromType === 'decision' || fromType === 'human' ? 'The option the agent chooses.' : 'Optional.'}>
        <input value={edge.data?.label ?? ''} disabled={edge.data?.on === 'timeout'} onChange={(e) => updateEdge(edge.id, { label: e.target.value })} />
      </Section>
      {fromType === 'decision' && (
        <Section title="Rule" hint={<RuleHint meta={meta} nodes={nodes} />}>
          <RuleInput value={edge.data?.when ?? ''} onChange={(when) => updateEdge(edge.id, { when })} issue={issues.find((i) => i.edgeId === edge.id)?.message} />
        </Section>
      )}
      {fromType === 'human' && (
        <Section title="Timeout path" hint="Taken only when the human step times out. You can also drag from the step\u2019s right-hand handle.">
          <label className="check">
            <input
              type="checkbox"
              checked={edge.data?.on === 'timeout'}
              onChange={(e) => updateEdge(edge.id, { on: e.target.checked ? 'timeout' : undefined, label: undefined })}
            />
            Use this edge on timeout
          </label>
        </Section>
      )}
    </div>
  );
}
