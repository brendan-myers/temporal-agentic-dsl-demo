// The worker owns the tool catalog (it runs the tools); the builder lists them.
import catalog from '../../../apps/worker/agent/tool-catalog.json';

/**
 * Catalog of the (mock) domain tools the agent can call. The builder lists
 * these and the worker implements them.
 */
export interface ToolParam {
  type: 'string' | 'number' | 'boolean';
  description: string;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  category: 'CRM' | 'Commerce' | 'Comms' | 'Ops' | 'Knowledge';
  /** True when the tool changes something in the outside world. */
  sideEffect: boolean;
  params: Record<string, ToolParam>;
  required: string[];
}

export const TOOL_CATALOG = catalog as unknown as ToolSpec[];

export const TOOLS_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(
  TOOL_CATALOG.map((t) => [t.name, t]),
);

/** JSON Schema for a tool's input, in the shape the Claude API expects. */
export function toolInputSchema(spec: ToolSpec) {
  return {
    type: 'object' as const,
    properties: spec.params,
    required: spec.required,
    additionalProperties: false,
  };
}
