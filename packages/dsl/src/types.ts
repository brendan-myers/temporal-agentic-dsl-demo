import { z } from 'zod';

/** Durations like "30s", "15m", "24h", "2d" (also accepted by Temporal's sleep/condition). */
export const DURATION_RE = /^\d+(s|m|h|d)$/;

/** A whole value taken from the run's data, e.g. "{{ack.settle_for}}". */
export const SINGLE_TEMPLATE_RE = /^\{\{\s*([\w.]+)\s*\}\}$/;

/** A "duration" field holds a value like "30m" and is validated as one. */
export const FieldTypeSchema = z.enum(['string', 'text', 'number', 'boolean', 'duration']);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldDefSchema = z.object({
  type: FieldTypeSchema,
  required: z.boolean().optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type FieldDef = z.infer<typeof FieldDefSchema>;

/** A flat field map used for run inputs, human forms and end outputs. */
export const FieldMapSchema = z.record(z.string(), FieldDefSchema);
export type FieldMap = z.infer<typeof FieldMapSchema>;

/** Canvas position. Ignored by the runtime. */
const UiSchema = z.object({ x: z.number(), y: z.number() }).optional();

const base = {
  id: z.string().min(1),
  label: z.string().optional(),
  /** Max times the agent may enter this node in one run (loop guard). Default 5. */
  maxVisits: z.number().int().positive().optional(),
  ui: UiSchema,
};

export const StartNodeSchema = z.object({ ...base, type: z.literal('start') });

export const AgentNodeSchema = z.object({
  ...base,
  type: z.literal('agent'),
  instructions: z.string(),
  tools: z.array(z.string()).default([]),
  /** Variable name to store this step's result under (agent calls set_variable). */
  saveAs: z.string().optional(),
});

export const ToolNodeSchema = z.object({
  ...base,
  type: z.literal('tool'),
  tool: z.string(),
  /** Templated args ("{{inputs.order_id}}") or "agent" to let the agent fill them. */
  args: z.union([z.record(z.string(), z.string()), z.literal('agent')]).default('agent'),
  instructions: z.string().optional(),
  /** Variable name the tool result is stored under automatically. */
  saveAs: z.string().optional(),
});

export const DecisionNodeSchema = z.object({
  ...base,
  type: z.literal('decision'),
  instructions: z.string(),
});

export const HumanNodeSchema = z.object({
  ...base,
  type: z.literal('human'),
  prompt: z.string(),
  form: FieldMapSchema.default({}),
  assignee: z.string().optional(),
  timeout: z.string().regex(DURATION_RE, 'Use a duration like 30m, 24h, 2d').optional(),
  saveAs: z.string().optional(),
});

export const WaitNodeSchema = z.object({
  ...base,
  type: z.literal('wait'),
  /** A fixed duration ("10m") or a reference to one ("{{ack.settle_for}}", "{{inputs.delay}}"). */
  duration: z
    .string()
    .refine((d) => DURATION_RE.test(d) || SINGLE_TEMPLATE_RE.test(d), 'Use a duration like 30s, 10m, 1h, or a reference like {{ack.wait_for}}'),
});

export const EndNodeSchema = z.object({
  ...base,
  type: z.literal('end'),
  instructions: z.string().optional(),
  output: FieldMapSchema.default({}),
});

export const NodeSchema = z.discriminatedUnion('type', [
  StartNodeSchema,
  AgentNodeSchema,
  ToolNodeSchema,
  DecisionNodeSchema,
  HumanNodeSchema,
  WaitNodeSchema,
  EndNodeSchema,
]);

export const EdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string(),
  to: z.string(),
  /** For decision/human nodes: the option the agent picks. */
  label: z.string().optional(),
  /** Special edge taken only when a human node times out. */
  on: z.literal('timeout').optional(),
  /**
   * Decision options only: a rule such as `order.amount > 100`. The runtime
   * evaluates rules in edge order and requires the first match; an option
   * without a rule is the fallback.
   */
  when: z.string().optional(),
});

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().default(1),
  name: z.string().min(1),
  description: z.string().default(''),
  inputs: FieldMapSchema.default({}),
  /** Tools from the catalog this workflow may use. */
  tools: z.array(z.string()).default([]),
  start: z.string(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

export type StartNode = z.infer<typeof StartNodeSchema>;
export type AgentNode = z.infer<typeof AgentNodeSchema>;
export type ToolNode = z.infer<typeof ToolNodeSchema>;
export type DecisionNode = z.infer<typeof DecisionNodeSchema>;
export type HumanNode = z.infer<typeof HumanNodeSchema>;
export type WaitNode = z.infer<typeof WaitNodeSchema>;
export type EndNode = z.infer<typeof EndNodeSchema>;
export type WorkflowNode = z.infer<typeof NodeSchema>;
export type NodeType = WorkflowNode['type'];
export type WorkflowEdge = z.infer<typeof EdgeSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const NODE_TYPES: NodeType[] = ['start', 'agent', 'tool', 'decision', 'human', 'wait', 'end'];
