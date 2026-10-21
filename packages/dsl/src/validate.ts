import { exprRoots } from './expr';
import { incoming, outgoing, reachable, templateRefs } from './graph';
import { TOOLS_BY_NAME } from './tools';
import { DURATION_RE, SINGLE_TEMPLATE_RE, WorkflowDefinitionSchema, type FieldMap, type WorkflowDefinition } from './types';

export interface Issue {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  /** Parsed definition with defaults applied (only when the shape is valid). */
  definition?: WorkflowDefinition;
}

export function validateDefinition(raw: unknown): ValidationResult {
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        level: 'error' as const,
        message: `${i.path.join('.') || 'definition'}: ${i.message}`,
      })),
    };
  }
  const def = parsed.data;
  const issues: Issue[] = [];
  const err = (message: string, ref: Partial<Issue> = {}) => issues.push({ level: 'error', message, ...ref });
  const warn = (message: string, ref: Partial<Issue> = {}) => issues.push({ level: 'warning', message, ...ref });

  const ids = new Set<string>();
  for (const n of def.nodes) {
    if (ids.has(n.id)) err(`Duplicate node id "${n.id}"`, { nodeId: n.id });
    ids.add(n.id);
  }
  const edgeIds = new Set<string>();
  for (const e of def.edges) {
    if (edgeIds.has(e.id)) err(`Duplicate edge id "${e.id}"`, { edgeId: e.id });
    edgeIds.add(e.id);
    if (!ids.has(e.from)) err(`Edge ${e.id} starts at unknown node "${e.from}"`, { edgeId: e.id });
    if (!ids.has(e.to)) err(`Edge ${e.id} points to unknown node "${e.to}"`, { edgeId: e.id });
  }

  const starts = def.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) err(`Need exactly one Start node (found ${starts.length})`);
  else if (def.start !== starts[0].id) err(`"start" must be the Start node id ("${starts[0].id}")`);
  if (!def.nodes.some((n) => n.type === 'end')) err('Need at least one End node');

  const live = reachable(def);
  const declaredTools = new Set(def.tools);
  const inputNames = new Set(Object.keys(def.inputs));
  const saved = new Set(
    def.nodes.flatMap((n) => ('saveAs' in n && n.saveAs ? [n.saveAs] : [])),
  );

  const checkTemplates = (text: string, nodeId: string) => {
    for (const ref of templateRefs(text)) {
      const [root, key] = ref.split('.');
      if (root === 'inputs') {
        if (key && !inputNames.has(key)) warn(`Unknown input "{{${ref}}}"`, { nodeId });
      } else if (!saved.has(root)) {
        warn(`"{{${ref}}}" doesn't match any input or saved variable`, { nodeId });
      }
    }
  };

  for (const n of def.nodes) {
    const out = outgoing(def, n.id);
    const label = n.label || n.id;
    if (!live.has(n.id)) warn(`"${label}" is not reachable from Start`, { nodeId: n.id });
    if (n.type === 'start' && incoming(def, n.id).length) err('Start cannot have incoming edges', { nodeId: n.id });
    if (n.type === 'end') {
      if (out.length) err('End cannot have outgoing edges', { nodeId: n.id });
    } else if (!out.length) {
      err(`"${label}" has no outgoing edge`, { nodeId: n.id });
    }

    switch (n.type) {
      case 'decision': {
        if (out.length < 2) err(`Decision "${label}" needs at least 2 options`, { nodeId: n.id });
        for (const e of out) if (!e.label?.trim()) err(`Decision "${label}" has an unlabeled option`, { edgeId: e.id, nodeId: n.id });
        if (!n.instructions.trim()) warn(`Decision "${label}" has no instructions`, { nodeId: n.id });
        checkTemplates(n.instructions, n.id);
        break;
      }
      case 'agent': {
        if (!n.instructions.trim()) err(`Agent step "${label}" needs instructions`, { nodeId: n.id });
        for (const t of n.tools) checkTool(t, n.id);
        checkTemplates(n.instructions, n.id);
        break;
      }
      case 'tool': {
        checkTool(n.tool, n.id);
        if (n.args !== 'agent') {
          const spec = TOOLS_BY_NAME[n.tool];
          for (const [k, v] of Object.entries(n.args)) {
            if (spec && !spec.params[k]) warn(`"${n.tool}" has no parameter "${k}"`, { nodeId: n.id });
            checkTemplates(v, n.id);
          }
        }
        break;
      }
      case 'wait': {
        const ref = SINGLE_TEMPLATE_RE.exec(n.duration)?.[1];
        if (ref) {
          checkTemplates(n.duration, n.id);
          const [root, key] = ref.split('.');
          // Point at the field the value comes from so its type can be checked.
          const asker = def.nodes.find((x) => x.type === 'human' && x.saveAs === root);
          const source: FieldMap | undefined = root === 'inputs' ? def.inputs : asker?.type === 'human' ? asker.form : undefined;
          const field = source && key ? source[key] : undefined;
          if (source && key && !field) warn(`Wait "${label}" uses "${ref}", but there's no "${key}" field`, { nodeId: n.id });
          if (field && field.type !== 'duration' && field.type !== 'number') warn(`Wait "${label}" uses "${ref}", which is a ${field.type} field; make it a duration field`, { nodeId: n.id });
          if (field && !field.required) warn(`Wait "${label}" uses "${ref}", which is optional; the run fails if it's left empty`, { nodeId: n.id });
        }
        break;
      }
      case 'human': {
        const timeoutEdges = out.filter((e) => e.on === 'timeout');
        if (timeoutEdges.length && !n.timeout) err(`"${label}" has a timeout path but no timeout set`, { nodeId: n.id });
        if (n.timeout && !timeoutEdges.length) warn(`"${label}" has a timeout but no timeout path; the run will fail on timeout`, { nodeId: n.id });
        if (out.filter((e) => e.on !== 'timeout').length > 1) {
          for (const e of out) if (!e.on && !e.label?.trim()) err(`"${label}" has several outcomes; label each one`, { edgeId: e.id, nodeId: n.id });
        }
        if (!Object.keys(n.form).length) warn(`"${label}" has no form fields`, { nodeId: n.id });
        checkTemplates(n.prompt, n.id);
        break;
      }
    }
    for (const e of out) {
      if (e.on === 'timeout' && n.type !== 'human') err('Only human steps can have a timeout path', { edgeId: e.id, nodeId: n.id });
      if (e.when?.trim()) {
        if (n.type !== 'decision') warn(`Rules only apply to decision options (edge ${e.id})`, { edgeId: e.id, nodeId: n.id });
        try {
          for (const root of exprRoots(e.when)) {
            if (root !== 'inputs' && !saved.has(root)) warn(`Rule "${e.when}" uses "${root}", which no step saves`, { edgeId: e.id, nodeId: n.id });
          }
        } catch (x) {
          err(`Rule "${e.when}" is invalid: ${(x as Error).message}`, { edgeId: e.id, nodeId: n.id });
        }
      }
    }
    if (n.type === 'decision' && out.some((e) => e.when?.trim()) && out.filter((e) => !e.when?.trim()).length > 1) {
      warn(`Decision "${label}" has rules but more than one option without a rule; only the first is used as the fallback`, { nodeId: n.id });
    }
  }

  function checkTool(name: string, nodeId: string) {
    if (!TOOLS_BY_NAME[name]) err(`Unknown tool "${name}"`, { nodeId });
    else if (!declaredTools.has(name)) err(`Tool "${name}" is not in the workflow's tool list`, { nodeId });
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues, definition: def };
}

/** Validate run inputs against the definition's input schema. Returns error strings. */
export function validateFields(fields: FieldMap, values: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [name, f] of Object.entries(fields)) {
    const v = values[name];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (f.required) errors.push(`"${name}" is required`);
      continue;
    }
    if (f.type === 'number' && typeof v !== 'number') errors.push(`"${name}" must be a number`);
    if (f.type === 'boolean' && typeof v !== 'boolean') errors.push(`"${name}" must be true or false`);
    if ((f.type === 'string' || f.type === 'text') && typeof v !== 'string') errors.push(`"${name}" must be text`);
    if (f.type === 'duration' && !(typeof v === 'string' && DURATION_RE.test(v))) errors.push(`"${name}" must be a duration like 30s, 10m, 2h or 1d`);
  }
  return errors;
}
