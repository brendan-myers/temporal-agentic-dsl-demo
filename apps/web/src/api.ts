import type { HumanInputUpdate, InboxItem, Issue, RunState, RunSummary, SavedFlow, SavedFlowSummary, WorkflowDefinition } from '@demo/dsl';

export type { InboxItem, RunSummary, SavedFlow, SavedFlowSummary };

export interface ServerConfig {
  claudeAvailable: boolean;
  model: string;
  temporalUi: string;
  namespace: string;
}

export interface RunDetail {
  runId: string;
  temporalStatus: string;
  state: RunState;
  definition: WorkflowDefinition;
  inputs: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public issues: Issue[] = [],
  ) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? json.message ?? `Request failed (${res.status})`, json.issues);
  return json as T;
}

export const api = {
  config: () => request<ServerConfig>('/api/config'),
  startRun: (definition: WorkflowDefinition, inputs: Record<string, unknown>) => request<{ runId: string }>('/api/runs', { definition, inputs }),
  startSavedRun: (flowId: string, inputs: Record<string, unknown>) => request<{ runId: string }>('/api/runs', { flowId, inputs }),
  listRuns: (flowId?: string) => request<{ runs: RunSummary[] }>(`/api/runs${flowId ? `?flowId=${encodeURIComponent(flowId)}&limit=10` : ''}`),
  inbox: () => request<{ items: InboxItem[] }>('/api/inbox'),
  listFlows: () => request<{ flows: SavedFlowSummary[] }>('/api/flows'),
  getFlow: (id: string) => request<SavedFlow>(`/api/flows/${encodeURIComponent(id)}`),
  saveFlow: (definition: WorkflowDefinition) =>
    request<{ flow: SavedFlow; changed: boolean }>(`/api/flows/${encodeURIComponent(definition.id)}`, { definition }, 'PUT'),
  deleteFlow: (id: string) => request<{ deleted: true }>(`/api/flows/${encodeURIComponent(id)}`, undefined, 'DELETE'),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  submitHuman: (id: string, update: HumanInputUpdate) => request<{ accepted: true }>(`/api/runs/${encodeURIComponent(id)}/human-input`, update),
};
