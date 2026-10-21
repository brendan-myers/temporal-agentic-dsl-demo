import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from './types';

export function nodeById(def: WorkflowDefinition, id: string): WorkflowNode | undefined {
  return def.nodes.find((n) => n.id === id);
}

export function outgoing(def: WorkflowDefinition, id: string): WorkflowEdge[] {
  return def.edges.filter((e) => e.from === id);
}

export function incoming(def: WorkflowDefinition, id: string): WorkflowEdge[] {
  return def.edges.filter((e) => e.to === id);
}

export function nodeTitle(node: WorkflowNode): string {
  return node.label?.trim() || `${node.type} ${node.id}`;
}

/** Breadth-first order from the start node, then any unreachable nodes. */
export function orderedNodes(def: WorkflowDefinition): WorkflowNode[] {
  const seen = new Set<string>();
  const order: WorkflowNode[] = [];
  const queue = [def.start];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    const node = nodeById(def, id);
    if (!node) continue;
    seen.add(id);
    order.push(node);
    for (const e of outgoing(def, id)) queue.push(e.to);
  }
  for (const n of def.nodes) if (!seen.has(n.id)) order.push(n);
  return order;
}

export function reachable(def: WorkflowDefinition): Set<string> {
  const seen = new Set<string>();
  const stack = [def.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of outgoing(def, id)) stack.push(e.to);
  }
  return seen;
}

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Template references like {{inputs.order_id}} or {{order.amount}} in a string. */
export function templateRefs(text: string): string[] {
  return [...text.matchAll(TEMPLATE_RE)].map((m) => m[1]);
}

function lookup(path: string, ctx: Record<string, unknown>): unknown {
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Replace {{path}} references using `ctx` (e.g. { inputs, ...variables }).
 * Unresolved references are left as-is so the agent can see what is missing.
 */
export function renderTemplate(text: string, ctx: Record<string, unknown>): string {
  return text.replace(TEMPLATE_RE, (whole, path: string) => {
    const v = lookup(path, ctx);
    if (v === undefined) return whole;
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** JSON with sorted keys and no undefined values, for comparing definitions. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Whether two definitions are the same apart from their version number. */
export function sameDefinition(a: WorkflowDefinition, b: WorkflowDefinition): boolean {
  return canonicalJson({ ...a, version: 0 }) === canonicalJson({ ...b, version: 0 });
}
