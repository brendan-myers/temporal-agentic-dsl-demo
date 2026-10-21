import agentTools from '../../../apps/worker/agent/agent-tools.json';
import { TOOL_CATALOG, toolInputSchema } from './tools';
import type { WorkflowDefinition } from './types';

/**
 * The agent's tools and first message, for the builder's preview. The worker
 * owns the agent's context (apps/worker/agent/): system-prompt.md (the builder
 * imports it directly), agent-tools.json and tool-catalog.json.
 */

/** Tool definition in the shape the Claude Messages API accepts. */
export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The generic tools the workflow handles itself. */
export const AGENT_TOOL_DEFS = agentTools as unknown as LlmToolDef[];

/** The agent's tools: the generic ones plus every tool in the catalog. */
export function buildAgentTools(): LlmToolDef[] {
  return [...AGENT_TOOL_DEFS, ...TOOL_CATALOG.map((t) => ({ name: t.name, description: t.description, input_schema: toolInputSchema(t) }))];
}

/** First message: the workflow JSON and run inputs, verbatim (mirrors first_message in apps/worker/agent/context.py). */
export function compileFirstMessage(def: WorkflowDefinition, inputs: Record<string, unknown>): string {
  return `Workflow definition:\n\n\`\`\`json\n${JSON.stringify(def, null, 2)}\n\`\`\`\n\nRun inputs:\n\n\`\`\`json\n${JSON.stringify(inputs, null, 2)}\n\`\`\`\n\nExecute the workflow now.`;
}
