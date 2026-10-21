import type { Edge, Node } from '@xyflow/react';
import type { NodeType, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@demo/dsl';

/** The DSL node without the fields React Flow owns (id, position). */
export type StepData = WorkflowNode extends infer N ? (N extends WorkflowNode ? Omit<N, 'id' | 'ui'> : never) : never;

/** A partial edit to whichever step type is selected. */
export type StepPatch = Record<string, unknown>;

export type RunMark = 'active' | 'waiting' | 'visited' | 'failed';

export interface StepNodeData extends Record<string, unknown> {
  step: StepData;
  run?: RunMark;
  visits?: number;
  issue?: 'error' | 'warning';
}

export interface StepEdgeData extends Record<string, unknown> {
  label?: string;
  on?: 'timeout';
  when?: string;
  run?: 'taken';
}

export type StepNode = Node<StepNodeData, 'step'>;
export type StepEdge = Edge<StepEdgeData>;

/** Workflow-level settings (everything except the graph). */
export type WorkflowMeta = Pick<WorkflowDefinition, 'id' | 'version' | 'name' | 'description' | 'inputs'>;

export function toFlow(def: WorkflowDefinition): { meta: WorkflowMeta; nodes: StepNode[]; edges: StepEdge[] } {
  const nodes: StepNode[] = def.nodes.map((n, i) => {
    const { id, ui, ...step } = n;
    return { id, type: 'step', position: ui ?? { x: 0, y: i * 120 }, data: { step } };
  });
  const edges: StepEdge[] = def.edges.map((e) => toFlowEdge(e));
  const { id, version, name, description, inputs } = def;
  return { meta: { id, version, name, description, inputs }, nodes, edges };
}

export function toFlowEdge(e: WorkflowEdge): StepEdge {
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    // Timeout paths leave from the human step's side handle so they don't overlap its outcomes.
    sourceHandle: e.on === 'timeout' ? 'timeout' : null,
    data: { label: e.label, on: e.on, when: e.when },
    label: edgeLabel(e.label, e.on),
    className: e.on === 'timeout' ? 'edge-timeout' : undefined,
  };
}

export function edgeLabel(label?: string, on?: string): string | undefined {
  if (on === 'timeout') return '⏱ timeout';
  return label || undefined;
}

export function fromFlow(meta: WorkflowMeta, nodes: StepNode[], edges: StepEdge[]): WorkflowDefinition {
  const dslNodes = nodes.map(
    (n) => ({ ...n.data.step, id: n.id, ui: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }) as WorkflowNode,
  );
  const dslEdges: WorkflowEdge[] = edges.map((e) => ({
    id: e.id,
    from: e.source,
    to: e.target,
    ...(e.data?.label ? { label: e.data.label } : {}),
    ...(e.data?.on ? { on: e.data.on } : {}),
    ...(e.data?.when?.trim() ? { when: e.data.when.trim() } : {}),
  }));
  // The tool list is derived from the steps that use tools.
  const tools = new Set<string>();
  for (const n of dslNodes) {
    if (n.type === 'tool' && n.tool) tools.add(n.tool);
    if (n.type === 'agent') n.tools.forEach((t) => tools.add(t));
  }
  return {
    ...meta,
    tools: [...tools].sort(),
    start: dslNodes.find((n) => n.type === 'start')?.id ?? '',
    nodes: dslNodes,
    edges: dslEdges,
  };
}

export function newStep(type: NodeType): StepData {
  switch (type) {
    case 'start':
      return { type, label: 'Start' };
    case 'agent':
      return { type, label: 'Agent step', instructions: '', tools: [] };
    case 'tool':
      return { type, label: 'Call tool', tool: 'lookup_customer', args: 'agent' };
    case 'decision':
      return { type, label: 'Decision', instructions: '' };
    case 'human':
      return {
        type,
        label: 'Ask a human',
        prompt: 'Please review and approve.',
        form: { approved: { type: 'boolean', required: true } },
      };
    case 'wait':
      return { type, label: 'Wait', duration: '1m' };
    case 'end':
      return { type, label: 'End', output: { summary: { type: 'text', required: true } } };
  }
}

export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) {
    const id = `${prefix}_${i}`;
    if (!set.has(id)) return id;
  }
}

export const BLANK: WorkflowDefinition = {
  id: 'new-workflow',
  version: 1,
  name: 'New workflow',
  description: '',
  inputs: {},
  tools: [],
  start: 'start',
  nodes: [
    { id: 'start', type: 'start', label: 'Start', ui: { x: 0, y: 0 } },
    { id: 'end', type: 'end', label: 'End', output: { summary: { type: 'text', required: true } }, ui: { x: 0, y: 240 } },
  ],
  edges: [],
};
