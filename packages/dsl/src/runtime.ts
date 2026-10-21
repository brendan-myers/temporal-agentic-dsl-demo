import type { FieldMap, WorkflowDefinition } from './types';

/** Shared contract between the worker, the API server and the web app. */

export const WORKFLOW_TYPE = 'agentWorkflow';
export const QUERY_STATE = 'getState';
export const UPDATE_HUMAN_INPUT = 'submitHumanInput';

export interface LlmConfig {
  model: string;
  effort?: 'low' | 'medium' | 'high';
}

export interface AgentWorkflowInput {
  definition: WorkflowDefinition;
  inputs: Record<string, unknown>;
  llm: LlmConfig;
  /** Max LLM turns before the run fails (runaway guard). */
  maxTurns?: number;
}

export type RunStatus = 'running' | 'waiting_human' | 'waiting_timer' | 'completed' | 'failed';

export interface HumanRequest {
  nodeId: string;
  /** The step's prompt with templates filled in. */
  prompt: string;
  /** The agent's own context for the person. */
  message: string;
  form: FieldMap;
  assignee?: string;
  requestedAt: number;
  timeoutAt?: number;
}

export type RunEvent =
  | { ts: number; kind: 'thought'; text: string }
  | { ts: number; kind: 'enter'; nodeId: string; reason: string }
  | { ts: number; kind: 'tool_call'; id: string; tool: string; input: unknown; nodeId: string | null }
  | { ts: number; kind: 'tool_result'; id: string; tool: string; output: unknown; isError: boolean }
  | { ts: number; kind: 'rejected'; tool: string; message: string }
  | { ts: number; kind: 'human_request'; nodeId: string; message: string }
  | { ts: number; kind: 'human_response'; nodeId: string; values: Record<string, unknown> | null; timedOut: boolean }
  | { ts: number; kind: 'wait'; nodeId: string; duration: string }
  | { ts: number; kind: 'variable'; name: string; value: unknown }
  | { ts: number; kind: 'nudge'; text: string }
  | { ts: number; kind: 'finish'; output: unknown }
  | { ts: number; kind: 'error'; message: string };

export interface PathStep {
  nodeId: string;
  edgeId: string | null;
  enteredAt: number;
}

export interface RunState {
  status: RunStatus;
  definitionId: string;
  definitionName: string;
  llm: LlmConfig;
  currentNode: string | null;
  path: PathStep[];
  variables: Record<string, unknown>;
  pendingHuman: HumanRequest | null;
  /** Set while a wait step's timer is running. */
  timer: { nodeId: string; duration: string; endsAt: number } | null;
  events: RunEvent[];
  output: unknown;
  error: string | null;
  turns: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface HumanInputUpdate {
  nodeId: string;
  values: Record<string, unknown>;
}

/** A flow saved from the builder, as the API returns it. */
export interface SavedFlow {
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
  /** Whether the definition passes validation (only valid flows can run). */
  valid: boolean;
  errorCount: number;
}

export type SavedFlowSummary = Omit<SavedFlow, 'definition'> & {
  id: string;
  name: string;
  description: string;
  version: number;
  inputs: FieldMap;
};

/** A run that is waiting for a person, for the approvals inbox. */
export interface InboxItem {
  runId: string;
  flowId: string;
  flowName: string;
  nodeLabel: string;
  request: HumanRequest;
}

/** A run in a listing, with live state for runs that are still open. */
export interface RunSummary {
  runId: string;
  flowId?: string;
  name: string;
  model?: string;
  status: string;
  /** Workflow-level status for open runs (e.g. waiting_human). */
  runStatus?: RunStatus;
  currentNode?: string | null;
  startTime: string;
  closeTime?: string;
}
